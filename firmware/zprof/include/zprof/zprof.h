/*
 * zprof's application API. With CONFIG_ZPROF off this header is absent, so an
 * application includes it behind #ifdef CONFIG_ZPROF and defines the macros it
 * uses empty otherwise (the demo's app/src/platform/prof.h does).
 *
 * Marks: around the work a thread does for one job, where the kernel cannot see
 * it (a loop that waits on more than one thing per cycle, a frame that ends at a
 * display swap).
 *
 *   ZPROF_MARK_START("frame");            the job starts (the running thread's)
 *   ZPROF_MARK_STOP("frame", 1);          it is done; 0: nothing was done, no job
 *
 * Plots and prints: a value or a line at this instant, on the trace's clock.
 *
 *   ZPROF_PLOT("frame.margin_us", left);            a signed 32-bit value
 *   ZPROF_PRINT("seek to %u ms, %d", pos, err);     up to three integers; no %s
 *
 * Metrics: declared once, updated in RAM, sent at every heartbeat
 * (CONFIG_ZPROF_HEARTBEAT_MS) with names and units in the hello.
 *
 *   ZPROF_METRIC_DEFINE(rx_bytes, "net.rx_bytes", COUNTER, "B");
 *   ZPROF_ADD(rx_bytes, n);       a counter: events since the last heartbeat
 *   ZPROF_SET(level, v);          a gauge: the value now
 *   ZPROF_TIMER_START(busy); ... ZPROF_TIMER_STOP(busy);   time spent per heartbeat
 *
 * Names, formats and units must be string literals: only their addresses go over
 * the wire and the host reads the text from the ELF. A mark, plot or print is one
 * record (16 to 24 bytes), recorded with every capture preset.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_ZPROF_H_
#define ZPROF_ZPROF_H_

#include <stddef.h>
#include <stdint.h>

#include <zephyr/sys/atomic.h>
#include <zephyr/sys/iterable_sections.h>
#include <zprof/proto.h>

#ifdef __cplusplus
extern "C" {
#endif

void zprof_mark(uint8_t id, const char *name, uint32_t value);
void zprof_plot(const char *name, int32_t value);
void zprof_print(const char *fmt, uint32_t a0, uint32_t a1, uint32_t a2);

#define ZPROF_MARK_START(name)       zprof_mark(ZPROF_EV_MARK_START, "" name, 0)
#define ZPROF_MARK_STOP(name, value) zprof_mark(ZPROF_EV_MARK_STOP, "" name, (uint32_t)(value))
#define ZPROF_PLOT(name, value)      zprof_plot("" name, (int32_t)(value))
#define ZPROF_PRINT(fmt, ...)        Z_ZPROF_PRINT(fmt, ##__VA_ARGS__, 0, 0, 0)
#define Z_ZPROF_PRINT(fmt, a, b, c, ...) \
	zprof_print("" fmt, (uint32_t)(uintptr_t)(a), (uint32_t)(uintptr_t)(b), (uint32_t)(uintptr_t)(c))

/* A metric: in an iterable section, so the heartbeat finds every one. */
struct zprof_metric {
	const char *name;
	const char *unit;
	uint8_t kind;          /* ZPROF_KIND_* */
	atomic_t value;
	uint32_t started;      /* a timer: when it started (timestamp ticks) */
};

#define ZPROF_METRIC_DEFINE(var, m_name, m_kind, m_unit) \
	STRUCT_SECTION_ITERABLE(zprof_metric, var) = { \
		.name = "" m_name, .unit = "" m_unit, .kind = ZPROF_KIND_##m_kind, .value = ATOMIC_INIT(0)}

#define ZPROF_ADD(var, n) ((void)atomic_add(&(var).value, (atomic_val_t)(n)))
#define ZPROF_SET(var, v) ((void)atomic_set(&(var).value, (atomic_val_t)(v)))
#define ZPROF_TIMER_START(var) ((var).started = zprof_now())
#define ZPROF_TIMER_STOP(var) ZPROF_ADD(var, zprof_now() - (var).started)

/* The trace's timestamp (timer metrics). */
uint32_t zprof_now(void);

/* Port hooks, weak in the module (an application overrides them):
 * - memory for the capture buffer (CONFIG_ZPROF_CAPTURE_KB), asked for once, at the
 *   first capture; NULL: no capture mode;
 * - called at every heartbeat before the metrics go out, to set gauges from the
 *   application's own counters. */
void *zprof_port_alloc(size_t bytes);
void zprof_port_heartbeat(void);

#ifdef __cplusplus
}
#endif

#endif /* ZPROF_ZPROF_H_ */
