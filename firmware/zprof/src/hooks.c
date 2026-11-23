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
#include <zprof/zprof.h>

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

#ifdef CONFIG_ZPROF_RING_DTCM
/* In the core's DTCM (the board's zephyr,dtcm): Zephyr zeroes .dtcm_bss at boot,
 * which also gives a TCM with ECC its first writes. */
struct zprof_ring zprof_ring __dtcm_bss_section;
#else
struct zprof_ring zprof_ring;
#endif

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

/* One word at h into the ring (mask MASK) or the capture buffer (mask ~0: no wrap). */
#define wr(h, v)                       \
	do {                           \
		w[*(h) & mask] = (v);  \
		(*(h))++;              \
	} while (0)

/* Lock held. */
static ZPROF_HOT void put_locked(uint32_t ts, uint8_t id, uint16_t arg, uint32_t nw, uint32_t a0,
				 uint32_t a1, uint32_t a2, uint32_t a3)
{
	struct zprof_ring *r = &zprof_ring;
	uint32_t *cap = r->cap;
	uint32_t *w = cap != NULL ? cap : r->w;
	uint32_t mask = cap != NULL ? UINT32_MAX : MASK;
	uint32_t h = cap != NULL ? r->cap_len : r->head;
	uint32_t free = cap != NULL ? r->cap_size - h : ZPROF_RING_WORDS - (h - r->tail);
	uint32_t need = ZPROF_REC_WORDS(nw) + OVERFLOW_WORDS; /* keep room for an OVERFLOW */

	if (r->dropped != 0u) {
		need += OVERFLOW_WORDS;
	}
	if (free < need && cap == NULL && r->overwrite) {
		/* the flight recorder, nobody draining: the oldest whole records go */
		while (free < need && r->tail != h) {
			uint32_t n = ZPROF_REC_WORDS(ZPROF_REC_NW(r->w[(r->tail + 1u) & MASK]));

			r->tail += n;
			free += n;
		}
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
	if (cap != NULL) {
		r->cap_len = h;
	} else {
		r->head = h;
	}
}

void zprof_capture_begin(uint32_t *buf, uint32_t words)
{
	unsigned int key = arch_irq_lock();

	zprof_ring.cap_len = 0u;
	zprof_ring.cap_size = words;
	zprof_ring.cap = buf;
	arch_irq_unlock(key);
}

uint32_t zprof_capture_end(void)
{
	unsigned int key = arch_irq_lock();
	uint32_t n = zprof_ring.cap_len;

	zprof_ring.cap = NULL;
	arch_irq_unlock(key);
	return n;
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

/* A call site counts for a switch-out this soon after its hook (timestamp ticks;
 * 200 us). A real block switches out within microseconds; a "_blocking" hook
 * whose call then did not block leaves an older one, which must not name the
 * thread's next, unhooked wait. */
static uint32_t site_window;

/* ---- the flight recorder ----------------------------------------------------- */

struct zprof_recorder zprof_rec;

static void rec_sync(struct k_timer *t);
static void rec_freeze(struct k_timer *t);
/* SYNC records while it records with no client (the session's sender writes them
 * otherwise): the host needs one inside whatever window the ring holds. */
static K_TIMER_DEFINE(rec_sync_timer, rec_sync, NULL);
static K_TIMER_DEFINE(rec_post_timer, rec_freeze, NULL);
#define REC_SYNC_MS 100

static void rec_sync(struct k_timer *t)
{
	ARG_UNUSED(t);
	zprof_sync();
}

/* The post time is over: stop the hooks, the ring holds the moments around the
 * trigger; a last SYNC first, so the host can place it whatever went before. */
static void rec_freeze(struct k_timer *t)
{
	ARG_UNUSED(t);
	if (zprof_rec.state != ZPROF_REC_TRIGGERED || !zprof_ring.overwrite) {
		return;
	}
	k_timer_stop(&rec_sync_timer);
	zprof_sync();

	unsigned int key = arch_irq_lock();

	zprof_ring.on = false;
	zprof_ring.overwrite = false;
	zprof_rec.state = ZPROF_REC_HELD;
	arch_irq_unlock(key);
}

void zprof_trigger(uint32_t why)
{
	unsigned int key = arch_irq_lock();
	bool start = false;

	if (zprof_ring.on) {
		put_locked(ts_now(), ZPROF_EV_TRIGGER, 0, 1, why, 0, 0, 0);
	}
	zprof_rec.triggers++;
	if (zprof_rec.state == ZPROF_REC_ARMED && zprof_ring.overwrite) {
		zprof_rec.state = ZPROF_REC_TRIGGERED;   /* the first one counts */
		start = true;
	}
	arch_irq_unlock(key);
	if (start) {
		k_timer_start(&rec_post_timer, K_MSEC(zprof_rec.post_ms), K_NO_WAIT);
	}
}

void zprof_recorder_set(uint32_t post_ms)
{
	if (post_ms == 0u) {
		k_timer_stop(&rec_post_timer);
		k_timer_stop(&rec_sync_timer);

		unsigned int key = arch_irq_lock();

		zprof_rec.state = ZPROF_REC_OFF;
		if (zprof_ring.overwrite) {
			zprof_ring.on = false;
			zprof_ring.overwrite = false;
		}
		arch_irq_unlock(key);
		return;
	}
	zprof_rec.post_ms = post_ms;
	if (zprof_rec.state == ZPROF_REC_OFF) {
		zprof_rec.state = ZPROF_REC_ARMED;
	}
}

void zprof_recorder_resume(void)
{
	if (zprof_rec.state != ZPROF_REC_ARMED) {
		return;   /* off, or a held recording waits for the next client */
	}
	unsigned int key = arch_irq_lock();

	zprof_ring.cap = NULL;
	zprof_ring.head = 0u;
	zprof_ring.tail = 0u;
	zprof_ring.dropped = 0u;
	zprof_ring.dropped_all = 0u;
	zprof_ring.overwrite = true;
	zprof_ring.on = true;
	arch_irq_unlock(key);
	zprof_sync();
	k_timer_start(&rec_sync_timer, K_MSEC(REC_SYNC_MS), K_MSEC(REC_SYNC_MS));
}

void zprof_recorder_taken(void)
{
	if (zprof_rec.state == ZPROF_REC_HELD) {
		zprof_rec.state = ZPROF_REC_ARMED;
	}
}

#if CONFIG_ZPROF_RECORDER_POST_MS > 0
static int rec_boot(void)
{
	zprof_recorder_set(CONFIG_ZPROF_RECORDER_POST_MS);
	zprof_recorder_resume();
	return 0;
}
SYS_INIT(rec_boot, APPLICATION, 99);
#endif

void zprof_session(bool on)
{
	k_timer_stop(&rec_sync_timer);   /* a session's sender writes the SYNC records */
	k_timer_stop(&rec_post_timer);

	unsigned int key = arch_irq_lock();

	site_window = zprof_ts_hz() / 5000u;
	zprof_ring.on = false;
	zprof_ring.overwrite = false;
	zprof_ring.cap = NULL;      /* a capture ends with its session */
	if (zprof_rec.state == ZPROF_REC_TRIGGERED ||
	    (on && zprof_rec.state == ZPROF_REC_HELD)) {
		/* a client came first: it streams the moment live (or the freeze came
		 * after the session looked for a held recording: the reset below loses it) */
		zprof_rec.state = ZPROF_REC_ARMED;
	}
	if (on) {
		uint64_t kc = k_cycle_get_64();

		zprof_ring.head = 0u;
		zprof_ring.tail = 0u;
		zprof_ring.dropped = 0u;
		zprof_ring.dropped_all = 0u;
		zprof_ring.on = true;
		/* first, so the host can place everything after it, whatever went before
		 * (a flight recording sent ahead of this stream, hours older) */
		put_locked(ts_now(), ZPROF_EV_SYNC, 0, 3, (uint32_t)kc, (uint32_t)(kc >> 32),
			   k_uptime_get_32(), 0);
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
#define PUT3(id, arg, a0, a1, a2) zprof_put(id, arg, 3, (uint32_t)(a0), (uint32_t)(a1), (uint32_t)(a2), 0)
#define PTR(p)                    ((uint32_t)(uintptr_t)(p))

ZPROF_HOT void zprof_hook_switched_in(void)
{
	struct k_thread *t = _current;

	PUT1(ZPROF_EV_SWITCH_IN, (uint16_t)t->base.prio, PTR(t));
}

/* the host reads these bits from SWITCH_OUT (proto.h) */
BUILD_ASSERT(ZPROF_THS_PENDING == _THREAD_PENDING && ZPROF_THS_SLEEPING == _THREAD_SLEEPING &&
	     ZPROF_THS_SUSPENDED == _THREAD_SUSPENDED && ZPROF_THS_QUEUED == _THREAD_QUEUED,
	     "Zephyr's thread state bits moved: update ZPROF_THS_* in proto.h");

/* The call site of the last blocking call (zprof_site), and its thread. A thread
 * that blocks switches out right after its blocking hook; another thread's
 * blocking call in between (it preempted this one) takes the slot, and this
 * switch-out goes without a site. */
static void *site_pc;
static struct k_thread *site_th;
static uint32_t site_ts;

ZPROF_HOT void zprof_site(void *pc)
{
	site_pc = pc;
	site_th = _current;
	site_ts = ts_now();
}

ZPROF_HOT void zprof_hook_switched_out(void)
{
	struct k_thread *t = _current;
	uint32_t st = t->base.thread_state;

	if (site_th == t && (st & (_THREAD_PENDING | _THREAD_SLEEPING | _THREAD_SUSPENDED)) &&
	    !(st & _THREAD_QUEUED) && ts_now() - site_ts < site_window) {
		site_th = NULL;
		PUT3(ZPROF_EV_SWITCH_OUT, st, PTR(t), PTR(t->base.pended_on), PTR(site_pc));
		return;
	}
	PUT2(ZPROF_EV_SWITCH_OUT, st, PTR(t), PTR(t->base.pended_on));
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

/* Kernel-object classes recorded (bit = id - ZPROF_OBJ_FIRST); all by default. */
volatile uint32_t zprof_classes = BIT_MASK(ZPROF_OBJ_LAST - ZPROF_OBJ_FIRST + 1);
/* The sender: its own kernel-object calls (the network stack's, under its
 * sends) are left out, or zprof would trace its own traffic. */
struct k_thread *volatile zprof_self;

ZPROF_HOT void zprof_obj(uint8_t id, uint16_t arg, const void *obj, uint32_t val)
{
	if (!zprof_ring.on || !(zprof_classes & BIT(id - ZPROF_OBJ_FIRST))) {
		return;
	}
	if (_current == zprof_self && !k_is_in_isr()) {
		return;
	}
	PUT2(id, arg, PTR(obj), val);
}

/* Application marks, plots and prints (zprof.h): recorded with every capture preset. */
ZPROF_HOT void zprof_mark(uint8_t id, const char *name, uint32_t value)
{
	PUT2(id, 0, PTR(name), value);
}

void zprof_plot(const char *name, int32_t value)
{
	PUT2(ZPROF_EV_PLOT, 0, PTR(name), (uint32_t)value);
}

void zprof_print(const char *fmt, uint32_t a0, uint32_t a1, uint32_t a2)
{
	zprof_put(ZPROF_EV_PRINT, 0, 4, PTR(fmt), a0, a1, a2);
}

uint32_t zprof_now(void)
{
	return ts_now();
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
