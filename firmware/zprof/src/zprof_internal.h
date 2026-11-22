/*
 * Shared between the hooks (hooks.c) and the sender (transport_tcp.c).
 *
 * The ring is an array of 32-bit words indexed by free-running counters:
 * writers (the hooks, any context, under arch_irq_lock) advance `head`, the
 * sender alone advances `tail`. A record is written whole before `head`
 * moves, so everything between tail and head can be sent as it is.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_INTERNAL_H_
#define ZPROF_INTERNAL_H_

#include <stdbool.h>
#include <stdint.h>

struct k_thread;

#define ZPROF_RING_WORDS (CONFIG_ZPROF_RING_SIZE / 4)

struct zprof_ring {
	volatile uint32_t head;
	volatile uint32_t tail;
	volatile uint32_t dropped;     /* records lost since the last OVERFLOW record */
	volatile uint32_t dropped_all; /* this session */
	volatile bool on;              /* a session runs: the hooks record */
	/* capture: while set, the hooks write here, from its start, instead of the ring;
	 * nobody drains it, so nothing (no sender, no network) has to keep up with it */
	uint32_t *volatile cap;
	volatile uint32_t cap_len;     /* words written */
	uint32_t cap_size;             /* words */
	uint32_t w[ZPROF_RING_WORDS];
};

extern struct zprof_ring zprof_ring;
extern volatile uint32_t zprof_classes;
extern struct k_thread *volatile zprof_self;

/* Write one record (the hooks' path, and the sender's own records). */
void zprof_put(uint8_t id, uint16_t arg, uint32_t nw, uint32_t a0, uint32_t a1, uint32_t a2,
	       uint32_t a3);

/* A SYNC record: the timestamp and the 64-bit kernel cycle count read together. */
void zprof_sync(void);

/* Start a session (ring emptied, then the hooks record) or end it. */
void zprof_session(bool on);

/* Capture: the hooks write into buf (`words` long) from its start instead of the
 * ring, until zprof_capture_end(), which gives the words written. What the ring
 * held stays there for the sender. A record that does not fit is dropped and
 * counted (the OVERFLOW after the capture says how many). */
void zprof_capture_begin(uint32_t *buf, uint32_t words);
uint32_t zprof_capture_end(void);

uint32_t zprof_ts_hz(void);

/* Timestamp ticks one hook costs (a session must be on; the ring is emptied after). */
uint32_t zprof_calibrate(void);

/* The heartbeat (metrics.c): the n-th since the session began. */
struct zprof_metric;
void zprof_heartbeat(uint32_t n);
void zprof_heartbeat_reset(void);
void zprof_metric_dict(void (*fn)(uint16_t index, const struct zprof_metric *m, void *user), void *user);
extern uint32_t zprof_ring_peak;

#endif /* ZPROF_INTERNAL_H_ */
