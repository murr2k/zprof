/*
 * zprof's application API: markers around the work a thread does for one job,
 * where the kernel cannot see it (a loop that waits on more than one thing per
 * cycle, a frame that ends at a display swap).
 *
 *   ZPROF_MARK_START("frame");            the job starts (the running thread's)
 *   ZPROF_MARK_STOP("frame", 1);          it is done; 0: nothing was done, no job
 *
 * The name must be a string literal: only its address goes over the wire and the
 * host reads the text from the ELF. A deadlines file entry with "job": "frame"
 * makes the schedulability analysis take that thread's jobs from these marks.
 * Each mark is one 16-byte record; with CONFIG_ZPROF off this header is absent,
 * so an application includes it behind #ifdef CONFIG_ZPROF and defines the two
 * macros empty otherwise.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_ZPROF_H_
#define ZPROF_ZPROF_H_

#include <stdint.h>

#include <zprof/proto.h>

#ifdef __cplusplus
extern "C" {
#endif

void zprof_mark(uint8_t id, const char *name, uint32_t value);

#define ZPROF_MARK_START(name)       zprof_mark(ZPROF_EV_MARK_START, "" name, 0)
#define ZPROF_MARK_STOP(name, value) zprof_mark(ZPROF_EV_MARK_STOP, "" name, (uint32_t)(value))

#ifdef __cplusplus
}
#endif

#endif /* ZPROF_ZPROF_H_ */
