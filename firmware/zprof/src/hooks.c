/*
 * zprof's tracing hooks and its event ring.
 *
 * Every hook stamps a record and writes it into the ring under arch_irq_lock()
 * (BASEPRI on Cortex-M): reading the timestamp inside the lock keeps the ring
 * in time order. Hooks never wake a thread or take a kernel lock (a
 * k_sem_give would itself be traced, and the scheduler hooks run with the
 * scheduler's spinlock held); the sender polls. With no session running the
 * hooks return after one load.
 *
 * The ring drops when full and says so: the next record that fits is preceded
 * by an OVERFLOW record (the count, the 64-bit kernel cycle count, the running
 * thread), for which room is always kept.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/kernel_structs.h>
#include <zephyr/debug/cpu_load.h>
#include <zephyr/init.h>
#include <zephyr/linker/section_tags.h>
#include <cmsis_core.h>

#include <zprof/hooks.h>
#include <zprof/proto.h>

#include "zprof_internal.h"

#ifdef CONFIG_ZPROF_HOOKS_IN_RAM
#define ZPROF_HOT __ramfunc
#else
#define ZPROF_HOT
#endif

#define MASK           (ZPROF_RING_WORDS - 1u)
#define OVERFLOW_WORDS ZPROF_REC_WORDS(4)

BUILD_ASSERT((ZPROF_RING_WORDS & MASK) == 0, "CONFIG_ZPROF_RING_SIZE must be a power of two");
BUILD_ASSERT(!IS_ENABLED(CONFIG_ZERO_LATENCY_IRQS),
	     "zero-latency interrupts would run past the ring's lock");

struct zprof_ring zprof_ring;

static ALWAYS_INLINE uint32_t ts_now(void)
{
#ifdef CONFIG_ZPROF_TS_DWT
	return DWT->CYCCNT;
#else
	return k_cycle_get_32();
#endif
}

/* The interrupt as the ISR records name it: IRQ number, or 0x8000 | exception. */
static ALWAYS_INLINE uint16_t isr_id(void)
{
	uint32_t ipsr = __get_IPSR();

	return ipsr >= 16u ? (uint16_t)(ipsr - 16u) : (uint16_t)(ZPROF_ISR_EXC | ipsr);
}

static ALWAYS_INLINE void wr(uint32_t *h, uint32_t v)
{
	zprof_ring.w[*h & MASK] = v;
	(*h)++;
}

/* Lock held. */
static ZPROF_HOT void put_locked(uint32_t ts, uint8_t id, uint16_t arg, uint32_t nw, uint32_t a0,
				 uint32_t a1, uint32_t a2, uint32_t a3)
{
	struct zprof_ring *r = &zprof_ring;
	uint32_t h = r->head;
	uint32_t free = ZPROF_RING_WORDS - (h - r->tail);
	uint32_t need = ZPROF_REC_WORDS(nw) + OVERFLOW_WORDS; /* keep room for an OVERFLOW */

	if (r->dropped != 0u) {
		need += OVERFLOW_WORDS;
	}
	if (free < need) {
		r->dropped++;
		r->dropped_all++;
		return;
	}
	if (r->dropped != 0u) {
		uint64_t kc = k_cycle_get_64();

		wr(&h, ts);
		wr(&h, ZPROF_REC_HDR(ZPROF_EV_OVERFLOW, 4, __get_IPSR()));
		wr(&h, r->dropped);
		wr(&h, (uint32_t)kc);
		wr(&h, (uint32_t)(kc >> 32));
		wr(&h, (uint32_t)(uintptr_t)_current);
		r->dropped = 0u;
	}
	wr(&h, ts);
	wr(&h, ZPROF_REC_HDR(id, nw, arg));
	if (nw > 0u) {
		wr(&h, a0);
	}
	if (nw > 1u) {
		wr(&h, a1);
	}
	if (nw > 2u) {
		wr(&h, a2);
	}
	if (nw > 3u) {
		wr(&h, a3);
	}
	compiler_barrier(); /* the record is in the ring before head says so */
	r->head = h;
}

ZPROF_HOT __noinline void zprof_put(uint8_t id, uint16_t arg, uint32_t nw, uint32_t a0, uint32_t a1,
				    uint32_t a2, uint32_t a3)
{
	if (!zprof_ring.on) {
		return;
	}
	unsigned int key = arch_irq_lock();

	if (zprof_ring.on) {
		put_locked(ts_now(), id, arg, nw, a0, a1, a2, a3);
	}
	arch_irq_unlock(key);
}

void zprof_sync(void)
{
	unsigned int key = arch_irq_lock();
	uint64_t kc = k_cycle_get_64();
	uint32_t ts = ts_now();

	if (zprof_ring.on) {
		put_locked(ts, ZPROF_EV_SYNC, 0, 3, (uint32_t)kc, (uint32_t)(kc >> 32),
			   k_uptime_get_32(), 0);
	}
	arch_irq_unlock(key);
}

