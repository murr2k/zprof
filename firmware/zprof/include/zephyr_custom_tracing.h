/*
 * zprof as Zephyr's tracing format (CONFIG_TRACING_CUSTOM): tracing.h includes
 * this file in place of its own empty hooks. The hooks zprof records are
 * defined here; every other one comes from zprof_trace_defaults.h, generated
 * from the pinned tracing.h at configure time, empty and guarded by #ifndef so
 * the definitions above it win.
 *
 * This header is reached from deep inside the kernel's own headers: forward
 * declarations only, no kernel includes.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_ZEPHYR_CUSTOM_TRACING_H_
#define ZPROF_ZEPHYR_CUSTOM_TRACING_H_

#include <zprof/hooks.h>
#include <zprof/proto.h>

/* Kernel objects. The bodies read fields of the object (a count, an owner):
 * they expand inside the kernel's own source, where the structs are complete.
 * Zephyr's CONFIG_TRACING_SEMAPHORE and siblings still decide whether a class
 * reaches these at all; zprof's run-time mask decides whether it is recorded. */
#define ZP_TO(t) ((uint32_t)(t).ticks)
#define ZP_P(p) ((uint32_t)(uintptr_t)(p))
#define ZP(cls, call, ph, obj, val) \
	zprof_obj(ZPROF_EV_##cls, ZPROF_OBJ_ARG(ZPROF_CALL_##call, ZPROF_PH_##ph), (obj), (uint32_t)(val))

/* One record per call that does not block: no ENTER for the calls that may
 * block (most never do), the call counted at its EXIT. One that blocks adds a
 * BLOCK record, which carries the timeout (a semaphore's count, a queue's fill
 * are known there anyway: 0, or full) or, for a mutex, its owner. The wait is
 * BLOCK to EXIT. One record instead of two for every call that does not block. */
#define sys_port_trace_k_sem_give_exit(sem)              ZP(SEM, GIVE, EXIT, sem, (sem)->count)
#define sys_port_trace_k_sem_take_blocking(sem, to)      ZP(SEM, TAKE, BLOCK, sem, ZP_TO(to))
#define sys_port_trace_k_sem_take_exit(sem, to, ret)     ZP(SEM, TAKE, EXIT, sem, ret)
#define sys_port_trace_k_sem_reset(sem)                  ZP(SEM, RESET, ENTER, sem, (sem)->count)

#define sys_port_trace_k_mutex_lock_blocking(m, to)      ZP(MUTEX, LOCK, BLOCK, m, ZP_P((m)->owner))
#define sys_port_trace_k_mutex_lock_exit(m, to, ret)     ZP(MUTEX, LOCK, EXIT, m, ret)
#define sys_port_trace_k_mutex_unlock_exit(m, ret)       ZP(MUTEX, UNLOCK, EXIT, m, ret)

#define sys_port_trace_k_msgq_put_blocking(q, to)        ZP(MSGQ, PUT, BLOCK, q, ZP_TO(to))
#define sys_port_trace_k_msgq_put_exit(q, to, ret)       ZP(MSGQ, PUT, EXIT, q, ret)
#define sys_port_trace_k_msgq_put_front_blocking(q, to)  ZP(MSGQ, PUT_FRONT, BLOCK, q, ZP_TO(to))
#define sys_port_trace_k_msgq_put_front_exit(q, to, ret) ZP(MSGQ, PUT_FRONT, EXIT, q, ret)
#define sys_port_trace_k_msgq_get_blocking(q, to)        ZP(MSGQ, GET, BLOCK, q, ZP_TO(to))
#define sys_port_trace_k_msgq_get_exit(q, to, ret)       ZP(MSGQ, GET, EXIT, q, ret)
#define sys_port_trace_k_msgq_purge(q)                   ZP(MSGQ, PURGE, ENTER, q, (q)->used_msgs)

/* fifos and lifos are k_queues: recorded once, at the queue level */
#define sys_port_trace_k_queue_queue_insert_enter(q, alloc) ZP(QUEUE, PUT, ENTER, q, alloc)
#define sys_port_trace_k_queue_get_blocking(q, to)       ZP(QUEUE, GET, BLOCK, q, ZP_TO(to))
#define sys_port_trace_k_queue_get_exit(q, to, ret)      ZP(QUEUE, GET, EXIT, q, (ret) != NULL)

#define sys_port_trace_k_thread_sleep_enter(to)          ZP(SLEEP, SLEEP, ENTER, NULL, ZP_TO(to))
#define sys_port_trace_k_thread_sleep_exit(to, ret)      ZP(SLEEP, SLEEP, EXIT, NULL, ret)
#define sys_port_trace_k_thread_msleep_enter(ms)         ZP(SLEEP, MSLEEP, ENTER, NULL, ms)
#define sys_port_trace_k_thread_msleep_exit(ms, ret)     ZP(SLEEP, MSLEEP, EXIT, NULL, ret)
#define sys_port_trace_k_thread_usleep_enter(us)         ZP(SLEEP, USLEEP, ENTER, NULL, us)
#define sys_port_trace_k_thread_usleep_exit(us, ret)     ZP(SLEEP, USLEEP, EXIT, NULL, ret)

#define sys_port_trace_k_poll_api_poll_enter(ev)         ZP(POLL, POLL, ENTER, ev, 0)
#define sys_port_trace_k_poll_api_poll_exit(ev, ret)     ZP(POLL, POLL, EXIT, ev, ret)

#define sys_port_trace_k_timer_expiry_enter(t)           ZP(TIMER, EXPIRY, ENTER, t, 0)
#define sys_port_trace_k_timer_expiry_exit(t)            ZP(TIMER, EXPIRY, EXIT, t, 0)

/* k_work_submit, _schedule and _reschedule call their _for_queue forms: those only.
 * The value is the handler, so the host names the work item by it (a work item is
 * often embedded in a larger struct with no symbol of its own). */
#define sys_port_trace_k_work_submit_to_queue_enter(q, w)          ZP(WORK, SUBMIT, ENTER, w, ZP_P((w)->handler))
#define sys_port_trace_k_work_schedule_for_queue_enter(q, dw, d)   ZP(WORK, SCHEDULE, ENTER, dw, ZP_P((dw)->work.handler))
#define sys_port_trace_k_work_reschedule_for_queue_enter(q, dw, d) ZP(WORK, RESCHEDULE, ENTER, dw, ZP_P((dw)->work.handler))
#define sys_port_trace_k_work_cancel_enter(w)                      ZP(WORK, CANCEL, ENTER, w, ZP_P((w)->handler))

#define sys_port_trace_k_thread_switched_out() zprof_hook_switched_out()
#define sys_port_trace_k_thread_switched_in()  zprof_hook_switched_in()
#define sys_port_trace_k_thread_sched_ready(thread) zprof_hook_ready(thread)
#define sys_port_trace_k_thread_sched_pend(thread)  zprof_hook_pend(thread)
#define sys_port_trace_k_thread_sched_priority_set(thread, prio) zprof_hook_prio(thread, prio)
#define sys_port_trace_k_thread_create(new_thread)  zprof_hook_create(new_thread)
#define sys_port_trace_k_thread_abort(thread)       zprof_hook_abort(thread)
#define sys_port_trace_k_thread_name_set(thread, ret) zprof_hook_name(thread)

#include "zprof_trace_defaults.h"

#endif /* ZPROF_ZEPHYR_CUSTOM_TRACING_H_ */
