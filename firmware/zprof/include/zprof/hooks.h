/*
 * The functions zprof's tracing hooks call, and the ones Zephyr's tracing.h
 * expects a custom tracing format to provide (its own declarations are in the
 * block that CONFIG_TRACING_CUSTOM replaces). Forward declarations only: this
 * is included from zephyr_custom_tracing.h, deep inside the kernel headers.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_HOOKS_H_
#define ZPROF_HOOKS_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct k_thread;

void zprof_hook_switched_out(void);
void zprof_hook_switched_in(void);
void zprof_hook_ready(struct k_thread *thread);
void zprof_hook_pend(struct k_thread *thread);
void zprof_hook_prio(struct k_thread *thread, int prio);
void zprof_hook_create(struct k_thread *thread);
void zprof_hook_abort(struct k_thread *thread);
void zprof_hook_name(struct k_thread *thread);

/* Called by the architecture code; defined (strong) by zprof. */
void sys_trace_isr_enter(void);
void sys_trace_isr_exit(void);
void sys_trace_isr_exit_to_scheduler(void);
void sys_trace_idle(void);
void sys_trace_idle_exit(void);

#ifdef __cplusplus
}
#endif

#endif /* ZPROF_HOOKS_H_ */
