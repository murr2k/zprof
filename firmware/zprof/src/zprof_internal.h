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
	volatile bool on;              /* a session runs, or the flight recorder: the hooks record */
	volatile bool overwrite;       /* the flight recorder: when full, drop the oldest records */
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

/* A record of up to 15 payload words from an array (not for the hooks' path). */
void zprof_put_n(uint8_t id, uint16_t arg, uint32_t nw, const uint32_t *p);

/* Spans (span.c): on or off for this session, the shortest kept (ns), the deepest
 * level kept; back, as HT_SPANS sends them: those three and what a begin and an end
 * cost (ticks, measured at the switch-on). */
void zprof_spans_set(bool on, uint32_t shortest_ns, uint32_t deepest);
void zprof_spans_get(uint32_t v[4]);

/* PC sampling (sample.c): the rate asked for (0: off); returns the rate set (0 if the
 * port has no timer). get: rate, the handler's mean run (ticks), 1 (built in). */
uint32_t zprof_sample_set(uint32_t hz);
void zprof_sample_get(uint32_t v[3]);

/* The protocol analyzer (bus.c): the buses recorded now, and those built in. */
extern volatile uint32_t zprof_proto;
extern const uint32_t zprof_proto_avail;

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

/* The flight recorder (ZPROF_REC_*): armed, it records into the ring while no
 * client is connected (the newest records stay), a trigger freezes it, and the
 * next session sends it first. */
struct zprof_recorder {
	volatile uint32_t state;   /* ZPROF_REC_* */
	uint32_t post_ms;          /* recording goes on this long after a trigger */
	volatile uint32_t triggers;
};
extern struct zprof_recorder zprof_rec;

/* Arm (post_ms > 0) or turn off; armed, it records once no client is connected. */
void zprof_recorder_set(uint32_t post_ms);
/* No client any more (or at boot): record if armed. */
void zprof_recorder_resume(void);
/* A session took the held recording: armed again. */
void zprof_recorder_taken(void);

/* The last fault (fault.c, CONFIG_ZPROF_FAULT): HT_FAULT's 48 words, in this order. */
struct zprof_fault {
	uint32_t magic;          /* ZPROF_FAULT_MAGIC */
	uint32_t words;          /* 48 */
	uint32_t build_id[4];
	uint32_t uptime_ms;
	uint32_t reason;         /* K_ERR_* */
	uint32_t flags;          /* ZPROF_FAULT_F_* */
	uint32_t thread;
	char name[16];
	uint32_t r[8];           /* r0-r3, r12, lr, pc, xpsr as stacked */
	uint32_t callee[9];      /* r4-r11, psp */
	uint32_t msp, exc_return;
	uint32_t hfsr, mmfar, bfar, sfar;
	uint32_t nframes;
	uint32_t frames[8];      /* return addresses, the faulting pc first */
	uint32_t ts;             /* the trace's timestamp at the fault */
	uint32_t crc;            /* crc32_ieee of the words before */
};
extern struct zprof_fault zprof_fault;
extern volatile bool zprof_fault_new;
/* A fault: an armed flight recorder freezes now, without its post time. */
void zprof_recorder_fault(void);

/* The PMU (pmu.c, CONFIG_ZPROF_PMU): four chained counts. */
#define ZPROF_PMU_N 4
struct zprof_pmu {
	uint16_t ev[ZPROF_PMU_N];  /* Arm PMU event numbers counted */
	volatile uint32_t flags;   /* ZPROF_PMU_F_* */
};
extern struct zprof_pmu zprof_pmu;
/* A PMU record of this kind (ZPROF_PMU_*), if a session or the recorder records. */
void zprof_pmu_put(uint16_t kind);
/* New events (0xFFFF: keep) and flags: the counters restart, a BASE record follows. */
void zprof_pmu_set(const uint16_t ev[ZPROF_PMU_N], uint32_t flags);
/* The events and flags a session starts with. */
void zprof_pmu_defaults(void);
uint32_t zprof_pmu_auth(void);

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
