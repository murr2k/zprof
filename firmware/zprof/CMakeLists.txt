# SPDX-License-Identifier: Apache-2.0

if(CONFIG_ZPROF)
  # Every tracing hook zprof does not record, copied empty from the pinned
  # tracing.h (scripts/gen_trace_defaults.py); regenerated when tracing.h changes.
  set(ZPROF_TRACING_H ${ZEPHYR_BASE}/include/zephyr/tracing/tracing.h)
  set(ZPROF_GEN_DIR ${CMAKE_BINARY_DIR}/zprof_gen)
  execute_process(
    COMMAND ${PYTHON_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/scripts/gen_trace_defaults.py
            ${ZPROF_TRACING_H} ${ZPROF_GEN_DIR}/zprof_trace_defaults.h
    RESULT_VARIABLE ZPROF_GEN_RESULT
  )
  if(NOT ZPROF_GEN_RESULT EQUAL 0)
    message(FATAL_ERROR "zprof: gen_trace_defaults.py failed on ${ZPROF_TRACING_H}")
  endif()
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
               ${ZPROF_TRACING_H} ${CMAKE_CURRENT_LIST_DIR}/scripts/gen_trace_defaults.py)

  # Global: tracing.h is included by the kernel, drivers and subsystems.
  zephyr_include_directories(include ${ZPROF_GEN_DIR})

  zephyr_library_named(zprof)
  zephyr_library_sources(src/hooks.c src/metrics.c)
  # ZPROF_METRIC_DEFINE's iterable section (RAM: the values change)
  zephyr_linker_sources(DATA_SECTIONS zprof_metrics.ld)
  zephyr_library_sources_ifdef(CONFIG_ZPROF_TRANSPORT_TCP src/transport_tcp.c)
  zephyr_library_sources_ifdef(CONFIG_ZPROF_PMU src/pmu.c)
  zephyr_library_sources_ifdef(CONFIG_ZPROF_FAULT src/fault.c)
  zephyr_library_sources_ifdef(CONFIG_ZPROF_BUS src/bus.c)
  zephyr_library_sources_ifdef(CONFIG_ZPROF_SPANS src/span.c)
  zephyr_library_sources_ifdef(CONFIG_ZPROF_SAMPLE src/sample.c)
  if(CONFIG_ZPROF_LVGL)
    # LVGL's profiler macros into zprof spans (include/zprof/lvgl.h): global, so
    # every file that includes LVGL's headers agrees; these win over LVGL's Kconfig
    # values (lv_conf_internal.h takes a definition first)
    zephyr_compile_definitions(LV_USE_PROFILER_BUILTIN=0 LV_PROFILER_INCLUDE="zprof/lvgl.h")
  endif()
  # the protocol analyzer's wraps of driver functions (bus.c); each needs its driver
  if(CONFIG_ZPROF_BUS_ETH_STM32_TX)
    zephyr_ld_options(-Wl,--wrap=eth_stm32_tx)
  endif()
  if(CONFIG_ZPROF_BUS_I2C_STM32)
    zephyr_ld_options(-Wl,--wrap=i2c_stm32_transaction)
  endif()
  if(CONFIG_ZPROF_BUS_DISK)
    zephyr_ld_options(-Wl,--wrap=disk_access_read -Wl,--wrap=disk_access_write)
  endif()

  # A new build id on every build (scripts/gen_build_id.py).
  set(ZPROF_BUILD_ID_C ${ZPROF_GEN_DIR}/zprof_build_id.c)
  add_custom_target(zprof_build_id ALL
    COMMAND ${PYTHON_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/scripts/gen_build_id.py ${ZPROF_BUILD_ID_C}
    BYPRODUCTS ${ZPROF_BUILD_ID_C}
    COMMENT "zprof build id"
  )
  zephyr_library_sources(${ZPROF_BUILD_ID_C})
  add_dependencies(zprof zprof_build_id)
endif()
