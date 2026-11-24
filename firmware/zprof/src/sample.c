/*
 * PC sampling (CONFIG_ZPROF_SAMPLE): a timer of the port's interrupts at a rate
 * the host asks for (CT_SAMPLE); each interrupt records where the CPU was.
 *
 * The handler is entered straight from the vector table (the port connects
 * zprof_sample_irq with IRQ_DIRECT_CONNECT), so EXC_RETURN is still in LR and
 * says which stack holds the exception frame: the process stack for a thread,
 * the main stack for an interrupted handler. From the frame: the PC, the LR (the
 * caller, but only while the interrupted function is a leaf that has not saved
 * it) and the interrupted exception's number from the stacked xPSR. The thread
 * is the one that was running (in a handler too: the thread underneath).
 *
 * The interrupt runs at a priority irq_lock() masks, like every hook's writer:
 * samples can land in other interrupts and in the scheduler, but a sample due
 * inside a locked region is taken where the lock ends, and counts there. The
 * handler is not in the trace's interrupt records; its cost is measured here
 * (HT_SAMPLE) and the host prints it.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/linker/section_tags.h>
#include <cmsis_core.h>

#include <zprof/proto.h>
#include <zprof/zprof.h>

#include "zprof_internal.h"

#ifdef CONFIG_ZPROF_HOOKS_IN_RAM
#define ZPROF_HOT __ramfunc
#else
#define ZPROF_HOT
#endif

#define RET_DCRS         BIT(5) /* EXC_RETURN: 0 when the callee registers were stacked too (Armv8-M) */
#define ADDITIONAL_WORDS 10     /* then: integrity signature, reserved, r4-r11 before the frame */

static volatile uint32_t rate;
static uint64_t cost_sum;   /* the handler's runs since sampling started (ticks) */
static uint32_t cost_n;

ZPROF_METRIC_DEFINE(m_samples, "zprof.samples", COUNTER, "samples");

void zprof_sample_take(const uint32_t *frame, uint32_t exc_return);

/* r0: the frame, r1: EXC_RETURN, then the C part; it returns with EXC_RETURN in LR. */
ZPROF_HOT __attribute__((naked)) void zprof_sample_irq(void)
{
	__asm__ volatile("tst lr, #4\n\t"
			 "ite eq\n\t"
			 "mrseq r0, msp\n\t"
			 "mrsne r0, psp\n\t"
			 "mov r1, lr\n\t"
			 "b zprof_sample_take\n\t");
}

static ALWAYS_INLINE uint32_t now(void)
{
#ifdef CONFIG_ZPROF_TS_DWT
	return DWT->CYCCNT;
#else
	return k_cycle_get_32();
#endif
}

ZPROF_HOT void zprof_sample_take(const uint32_t *frame, uint32_t exc_return)
{
	uint32_t t0 = now();

	zprof_port_sample_ack();
	if (!(exc_return & RET_DCRS)) {
		frame += ADDITIONAL_WORDS;
	}
	uint32_t lr = frame[5], pc = frame[6], xpsr = frame[7];

	zprof_put(ZPROF_EV_SAMPLE, (uint16_t)(xpsr & 0x1FFu), 3, pc, lr, (uint32_t)(uintptr_t)_current, 0);
	ZPROF_ADD(m_samples, 1);

	cost_sum += now() - t0;
	cost_n++;
}

uint32_t zprof_sample_set(uint32_t hz)
{
	if (hz == 0u) {
		if (rate != 0u) {
			zprof_port_sample_stop();
		}
		rate = 0u;
		return 0u;
	}
	unsigned int key = arch_irq_lock();

	cost_sum = 0u;
	cost_n = 0u;
	arch_irq_unlock(key);

	int got = zprof_port_sample_start(hz);

	rate = got > 0 ? (uint32_t)got : 0u;
	return rate;
}

void zprof_sample_get(uint32_t v[3])
{
	unsigned int key = arch_irq_lock();

	v[0] = rate;       /* 0 after a start the port refused: it has no timer */
	v[1] = cost_n ? (uint32_t)(cost_sum / cost_n) : 0u;
	v[2] = 1u;
	arch_irq_unlock(key);
}

/* No sampling unless the port supplies a timer. */
__weak int zprof_port_sample_start(uint32_t hz)
{
	ARG_UNUSED(hz);
	return -ENOTSUP;
}

__weak void zprof_port_sample_stop(void)
{
}

__weak void zprof_port_sample_ack(void)
{
}
