/*
 * Spans (CONFIG_ZPROF_SPANS): ZPROF_SPAN_BEGIN/END in the application and, with
 * CONFIG_ZPROF_LVGL, LVGL's profiler points.
 *
 * A begin pushes the name and the time on its thread's stack; the end pops it and
 * writes one SPAN record (at the end's time: the ring stays in time order) if the
 * span lasted at least the shortest the host asked for and is no deeper than it
 * asked. Short spans are most of them (LVGL blends every glyph of a label): left
 * out on the target, they cost two calls and no ring space.
 *
 * Each thread that makes spans gets a slot of its own (CONFIG_ZPROF_SPAN_THREADS),
 * claimed under the interrupt lock at its first span after the host turned spans
 * on; after that only its own thread touches it, so a begin or an end takes no
 * lock (a few dozen cycles, measured at every switch-on and sent in HT_SPANS). A
 * thread without a slot makes no spans; spans in interrupts are ignored. A begin
 * and its end are matched by the name's address; an end whose begin came before
 * the spans were on finds no begin and is dropped, and one that finds its begin a
 * few levels down (an end the code skipped) closes the levels above it.
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

#define DEPTH 24
#define SLOTS CONFIG_ZPROF_SPAN_THREADS
#define LOOK  4 /* levels searched down for an end's begin */

struct span_slot {
	struct k_thread *volatile th;
	volatile uint32_t gen;      /* the switch-on it belongs to */
	uint32_t depth;             /* levels open (may exceed DEPTH: those are not kept) */
	const char *name[DEPTH];
	uint32_t t0[DEPTH];
};

volatile uint32_t zprof_span_on;
static struct span_slot slots[SLOTS];
static volatile uint32_t gen;
static uint32_t min_ticks, min_ns;
static uint32_t max_depth = DEPTH - 1u;
static uint32_t pair_ticks;          /* a begin and an end, not kept: the fastest measured */
static volatile bool calibrating;    /* the measurement's own spans write nothing */

ZPROF_METRIC_DEFINE(m_kept, "zprof.spans", COUNTER, "spans");
ZPROF_METRIC_DEFINE(m_left, "zprof.spans_left_out", COUNTER, "spans");

static ALWAYS_INLINE uint32_t now(void)
{
#ifdef CONFIG_ZPROF_TS_DWT
	return DWT->CYCCNT;
#else
	return k_cycle_get_32();
#endif
}

/* A slot for a thread that has none this switch-on; NULL if none is free. */
static __noinline struct span_slot *claim(struct k_thread *me)
{
	struct span_slot *got = NULL;
	unsigned int key = arch_irq_lock();
	uint32_t g = gen;

	for (int i = 0; i < SLOTS && got == NULL; i++) {
		if (slots[i].th == NULL || slots[i].gen != g) {
			got = &slots[i];
			got->th = me;
			got->depth = 0u;
			got->gen = g;
		}
	}
	arch_irq_unlock(key);
	return got;
}

/* The calling thread's slot. Only it uses the slot once claimed: no lock. */
static ALWAYS_INLINE struct span_slot *mine(void)
{
	struct k_thread *me = _current;
	uint32_t g = gen;

	for (int i = 0; i < SLOTS; i++) {
		struct span_slot *s = &slots[i];

		if (s->th == me) {
			if (s->gen != g) {   /* switched on again since: an empty stack */
				s->depth = 0u;
				s->gen = g;
			}
			return s;
		}
	}
	return claim(me);
}

ZPROF_HOT void zprof_span_begin(const char *name)
{
	if (__get_IPSR() != 0u || !zprof_span_on) {
		return;
	}
	uint32_t t = now();
	struct span_slot *s = mine();

	if (s != NULL) {
		uint32_t d = s->depth++;

		if (d < DEPTH) {
			s->name[d] = name;
			s->t0[d] = t;
		}
	}
}

ZPROF_HOT void zprof_span_end(const char *name)
{
	if (__get_IPSR() != 0u || !zprof_span_on) {
		return;
	}
	uint32_t t = now();
	struct span_slot *s = mine();

	if (s == NULL || s->depth == 0u) {
		return;   /* its begin came before the spans were on */
	}
	uint32_t d = s->depth - 1u;

	if (d < DEPTH && s->name[d] != name) {
		uint32_t k = d;
		bool found = false;

		while (k > 0u && d - k < LOOK) {
			k--;
			if (s->name[k] == name) {
				found = true;
				break;
			}
		}
		if (!found) {
			return;   /* not open in this thread: its begin was before the spans */
		}
		d = k;        /* the ends missing above it close too, unrecorded */
	}
	s->depth = d;
	if (d >= DEPTH || calibrating) {
		return;
	}
	uint32_t dur = t - s->t0[d];

	if (d <= max_depth && dur >= min_ticks) {
		zprof_put(ZPROF_EV_SPAN, (uint16_t)d, 2, (uint32_t)(uintptr_t)name, dur, 0, 0);
		ZPROF_ADD(m_kept, 1);
	} else {
		ZPROF_ADD(m_left, 1);
	}
}

/* What a begin and an end cost when the span is left out: the fastest of 8 runs of
 * 16 pairs on the calling thread, whose slot is given back after. */
static uint32_t calibrate(void)
{
	static const char cal[] = "zprof.calibrate";
	uint32_t best = UINT32_MAX;

	calibrating = true;
	for (int run = 0; run < 8; run++) {
		uint32_t t0 = now();

		for (int i = 0; i < 16; i++) {
			zprof_span_begin(cal);
			zprof_span_end(cal);
		}
		uint32_t dt = (now() - t0) / 16u;

		best = dt < best ? dt : best;
	}
	calibrating = false;

	struct k_thread *me = _current;

	for (int i = 0; i < SLOTS; i++) {
		if (slots[i].th == me) {
			slots[i].th = NULL;
		}
	}
	return best;
}

void zprof_spans_set(bool on, uint32_t shortest_ns, uint32_t deepest)
{
	uint32_t ticks = (uint32_t)((uint64_t)shortest_ns * zprof_ts_hz() / 1000000000u);
	unsigned int key = arch_irq_lock();

	gen++;   /* every thread's stack starts empty again */
	min_ns = shortest_ns;
	min_ticks = ticks;
	max_depth = deepest < DEPTH ? deepest : DEPTH - 1u;
	zprof_span_on = on ? 1u : 0u;
	arch_irq_unlock(key);
	if (on) {
		pair_ticks = calibrate();
	}
}

void zprof_spans_get(uint32_t v[4])
{
	v[0] = zprof_span_on;
	v[1] = min_ns;
	v[2] = max_depth;
	v[3] = pair_ticks;
}
