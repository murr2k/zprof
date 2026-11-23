/*
 * Fault capture. zprof_fault_capture() keeps the fault in a record (registers,
 * the faulting thread, a call trace of raw return addresses the host names from
 * the ELF), puts a FAULT record in the trace and freezes an armed flight recorder
 * at once; an application calls it from its own k_sys_fatal_error_handler and
 * keeps its own failure policy. Only with CONFIG_ZPROF_FAULT_HANDLER does zprof
 * supply the handler (Zephyr's is weak): it halts as Zephyr's own does, spinning
 * (not in WFI) so a probe can read the record, or with CONFIG_ZPROF_FAULT_CONTINUE
 * returns for a fault in a thread that is not essential (not an interrupt, not a
 * panic), so the kernel ends that thread and the rest runs on.
 *
 * Neither policy is safe for every system (a halted CPU can leave a power
 * stage's switch on; running on can leave a control loop dead): the choice is the
 * application's, and the safety net belongs in hardware (a watchdog, a timer's
 * break input).
 *
 * The record is in the DTCM's zeroed section where there is one: it outlives the
 * fault, not a reset (a DTCM with ECC must not be read before it was written, so
 * a no-init record would need its own cold-boot initialisation).
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/arch/arch_interface.h>
#include <zephyr/fatal.h>
#include <zephyr/linker/section_tags.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/crc.h>
#include <cmsis_core.h>

#include <zprof/proto.h>
#include <zprof/zprof.h>

#include "zprof_internal.h"

extern const uint8_t zprof_build_id[16];

#define ZPROF_FAULT_LOG 4

#ifdef CONFIG_ZPROF_RING_DTCM
struct zprof_fault zprof_fault __dtcm_bss_section;
#else
struct zprof_fault zprof_fault;
#endif
volatile bool zprof_fault_new;   /* captured, not yet handed to a client */

/* The last faults in brief, for alarms (zprof_faults, HT_FAULT_LOG). */
#ifdef CONFIG_ZPROF_RING_DTCM
static struct zprof_fault_info flog[ZPROF_FAULT_LOG] __dtcm_bss_section;
#else
static struct zprof_fault_info flog[ZPROF_FAULT_LOG];
#endif
static uint32_t flog_n;   /* since boot */

int zprof_faults(struct zprof_fault_info *out, int n)
{
	unsigned int key = arch_irq_lock();
	uint32_t total = flog_n;
	uint32_t k = total < ZPROF_FAULT_LOG ? total : ZPROF_FAULT_LOG;

	if ((uint32_t)n < k) {
		k = (uint32_t)n;
	}
	for (uint32_t i = 0; i < k; i++) {
		out[i] = flog[(total - 1u - i) % ZPROF_FAULT_LOG];
	}
	arch_irq_unlock(key);
	return (int)total;
}

const char *zprof_fault_reason(uint32_t reason)
{
	switch (reason) {
	case K_ERR_SPURIOUS_IRQ:
		return "spurious interrupt";
	case K_ERR_STACK_CHK_FAIL:
	case K_ERR_ARM_USAGE_STACK_OVERFLOW:
		return "stack overflow";
	case K_ERR_KERNEL_OOPS:
		return "oops";
	case K_ERR_KERNEL_PANIC:
		return "panic";
	case K_ERR_ARM_USAGE_DIV_0:
		return "divide by zero";
	case K_ERR_ARM_USAGE_UNALIGNED_ACCESS:
		return "unaligned access";
	case K_ERR_ARM_USAGE_UNDEFINED_INSTRUCTION:
		return "undefined instruction";
	default:
		break;
	}
	if (reason >= K_ERR_ARM_MEM_GENERIC && reason < K_ERR_ARM_BUS_GENERIC) {
		return "memory fault";
	}
	if (reason >= K_ERR_ARM_BUS_GENERIC && reason < K_ERR_ARM_USAGE_GENERIC) {
		return "bus fault";
	}
	if (reason >= K_ERR_ARM_USAGE_GENERIC && reason < K_ERR_ARM_SECURE_GENERIC) {
		return "usage fault";
	}
	if (reason >= K_ERR_ARM_SECURE_GENERIC && reason < K_ERR_ARM_UNDEFINED_INSTRUCTION) {
		return "secure fault";
	}
	return "CPU exception";
}

BUILD_ASSERT(sizeof(struct zprof_fault) == 48 * 4, "the host reads 48 words (HT_FAULT)");

#if defined(CONFIG_ARCH_STACKWALK) && defined(CONFIG_EXTRA_EXCEPTION_INFO)
static bool frame(void *cookie, unsigned long addr)
{
	struct zprof_fault *f = cookie;

	if (f->nframes >= ZPROF_FAULT_FRAMES) {
		return false;
	}
	f->frames[f->nframes++] = (uint32_t)addr;
	return true;
}

/* The unwinder starts from the thread's PSP; in an interrupt the frames are on
 * the MSP, so walk a copy with the MSP in its place. Only from a stack pointer
 * inside the stack it should be in: the unwinder reads without bounds. */
static void walk(struct zprof_fault *f, const struct arch_esf *esf, struct k_thread *t, bool isr)
{
	struct arch_esf e = *esf;
	_callee_saved_t callee = *esf->extra_info.callee;

	if (isr) {
		callee.psp = esf->extra_info.msp;
	} else {
		uintptr_t lo = t->stack_info.start, hi = lo + t->stack_info.size;

		if (callee.psp < lo || callee.psp >= hi) {
			f->flags |= ZPROF_FAULT_F_NOWALK;
			return;
		}
	}
	e.extra_info.callee = &callee;
	arch_stack_walk(frame, f, NULL, &e);
}
#endif