void zprof_session(bool on)
{
	unsigned int key = arch_irq_lock();

	zprof_ring.on = false;
	if (on) {
		zprof_ring.head = 0u;
		zprof_ring.tail = 0u;
		zprof_ring.dropped = 0u;
		zprof_ring.dropped_all = 0u;
		zprof_ring.on = true;
	}
	arch_irq_unlock(key);
}

uint32_t zprof_calibrate(void)
{
	/* The cost of one hook as the kernel pays it (the call, the lock, the stamp,
	 * the record): the fastest of 8 runs of 32 READY hooks, so interrupts
	 * landing in a run do not count. The records go; the caller empties the
	 * ring after. */
	struct k_thread *self = k_current_get();
	uint32_t best = UINT32_MAX;

	for (int run = 0; run < 8; run++) {
		uint32_t t0 = ts_now();

		for (int i = 0; i < 32; i++) {
			zprof_hook_ready(self);
		}
		uint32_t dt = (ts_now() - t0) / 32u;

		best = dt < best ? dt : best;
	}
	return best;
}

uint32_t zprof_ts_hz(void)
{
	/* DWT CYCCNT and the kernel's cycle counter both count core clock cycles here */
	return sys_clock_hw_cycles_per_sec();
}

#define PUT0(id, arg)             zprof_put(id, arg, 0, 0, 0, 0, 0)
#define PUT1(id, arg, a0)         zprof_put(id, arg, 1, (uint32_t)(a0), 0, 0, 0)
#define PUT2(id, arg, a0, a1)     zprof_put(id, arg, 2, (uint32_t)(a0), (uint32_t)(a1), 0, 0)
#define PTR(p)                    ((uint32_t)(uintptr_t)(p))

ZPROF_HOT void zprof_hook_switched_in(void)
{
	struct k_thread *t = _current;

	PUT1(ZPROF_EV_SWITCH_IN, (uint16_t)t->base.prio, PTR(t));
}

ZPROF_HOT void zprof_hook_switched_out(void)
{
	struct k_thread *t = _current;

	PUT2(ZPROF_EV_SWITCH_OUT, t->base.thread_state, PTR(t), PTR(t->base.pended_on));
}

ZPROF_HOT void zprof_hook_ready(struct k_thread *thread)
{
	PUT1(ZPROF_EV_READY, 0, PTR(thread));
}

ZPROF_HOT void zprof_hook_pend(struct k_thread *thread)
{
	PUT1(ZPROF_EV_PEND, 0, PTR(thread));
}

void zprof_hook_prio(struct k_thread *thread, int prio)
{
	PUT1(ZPROF_EV_PRIO, (uint16_t)prio, PTR(thread));
}

void zprof_hook_create(struct k_thread *thread)
{
#ifdef CONFIG_THREAD_MONITOR
	PUT2(ZPROF_EV_CREATE, (uint16_t)thread->base.prio, PTR(thread), PTR(thread->entry.pEntry));
#else
	PUT2(ZPROF_EV_CREATE, (uint16_t)thread->base.prio, PTR(thread), 0);
#endif
}

void zprof_hook_abort(struct k_thread *thread)
{
	PUT1(ZPROF_EV_ABORT, 0, PTR(thread));
}

void zprof_hook_name(struct k_thread *thread)
{
	PUT1(ZPROF_EV_NAME, 0, PTR(thread));
}

ZPROF_HOT void sys_trace_isr_enter(void)
{
	PUT0(ZPROF_EV_ISR_ENTER, isr_id());
}

ZPROF_HOT void sys_trace_isr_exit(void)
{
	PUT0(ZPROF_EV_ISR_EXIT, isr_id());
}

/* Never called on Cortex-M; part of the custom format's contract. */
void sys_trace_isr_exit_to_scheduler(void)
{
}

ZPROF_HOT void sys_trace_idle(void)
{
	PUT0(ZPROF_EV_IDLE, 0);
	if (IS_ENABLED(CONFIG_CPU_LOAD)) {
		cpu_load_on_enter_idle();
	}
}

ZPROF_HOT void sys_trace_idle_exit(void)
{
	if (IS_ENABLED(CONFIG_CPU_LOAD)) {
		cpu_load_on_exit_idle();
	}
	PUT0(ZPROF_EV_IDLE_EXIT, 0);
}

static int zprof_init(void)
{
#ifdef CONFIG_ZPROF_TS_DWT
	/* enable, never reset: other code may time with CYCCNT too */
	DCB->DEMCR |= DCB_DEMCR_TRCENA_Msk;
	DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
#endif
	return 0;
}
SYS_INIT(zprof_init, PRE_KERNEL_1, 0);
