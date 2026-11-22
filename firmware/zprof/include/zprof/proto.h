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
/* Kernel objects: arg = call << 4 | phase; payload: object, value. Calls that
 * may block (sem take, mutex lock, msgq put/get, queue get) have no ENTER: one
 * EXIT record (the return code) when they do not block, BLOCK (the timeout in
 * ticks, 0xFFFFFFFF forever; a mutex: its owner) and EXIT when they do. A sem
 * give and a mutex unlock: EXIT only. Other calls: ENTER with their input,
 * EXIT where it has a meaning (sleep, poll, timer expiry). Records from the
 * zprof sender itself are left out. */
#define ZPROF_EV_SEM 0x10    /* calls: GIVE (exit: count after), TAKE, RESET */
#define ZPROF_EV_MUTEX 0x11  /* calls: LOCK (block: owner), UNLOCK */
#define ZPROF_EV_MSGQ 0x12   /* calls: PUT, GET, PUT_FRONT (block: messages queued), PURGE */
#define ZPROF_EV_QUEUE 0x13  /* k_queue, k_fifo, k_lifo; calls: PUT (enter: allocated), GET (exit: got one) */
#define ZPROF_EV_SLEEP 0x14  /* object 0 (the thread); calls: SLEEP (ticks), MSLEEP (ms), USLEEP (us) */
#define ZPROF_EV_POLL 0x15   /* object: the event array; call POLL */
#define ZPROF_EV_TIMER 0x16  /* call EXPIRY: the timer's expiry function runs (enter, exit) */
#define ZPROF_EV_WORK 0x17   /* calls: SUBMIT, SCHEDULE, RESCHEDULE, CANCEL; value: the handler */
#define ZPROF_OBJ_FIRST 0x10
#define ZPROF_OBJ_LAST 0x17

#define ZPROF_PH_ENTER 1
#define ZPROF_PH_BLOCK 2
#define ZPROF_PH_EXIT 3

#define ZPROF_CALL_GIVE 1
#define ZPROF_CALL_TAKE 2
#define ZPROF_CALL_RESET 3
#define ZPROF_CALL_LOCK 1
#define ZPROF_CALL_UNLOCK 2
#define ZPROF_CALL_PUT 1
#define ZPROF_CALL_GET 2
#define ZPROF_CALL_PUT_FRONT 3
#define ZPROF_CALL_PURGE 4
#define ZPROF_CALL_SLEEP 1
#define ZPROF_CALL_MSLEEP 2
#define ZPROF_CALL_USLEEP 3
#define ZPROF_CALL_POLL 1
#define ZPROF_CALL_EXPIRY 1
#define ZPROF_CALL_SUBMIT 1
#define ZPROF_CALL_SCHEDULE 2
#define ZPROF_CALL_RESCHEDULE 3
#define ZPROF_CALL_CANCEL 4

#define ZPROF_OBJ_ARG(call, phase) (((call) << 4) | (phase))

#define ZPROF_EV_THREAD_STATS 0x71 /* thread, execution cycles low, high (the kernel's own count) */
#define ZPROF_EV_SYNC 0x7E         /* kernel cycles low, high, uptime ms */
#define ZPROF_EV_OVERFLOW 0x7F     /* arg IPSR; dropped, kernel cycles low, high, current thread */

#define ZPROF_ISR_EXC 0x8000u      /* ISR arg: a system exception, not an IRQ */

/* SWITCH_OUT's arg: Zephyr's thread state bits (kernel_structs.h _THREAD_*; hooks.c
 * checks they still are). Pending: blocked on the wait queue in the payload;
 * sleeping: in k_sleep; queued: still ready (preempted or yielded). */
#define ZPROF_THS_PENDING 0x02
#define ZPROF_THS_SLEEPING 0x04
#define ZPROF_THS_SUSPENDED 0x10
#define ZPROF_THS_QUEUED 0x80

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
#define ZPROF_HT_CLASSES 10  /* u32 mask of the kernel-object classes recorded (bit = id - 0x10) */
#define ZPROF_HT_END 0xFFFF /* end of a hello or of a thread table update */

/* Control TLV, host to target, in frames on the control channel. */
#define ZPROF_CT_CLASSES 64 /* u32 mask of kernel-object classes to record; answered with HT_CLASSES */

#define ZPROF_TS_SRC_DWT 0
#define ZPROF_TS_SRC_KCYCLE 1

#endif /* ZPROF_PROTO_H_ */
