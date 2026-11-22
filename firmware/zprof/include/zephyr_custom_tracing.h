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
