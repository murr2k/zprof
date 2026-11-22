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

uint32_t zprof_ts_hz(void);

/* Timestamp ticks one hook costs (a session must be on; the ring is emptied after). */
uint32_t zprof_calibrate(void);

#endif /* ZPROF_INTERNAL_H_ */
