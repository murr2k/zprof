/*
 * LVGL's profiler points as zprof spans (CONFIG_ZPROF_LVGL).
 *
 * zprof's CMake makes this LVGL's LV_PROFILER_INCLUDE and turns LVGL's built-in
 * profiler off; LVGL includes it after its own configuration, so the four macros
 * every category macro (LV_PROFILER_DRAW_BEGIN, ..._LAYOUT_..., ..._EVENT_...)
 * expands to are redefined here. Which categories exist is LVGL's build choice
 * (CONFIG_LV_PROFILER_LAYOUT, _REFR, _DRAW, _EVENT, ...); the tags are __func__,
 * string literals and names in rodata, which the host reads from the ELF.
 *
 * Not recording, each point costs a load and a branch.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef ZPROF_LVGL_H_
#define ZPROF_LVGL_H_

#include <stdint.h>

#if defined(LV_USE_PROFILER_BUILTIN) && LV_USE_PROFILER_BUILTIN
#error "CONFIG_ZPROF_LVGL replaces LVGL's built-in profiler: LV_USE_PROFILER_BUILTIN must be 0"
#endif

#ifdef __cplusplus
extern "C" {
#endif

extern volatile uint32_t zprof_span_on;
void zprof_span_begin(const char *name);
void zprof_span_end(const char *name);

#ifdef __cplusplus
}
#endif

#undef LV_PROFILER_BEGIN
#undef LV_PROFILER_END
#undef LV_PROFILER_BEGIN_TAG
#undef LV_PROFILER_END_TAG

#define LV_PROFILER_BEGIN_TAG(tag)                \
	do {                                      \
		if (zprof_span_on) {              \
			zprof_span_begin(tag);    \
		}                                 \
	} while (0)
#define LV_PROFILER_END_TAG(tag)                  \
	do {                                      \
		if (zprof_span_on) {              \
			zprof_span_end(tag);      \
		}                                 \
	} while (0)
#define LV_PROFILER_BEGIN LV_PROFILER_BEGIN_TAG(__func__)
#define LV_PROFILER_END   LV_PROFILER_END_TAG(__func__)

#endif /* ZPROF_LVGL_H_ */