static void capture(unsigned int reason, const struct arch_esf *esf, uint32_t policy)
{
	struct zprof_fault *f = &zprof_fault;
	struct k_thread *t = k_current_get();
	bool isr = esf != NULL && (esf->basic.xpsr & IPSR_ISR_Msk) != 0u;
	bool essential = t != NULL && (t->base.user_options & K_ESSENTIAL) != 0u;

	memset(f, 0, sizeof(*f));
	f->magic = ZPROF_FAULT_MAGIC;
	f->words = sizeof(*f) / 4u;
	memcpy(f->build_id, zprof_build_id, sizeof(f->build_id));
	f->uptime_ms = k_uptime_get_32();
#ifdef CONFIG_ZPROF_TS_DWT
	f->ts = DWT->CYCCNT;
#else
	f->ts = k_cycle_get_32();
#endif
	f->reason = reason;
	f->thread = (uint32_t)(uintptr_t)t;
	f->flags = (isr ? ZPROF_FAULT_F_ISR : 0u) | (essential ? ZPROF_FAULT_F_ESSENTIAL : 0u) | policy;
	if (t != NULL) {
		const char *name = k_thread_name_get(t);

		if (name != NULL) {
			strncpy(f->name, name, sizeof(f->name) - 1u);
		}
	}
	if (esf != NULL) {
		memcpy(f->r, &esf->basic, sizeof(f->r));
#ifdef CONFIG_EXTRA_EXCEPTION_INFO
		if (esf->extra_info.callee != NULL) {
			memcpy(f->callee, esf->extra_info.callee, sizeof(f->callee));
		}
		f->msp = esf->extra_info.msp;
		f->exc_return = esf->extra_info.exc_return;
#endif
	}
	f->hfsr = SCB->HFSR;
	f->mmfar = SCB->MMFAR;
	f->bfar = SCB->BFAR;
#if defined(__ARM_FEATURE_CMSE) && (__ARM_FEATURE_CMSE == 3U)
	f->sfar = SAU->SFAR;   /* secure state: the SAU's fault address */
#endif
#if defined(CONFIG_ARCH_STACKWALK) && defined(CONFIG_EXTRA_EXCEPTION_INFO)
	if (esf != NULL && esf->extra_info.callee != NULL && t != NULL &&
	    reason != K_ERR_STACK_CHK_FAIL && reason != K_ERR_ARM_USAGE_STACK_OVERFLOW) {
		walk(f, esf, t, isr);
	} else {
		f->flags |= ZPROF_FAULT_F_NOWALK;
	}
#else
	f->flags |= ZPROF_FAULT_F_NOWALK;
#endif
	f->crc = crc32_ieee((const uint8_t *)f, offsetof(struct zprof_fault, crc));

	struct zprof_fault_info *e = &flog[flog_n % ZPROF_FAULT_LOG];

	e->uptime_ms = f->uptime_ms;
	e->reason = reason;
	memcpy(e->thread, f->name, sizeof(e->thread));
	flog_n++;

	zprof_put(ZPROF_EV_FAULT, (uint16_t)reason, 3, f->r[6], f->thread, f->flags, 0);
	zprof_recorder_fault();
	zprof_fault_new = true;
}

/* For an application's own k_sys_fatal_error_handler: keep the fault, then do what
 * the application decides (zprof never chooses the failure policy unless asked). */
void zprof_fault_capture(unsigned int reason, const struct arch_esf *esf)
{
	capture(reason, esf, 0u);
}

#ifdef CONFIG_ZPROF_FAULT_HANDLER
/* Would zprof's handler run on after this fault (CONFIG_ZPROF_FAULT_CONTINUE)? Only
 * in a thread that is neither essential nor in an interrupt, and not for a panic:
 * there returning lets the kernel end just that thread. */
static bool runs_on(unsigned int reason, const struct arch_esf *esf)
{
	struct k_thread *t = k_current_get();

	return IS_ENABLED(CONFIG_ZPROF_FAULT_CONTINUE) && esf != NULL && t != NULL &&
	       (esf->basic.xpsr & IPSR_ISR_Msk) == 0u && (t->base.user_options & K_ESSENTIAL) == 0u &&
	       reason != K_ERR_KERNEL_PANIC && reason != K_ERR_SPURIOUS_IRQ;
}

/* zprof's handler, when the build asks for it: halts as Zephyr's own does, or with
 * CONFIG_ZPROF_FAULT_CONTINUE ends only a faulting thread that is not essential. */
void k_sys_fatal_error_handler(unsigned int reason, const struct arch_esf *esf)
{
	bool go_on = runs_on(reason, esf);

	capture(reason, esf, go_on ? ZPROF_FAULT_F_RAN_ON : ZPROF_FAULT_F_HALTED);
	if (go_on) {
		/* the kernel ends the thread; the sender hands the record on. No
		 * LOG_PANIC: it would print the dump here, interrupts locked, at the
		 * UART's pace, and leave logging synchronous for good (19 frames
		 * dropped in three test faults on the N6); the log thread prints it. */
		return;
	}
	LOG_PANIC();   /* halting: nothing else will print the dump */
	(void)arch_irq_lock();
	for (;;) {
		/* halted, as Zephyr's own handler does: a probe can read zprof_fault */
	}
}
#endif
