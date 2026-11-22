/*
 * The heartbeat: every CONFIG_ZPROF_HEARTBEAT_MS the sender latches every metric
 * (the application's, from its ZPROF_METRIC_DEFINEs, and the built-ins below)
 * into METRIC records, counters and timers reset as they are read; every
 * CONFIG_ZPROF_STACK_DIVIDER-th one adds each thread's stack watermark. The
 * records go through the ring like the trace, on its clock.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/sys/iterable_sections.h>

#include <zprof/proto.h>
#include <zprof/zprof.h>

#include "zprof_internal.h"

/* Built-ins. */
#ifdef CONFIG_SCHED_THREAD_USAGE_ALL
ZPROF_METRIC_DEFINE(zprof_m_cpu, "cpu.load", GAUGE, "permille");
#endif
ZPROF_METRIC_DEFINE(zprof_m_dropped, "zprof.dropped", COUNTER, "records");
ZPROF_METRIC_DEFINE(zprof_m_ring, "zprof.ring_peak", GAUGE, "%");

__weak void *zprof_port_alloc(size_t bytes)
{
	ARG_UNUSED(bytes);
	return NULL;
}

__weak void zprof_port_heartbeat(void)
{
}

/* The ring's fullest since the last heartbeat (words); the sender updates it. */
uint32_t zprof_ring_peak;
static uint32_t dropped_seen;

#ifdef CONFIG_SCHED_THREAD_USAGE_ALL
static uint64_t last_total, last_idle;

/* Busy share of the CPU since the last heartbeat: the kernel's own cycle counts
 * (execution_cycles: every cycle, the idle thread's included). */
static void cpu_load(void)
{
	k_thread_runtime_stats_t st;

	if (k_thread_runtime_stats_all_get(&st) != 0) {
		return;
	}
	uint64_t total = st.execution_cycles;
	uint64_t dt = total - last_total, di = st.idle_cycles - last_idle;

	last_total = total;
	last_idle = st.idle_cycles;
	if (dt > 0) {
		ZPROF_SET(zprof_m_cpu, (uint32_t)(1000u - (uint32_t)(di * 1000u / dt)));
	}
}
#endif

static void stack_entry(const struct k_thread *t, void *user)
{
	ARG_UNUSED(user);
#ifdef CONFIG_INIT_STACKS
	size_t unused;

	if (k_thread_stack_space_get(t, &unused) == 0) {
		zprof_put(ZPROF_EV_STACK, 0, 3, (uint32_t)(uintptr_t)t, (uint32_t)unused,
			  (uint32_t)t->stack_info.size, 0);
	}
#else
	ARG_UNUSED(t);
#endif
}

void zprof_heartbeat(uint32_t n)
{
#ifdef CONFIG_SCHED_THREAD_USAGE_ALL
	cpu_load();
#endif
	uint32_t d = zprof_ring.dropped_all;

	ZPROF_SET(zprof_m_dropped, d - dropped_seen);
	dropped_seen = d;
	ZPROF_SET(zprof_m_ring, zprof_ring_peak * 100u / ZPROF_RING_WORDS);
	zprof_ring_peak = 0;
	zprof_port_heartbeat();

	uint16_t i = 0;

	STRUCT_SECTION_FOREACH(zprof_metric, m) {
		uint32_t v = m->kind == ZPROF_KIND_GAUGE ? (uint32_t)atomic_get(&m->value)
							 : (uint32_t)atomic_set(&m->value, 0);

		zprof_put(ZPROF_EV_METRIC, i++, 1, v, 0, 0, 0);
	}
	if (CONFIG_ZPROF_STACK_DIVIDER > 0 && n % CONFIG_ZPROF_STACK_DIVIDER == 0) {
		k_thread_foreach_unlocked(stack_entry, NULL);
	}
}

void zprof_metric_dict(void (*fn)(uint16_t index, const struct zprof_metric *m, void *user), void *user)
{
	uint16_t i = 0;

	STRUCT_SECTION_FOREACH(zprof_metric, m) {
		fn(i++, m, user);
	}
}

void zprof_heartbeat_reset(void)
{
	dropped_seen = zprof_ring.dropped_all;
	zprof_ring_peak = 0;
	STRUCT_SECTION_FOREACH(zprof_metric, m) {
		if (m->kind != ZPROF_KIND_GAUGE) {
			atomic_set(&m->value, 0);
		}
	}
}
