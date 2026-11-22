/*
 * zprof wire protocol: the numbers. docs/PROTOCOL.md describes them; the host
 * bridge reads its ids from this file (host/bridge/zprof_bridge/proto.py), so
 * keep one #define per line in the form below.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_PROTO_H_
#define ZPROF_PROTO_H_

#define ZPROF_PROTO_VERSION 1

/* Stream preamble, target to host: "ZPRF" u16 version u16 flags. */
#define ZPROF_MAGIC "ZPRF"

/* Frame: u8 channel | u8 flags | u16 seq | u32 len | payload */
#define ZPROF_FRAME_HDR 8
#define ZPROF_CH_CONTROL 0
#define ZPROF_CH_METRICS 1
#define ZPROF_CH_TRACE 2
#define ZPROF_CH_HEAP 5

/* Record: u32 ts | u8 id | u8 nw | u16 arg | nw x u32. nw: bits 0-3. */
#define ZPROF_REC_WORDS(nw) (2u + (nw))
#define ZPROF_REC_HDR(id, nw, arg) \
	((uint32_t)(id) | ((uint32_t)(nw) << 8) | ((uint32_t)(uint16_t)(arg) << 16))
#define ZPROF_REC_NW(w1) (((w1) >> 8) & 0xFu)

#define ZPROF_EV_SWITCH_IN 0x01    /* arg prio; thread */
#define ZPROF_EV_SWITCH_OUT 0x02   /* arg thread state; thread, pended-on wait queue */
#define ZPROF_EV_ISR_ENTER 0x03    /* arg IRQ, or 0x8000 | exception number */
#define ZPROF_EV_ISR_EXIT 0x04     /* arg as ISR_ENTER */
#define ZPROF_EV_IDLE 0x05         /* */
#define ZPROF_EV_IDLE_EXIT 0x06    /* */
#define ZPROF_EV_READY 0x07        /* thread */
#define ZPROF_EV_PEND 0x08         /* thread */
#define ZPROF_EV_PRIO 0x09         /* arg new prio; thread */
#define ZPROF_EV_CREATE 0x0A       /* arg prio; thread, entry */
#define ZPROF_EV_ABORT 0x0B        /* thread */
#define ZPROF_EV_NAME 0x0C         /* thread (the name follows on the control channel) */
#define ZPROF_EV_THREAD_STATS 0x71 /* thread, execution cycles low, high (the kernel's own count) */
#define ZPROF_EV_SYNC 0x7E         /* kernel cycles low, high, uptime ms */
#define ZPROF_EV_OVERFLOW 0x7F     /* arg IPSR; dropped, kernel cycles low, high, current thread */

#define ZPROF_ISR_EXC 0x8000u      /* ISR arg: a system exception, not an IRQ */

/* Hello TLV on the control channel: u16 tag | u16 len | value. */
#define ZPROF_HT_PROTO 1    /* u16 protocol version */
#define ZPROF_HT_KERNEL 2   /* Zephyr version string */
#define ZPROF_HT_BUILD_ID 3 /* 16 bytes; u32 address of zprof_build_id follows */
#define ZPROF_HT_CLOCKS 4   /* u32 timestamp Hz, u32 kernel cycle Hz, u32 source (0 DWT, 1 kernel) */
#define ZPROF_HT_RING 5     /* u32 ring bytes */
#define ZPROF_HT_SENDER 6   /* u32 the sender thread */
#define ZPROF_HT_THREAD 7   /* u32 thread, i32 prio, u32 entry, u32 stack start, u32 stack size, name */
#define ZPROF_HT_IRQ 8      /* u16 irq, u8 NVIC prio, u8 enabled, u32 handler, u32 arg */
#define ZPROF_HT_HOOK_COST 9 /* u32 timestamp ticks one hook costs, measured at connect */
#define ZPROF_HT_END 0xFFFF /* end of a hello or of a thread table update */

#define ZPROF_TS_SRC_DWT 0
#define ZPROF_TS_SRC_KCYCLE 1

#endif /* ZPROF_PROTO_H_ */
