# zprof dashboard specification

Status: specification plus a running mockup on synthetic data (`web/`, section 10).
Nothing talks to hardware yet. Written 2026-10-18, extended 2026-10-19 with the
hybrid views (section 13) and the write path (section 14); companion to
[PLANS.md](PLANS.md), which covers research, architecture, firmware agent and
transport. This document defines **what** the dashboard shows, to whom, from
which source, and how it is laid out. It is deliberately platform-agnostic;
section 11 lists what the platform choice changes.

Conventions: "zprof" is the firmware agent and host bridge from PLANS.md.
"Heartbeat" is the agent's periodic sample (10 Hz on the bench, 1 Hz in soak).
Zephyr is pinned to `main` at a915b2f1 (2026-10-16, 4.5 development) in
`firmware/west.yml`, and every Zephyr symbol named in section 3 was checked
against that commit unless marked *unverified*. Bumping the pin means
re-checking section 3.

Targets: a Zynq PS (part to be chosen) and the STM32N6570-DK (Cortex-M55,
for development practice). Section 11 compares them.

## 1. Users and the questions they ask

### 1.1 Firmware engineer: development and design verification (DVT)

Works on one board at a time, interactively, for seconds to hours. Changes code,
reflashes, compares. Needs microsecond resolution and cause, not just effect.

- Which thread or ISR is using the CPU right now, and why did it run?
- Why did this activation miss its deadline? What ran instead, and for how long?
- What is the wake-up latency and jitter of my periodic threads under load?
- How much stack, heap, slab and queue headroom is left at the worst moment?
- What does this change cost in CPU, latency, footprint and stack?
- Where does the time go inside a thread (functions, call paths)?
- Does the design hold at temperature and voltage corners (DVT)?
- Is the measurement itself disturbing the system (observer effect)?

### 1.2 Firmware QA engineer: test and reliability

Runs many DUTs for hours to weeks, unattended, against written pass criteria.
Needs aggregation, classification, trends and evidence, then a verdict and a
report.

- Did the run pass? Which criterion failed, on which DUT, and when?
- How many resets, hangs, faults and watchdog bites, by cause, and how do they
  correlate with temperature, voltage or test phase?
- Is anything leaking or drifting (heap, stack watermark, latency, error rates)?
- What is the demonstrated MTBF, with a confidence bound?
- Did build B regress against build A (footprint, CPU, latency, tests, coverage)?
- What exactly happened before each failure (fault record, coredump, trace)?
- Is the telemetry complete enough to trust the verdict (data loss)?

### 1.3 One app, two role workspaces

About 80% of the parameters are common (CPU, memory, faults, latency, link
health), but presentation differs sharply: development is time-resolved,
high-rate, single-target and causal; QA is aggregated, long-horizon,
multi-target and criteria-driven. So:

- **One app, one data model, one metric catalog** (section 3). Every widget
  declares which catalog IDs it consumes. No metric is computed twice.
- **A common header** on every view: target identity, link health, alarms.
- **A left rail** of views grouped by role (it collapses to icons and carries
  badges), instead of workspace tabs:

| Rail group | View | Purpose | Mockup |
|---|---|---|---|
| Intelligence | Insights | Ranked findings with evidence, links to it, and a fix to try | yes |
| Engineering | Live | Real-time overview with the scheduler timeline | yes |
| Engineering | Trace | Vertical sequence trace, response anatomy, event log | yes |
| Engineering | Timing | Scheduling eye, period raster, jitter constellation, worst jobs | yes |
| Engineering | Objects | Kernel object flow graph, call breakdown, inspector | yes |
| Engineering | Memory | RAM floor plan, heap X-ray, leak cone | yes |
| Engineering | Headroom 3D | Every budgeted resource in threshold units, rotate to read | yes |
| Engineering | Profile | Function cost: flame graph, hot functions | yes |
| Engineering | Boot | Reset to main, init levels, first heartbeat | spec only |
| Debug | Watch & Tune | Parameter writes through the agent, triggered scope, step metrics | yes |
| Reliability | Soak run | Run status, verdict, events, trends, fleet, faults | yes |
| Reliability | Thermal helix | Soak by chamber phase, with a clustering test | yes |
| Reliability | Build compare | A/B regression gate between builds | yes |
| Reliability | Fault detail | One failure: fault record, coredump, flight recorder | spec only |

Views hand each other a **focus** (a time, a job, a parameter to stage), so an
insight, a raster column or a worst-job row opens the Trace at the microsecond
it cites.

A separate app per role was rejected: the same failure needs both views. QA
finds a watchdog reset in the soak timeline and hands the engineer a link that
opens the flight-recorder trace in the Trace view.

## 2. Data model

### 2.1 Record kinds

| Kind | Shape | Produced by | Examples |
|---|---|---|---|
| Static | key/value, once per connection | hello record | versions, build ID, clock rates |
| Sample | `{id, t, value}` | heartbeat, bridge | CPU %, heap bytes, link B/s |
| Interval | `{lane, t0, t1, state}` | bridge from trace | thread running / ready, ISR span |
| Event | `{t, kind, attrs}` | target or bridge | reset, fault, assert, WDT, hang, deadline miss |
| Snapshot | table, periodic | heartbeat | thread table |
| Build | per build | build artifacts | footprint, test results, coverage, Kconfig |
| External | `{id, t, value}` | instruments, fixtures | chamber temperature, supply current |
| Kernel event | `{t, ctx, obj, call, result, peer, value}` | bridge from trace | `k_sem_give(spi_done)` wakes sensor_rx; `k_sem_take(bus_lock)` blocks, held by storage |
| Job | `{thread, release, start, end, exec, delay by cause}` | bridge, derived | one ctrl_loop activation and where its response time went |
| Watch | `{id, t, value}` in target time | agent watch block | plant speed, controller output |
| Parameter request | `{seq, id, from, to, state, t_staged, t_applied, t_ack}` | bridge and agent | ctrl.kp 0.06 to 0.08, applied at the next ctrl_loop job |

PLANS.md section 5 defined Sample, Interval and Snapshot; this adds Event,
Static, Build, External, and for the hybrid views Kernel event, Job, Watch and
Parameter request.

### 2.2 Provenance classes

Every number on screen carries one of these tags (shown on hover), because the
same quantity can disagree between sources and the user must know which one
they are reading (PLANS.md section 9, ISR accounting).

| Code | Class | Rate | Notes |
|---|---|---|---|
| S | Static, hello record | once | |
| H | Heartbeat sample | 1 to 10 Hz | cheap, always on; thread CPU includes ISR time |
| T | Trace-derived | per event | exact timing; costs link bandwidth (PLANS.md section 8) |
| E | Event record | async | survives resets via retained RAM where noted |
| B | Build artifact | per build | from the build directory and twister output |
| X | External | instrument rate | host-side drivers, not the target |
| D | Derived on host | n/a | computed once in the bridge, shared by UI and reports |
| P | Probe read | host polling | read through the debug probe while the core runs; host-timed (USB jitter about 1 ms), so never aligned with target time (section 14) |

### 2.3 Time bases

- **Target time**: ns since boot from the agent's clock (timing counter or
  kernel cycles, declared in the hello record). Engineering views use it.
- **Host time**: wall clock at the bridge. Reliability views use it, because a
  soak spans many boots.
- The bridge fits offset and drift per boot from (target, host) pairs on every
  heartbeat and maps target time onto host time. A boot-count change or an
  uptime that goes backwards starts a new segment.

### 2.4 Metric IDs

Dotted, lower case, instance in the middle: `thread.ctrl_loop.cpu`,
`heap._system_heap.alloc`, `irq.eth0.dur`. The instance set is discovered at
runtime from the hello and heartbeat records, never hard-coded in the UI.

## 3. Parameter catalog

Role columns: **●** primary (on that role's default view), **○** available
(drill-down, secondary view), blank (not shown by default). Class codes are
from section 2.2.

**Re-checked at Zephyr v4.4.0 (684c9e8f), 2026-11-21**, when the pin moved
from `main` a915b2f1 (PLANS.md section 0). About 118 of 133 citations below
hold unchanged. These do not, and the corrections override the rows that
cite them:

| Line(s) | Cited | At v4.4.0 |
|---|---|---|
| 178, 897 | `tracing_packet_drop_count_get()` | Absent; the core's drop counter is static. zprof does not use the tracing core: its ring reports drops itself (OVERFLOW records) |
| 185, 869-872 | Two `cpu_load` backends (idle hook; runtime stats on SMP) | One: the idle-hook implementation (`!SMP`; Cortex-M, RISC-V, ARM64 only, so not 32-bit Zynq). ISR time counts as busy (idle exit runs before interrupts are re-enabled). A format that overrides `sys_trace_idle*()` must call `cpu_load_on_enter/exit_idle()` itself (zprof does) |
| 185 | `cpu_load_cb_reg(cb, threshold)` | Present, but it fires only from the periodic log timer (`CPU_LOAD_LOG_PERIODICALLY`), which also resets the measurement window each period |
| 219, 861 | `sys_heap_get_largest_free_block()` | Absent: fragmentation needs an agent chunk walk, or waits |
| 224 | Stock CTF `heap_alloc_exit` / `heap_free` | Stock CTF has no `k_heap` events at all; the `--wrap` path is the only one |
| 239 | CTF `fifo_*` and `heap_*` object events | Absent (no queue, lifo or stack events either). Present: `semaphore_*`, `mutex_*`, `msgq_*` with `_blocking`, `timer_expiry_*`, `work_*`, plus `mem_slab_*`, `condvar_*`, `mbox_*`, `event_*`, `poll_*` |
| 241 | Inheritance boosts as `thread_priority_set` | `adjust_owner_prio()` traces `sched_priority_set` (CTF `thread_sched_priority_set`); `thread_priority_set` is not emitted for boosts |
| 247-248 | Pipe events from CTF | Stock CTF has no pipe events; a custom hook or an application wrapper |
| 260, 895 | Weak `zassert_post_action(file, line)` | Weak `assert_post_action(file, line)` (`lib/os/assert.c`), not noreturn; the default calls `k_panic()` |
| 265 | CTF `sys_init_enter/exit` | Hooks exist (`kernel/init.c`), CTF leaves them empty; a format implements `sys_trace_sys_init_*` itself |
| 322 | `perf` on Cortex-M and ARM64 | Backends for RISC-V and x86 only; not Cortex-M |
| 323 | ARM64 PMUv3 API | Absent; no PMU API for either Arm profile. On the M55, zprof drives the PMU through CMSIS 6 (`armv8m_pmu.h`) itself |
| 331 | `-fstack-usage` (unverified) | `CONFIG_STACK_USAGE` |
| 896 | `TRACING_OBJECT_TRACKING` selects `OBJ_CORE` | Selects nothing; keeps the `_track_list_*` lists (`tracking.h`) |

Rows that say "at a915b2f1" or "on `main`" (224, 239, 247, 257, 289, 894)
otherwise still hold at v4.4.0. (Line numbers are those before this note was
added; add 26.)

### 3.1 Identity and session

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `id.board` | Board, SoC, CPU count | text | `CONFIG_BOARD`, `CONFIG_SOC`, `CONFIG_MP_MAX_NUM_CPUS` baked into hello | S | ● | ● |
| `id.fw` | App version and git describe | text | `app_version.h`, `BUILD_VERSION` | S | ● | ● |
| `id.zephyr` | Zephyr version | text | `sys_kernel_version_get()` | S | ○ | ● |
| `id.build_id` | ELF build ID (symbolization key, report join key) | hex | GNU build-id note, read by the agent | S | ● | ● |
| `id.config_hash` | Hash of `.config` | hex | generated header at build time | S | ○ | ● |
| `id.device` | DUT unique ID | hex | `hwinfo_get_device_id()` | S | ○ | ● |
| `id.clocks` | Kernel cycles/s, timing counter Hz, tick rate | Hz | `sys_clock_hw_cycles_per_sec()`, `timing_freq_get()`, `CONFIG_SYS_CLOCK_TICKS_PER_SEC` | S | ● | ○ |
| `id.agent` | zprof version, heartbeat period, enabled channels, transport | text | zprof | S | ● | ● |
| `boot.count` | Boot counter | count | zprof, retained RAM or settings | S | ○ | ● |
| `boot.reset_cause` | Reset cause flags of this boot | flags | `hwinfo_get_reset_cause()`, then `hwinfo_clear_reset_cause()` | S | ● | ● |
| `session.*` | Run ID, plan and case, operator, fixture, DUT label, chamber profile | text | run configuration on the host | X | | ● |

### 3.2 Telemetry link and observer effect

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `link.bps` | Received throughput | B/s | bridge | D | ● | ○ |
| `link.util` | Throughput as a share of the measured link budget | % | bridge | D | ● | |
| `link.lost` | Frames lost, per channel | count, % | `seq` gaps | D | ● | ● |
| `link.crc` | Frames failing CRC | count | bridge | D | ○ | ● |
| `link.age` | Time since the last frame | ms | bridge | D | ● | ● |
| `hb.jitter` | Heartbeat period jitter | ms | target timestamps | D | ○ | |
| `agent.self` | Agent CPU share (observer effect) | % | runtime stats of the zprof thread | H | ● | ● |
| `trace.drop` | Trace packets dropped on target | count | `tracing_packet_drop_count_get()` (cumulative, tracing core) plus the zprof backend's own counter | H | ● | ○ |
| `trace.buf_hwm` | Trace ring / RTT up-buffer high-water | B | zprof | H | ● | |

### 3.3 CPU and scheduling

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `cpu.load` | CPU load | % | `cpu_load_get(bool reset)`, per mille. ISR time is included only by the idle-hook backend (single CPU; can time with a counter device, `CONFIG_CPU_LOAD_USE_COUNTER`); the runtime-stats backend (SMP default) excludes it. The KPI label names the backend. `cpu_load_cb_reg(cb, threshold_percent)` calls back when load crosses a threshold; the agent raises an overload Event from it | H | ● | ● |
| `cpu.<n>.busy` | Per-CPU busy share (SMP) | % | `k_thread_runtime_stats_cpu_get()`; needs `SCHED_THREAD_USAGE_ALL` or it silently returns zeros | H | ● | ○ |
| `thread.<t>.cpu` | CPU share per thread (ISR time folded in) | % | `k_thread_runtime_stats_get()`, `execution_cycles` delta | H | ● | ● |
| `thread.<t>.run_avg`, `.run_peak` | Average and peak execution window | us | `average_cycles`, `peak_cycles` (`CONFIG_SCHED_THREAD_USAGE_ANALYSIS`) | H | ● | ○ |
| `thread.<t>.state`, `.prio` | Scheduler state and priority | enum | `k_thread_state_str()`, `k_thread_priority_get()` | H | ● | |
| `isr.cpu` | CPU share in ISRs | % | trace intervals | T | ● | ○ |
| `sched.switch` | Context switches per second, total and per thread | /s | trace; agent hook counters when streaming is off | T | ● | ○ |
| `sched.preempt.<t>` | Preemptions per second (switched out while still ready) | /s | trace | T | ● | |
| `sched.wake.<t>` | Ready-to-running latency p50 / p99 / max | us | trace: ready event to `switched_in` | T | ● | ● |
| `sched.jitter.<t>` | Activation jitter of periodic threads | us | trace, period from the metric registry | T | ● | ● |
| `sync.<obj>.wait` | Blocking count and wait time on mutex, semaphore, queue | count, us | trace pend and unpend hooks | T | ● | |
| `sync.inversion` | Priority inversion episodes and duration | count, us | trace: blocked on a mutex whose holder has lower priority | T | ● | ○ |
| `irq.locked_max` | Longest interrupts-disabled section | us | not hookable (`irq_lock()` is inline): instruction trace (PLANS.md D-alt) or a GPIO and a logic analyzer | X | ● | |
| `pm.state.<s>` | Residency and entries per power state | %, /s | `CONFIG_PM_STATS`: per CPU and state, entry count plus last and total residency in 32-bit cycles (wraps; the agent takes deltas), read through the STATS subsystem | H | ● | ○ |

### 3.4 Interrupts

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `irq.rate` | ISR entries per second | /s | trace, or agent hook counter | T | ● | ○ |
| `irq.<n>.rate`, `.dur` | Per-IRQ rate and duration (min, avg, p99, max) | /s, us | needs the IRQ number: stock CTF has none (PLANS.md 2.4), so a custom hook (IPSR on Cortex-M, active-IRQ read in the GIC path on Cortex-A/R) | T | ● | |
| `irq.nest_max` | Maximum nesting depth | count | trace | T | ○ | |
| `irq.to_thread` | ISR exit to the woken thread running | us | trace | T | ● | ○ |
| `irq.hw_lat` | Pin edge to ISR entry | us | GPIO toggle plus logic analyzer, or timer capture | X | ● | |
| `irq.spurious` | Spurious interrupts | count | fatal reason `K_ERR_SPURIOUS_IRQ` | E | ○ | ● |

### 3.5 Memory

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `stack.<t>.size`, `.used`, `.hwm`, `.margin` | Thread stack size, current, watermark, margin | B, % | `k_thread_stack_space_get()` (needs `THREAD_STACK_INFO` and `INIT_STACKS`), every Nth heartbeat | H | ● | ● |
| `stack.isr.<cpu>` | Interrupt stack watermark | B | fill-pattern scan of the ISR stack, as Thread Analyzer does | H | ● | ● |
| `heap.<h>.alloc`, `.free`, `.max` | Heap allocated, free, max allocated | B | `sys_heap_runtime_stats_get()` (`CONFIG_SYS_HEAP_RUNTIME_STATS`) | H | ● | ● |
| `heap.<h>.fail` | Allocation failures | count | agent wrapper (`HEAP_LISTENER_ALLOC_DEFINE` reports allocations and frees, not failures) | H | ● | ● |
| `heap.<h>.largest_free` | Largest free block; with `.free` it gives fragmentation | B | `sys_heap_get_largest_free_block()` (`CONFIG_SYS_HEAP_RUNTIME_STATS`) | H | ○ | ● |
| `slab.<s>.used`, `.max` | Slab blocks used, peak | blocks | `k_mem_slab_num_used_get()`, `k_mem_slab_max_used_get()`; the peak stays 0 without `CONFIG_MEM_SLAB_TRACE_MAX_UTILIZATION` | H | ● | ● |
| `log.buf` | Deferred log buffer use and peak | B | `log_mem_get_usage()`, `log_mem_get_max_usage()` (`CONFIG_LOG_MEM_UTILIZATION`) | H | ● | ○ |
| `mem.static.<module>` | ROM and RAM by module | B | `west build -t rom_report` / `ram_report` | B | ○ | ● |
| `mem.fault` | MPU / MMU access faults | count | fatal error record | E | ● | ● |
| `heap.<h>.map` | Allocator map: every live block's address, size, allocating thread and call site | chunks | zprof wraps `k_malloc`, `k_free`, `k_heap_alloc`, `k_heap_free` at link time (`-Wl,--wrap`) and emits each call; sizes from `sys_heap_usable_size()`. Stock CTF is not enough at a915b2f1: `heap_alloc_exit` carries the pointer but no size, and `heap_free` carries neither | T | ● | ○ |
| `heap.<h>.growth.<owner>` | Live bytes per allocating thread, OLS slope | B/s | derived from the map | D | ● | ● |
| `mem.layout` | RAM regions and sections with addresses | B | devicetree memory nodes plus the linker map | B | ● | ○ |

### 3.6 Kernel objects and queues

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `msgq.<q>.used`, `.max`, `.peak` | Message queue depth, capacity, peak | msgs | `k_msgq_num_used_get()`, `k_msgq_get_attrs()`; peak tracked by the agent | H | ● | ● |
| `msgq.<q>.fail` | Put failures (full) | count | application wrapper or trace | T | ● | ● |
| `timer.<t>.overrun` | Expiries not consumed in time | count | `k_timer_status_get()` returning more than 1 | H | ● | ● |
| `work.<q>.lat` | Work item submit-to-start latency and backlog | us, count | trace only: CTF has work, delayable and work-queue events; there is no pending-count API | T | ● | |
| `sem.<s>.count` | Semaphore count | count | `k_sem_count_get()` | H | ○ | |
| `stats.<group>.<ctr>` | Zephyr STATS counters (drivers, net, CAN, PM) | count | `CONFIG_STATS`; `stats_group_walk()` and `stats_walk()` enumerate every group and counter (names need `CONFIG_STATS_NAMES`) | H | ○ | ● |
| `obj.<type>.<obj>` | Threads, CPUs, system, slabs and memory blocks through one interface | mixed | `CONFIG_OBJ_CORE_STATS`, `k_obj_core_stats_query()`, `k_obj_type_walk_unlocked()` | H | ○ | ○ |
| `obj.<o>.calls`, `.blocks` | Calls and blocking calls per object | /s | CTF object events, present at a915b2f1 for `semaphore_*`, `mutex_*`, `msgq_*` (each with `_blocking`), `fifo_*`, `timer_expiry_*`, `work_*`, `heap_*` | T | ● | ○ |
| `obj.<lock>.owner`, `.max_hold`, `.max_wait` | Lock holder, longest hold, longest wait | thread, us | bridge: owner from `mutex_lock_exit` (ret 0) and the switch stream; a semaphore has no owner, so for one used as a lock the holder is inferred from take / give pairs in one thread | D | ● | ○ |
| `sched.<t>.inversion_us` | Time medium-priority threads ran while `t` waited on a lower-priority holder | us | bridge: blocking event, holder, switch stream; priority-inheritance boosts arrive as `thread_priority_set` (`adjust_owner_prio()` in `kernel/mutex.c`) | D | ● | ● |
| `sched.<t>.blocked_us` | Worst lock wait of one job | us | same | D | ● | ○ |
| `job.<t>.*` | Release, start latency, response, own execution, and the delay by cause (each ISR, each preempting thread, the lock holder, inversion) | us | bridge: release from the trigger (timer expiry, give, put), then the switch and ISR streams until completion | D | ● | ○ |
| `wq.<q>.item_us` | Longest work item | us | `work_*` events and the work-queue thread's run segments | D | ● | ○ |
| `clock.<irq>.drift_ppm` | Phase drift of a periodic IRQ against the kernel timer | ppm | bridge: OLS fit of the IRQ's phase on the timer grid | D | ○ | |

Pipes have no fill-level getter on `main`, so pipe occupancy comes from trace
(`pipe` read and write events) or an application wrapper.

### 3.7 Faults, resets and lifecycle

All of these are Event records. Records raised by a fatal path are written to
retained / no-init RAM and reported on the next boot.

| ID | Parameter | Source | Dev | QA |
|---|---|---|---|---|
| `reset.cause` | Reset cause flags: pin, software, brownout, POR, watchdog, debug, security, low-power wake, CPU lockup, parity, PLL, clock, hardware, user, temperature, bootloader, flash | `hwinfo_get_reset_cause()`. No Zynq hwinfo driver on `main`: on Zynq-7000 the agent reads `slcr.REBOOT_STATUS` (UG585) itself | ● | ● |
| `fault.fatal` | Reason (`K_ERR_*`, plus `K_ERR_ARM_*` detail codes on ARM), faulting thread, PC, LR, SP, fault status registers (CFSR/HFSR/MMFAR/BFAR on Cortex-M; DFSR/DFAR/IFSR/IFAR on Cortex-A/R) | override the weak `k_sys_fatal_error_handler(unsigned int reason, const struct arch_esf *esf)` | ● | ● |
| `fault.coredump` | Coredump present, size, decoded backtrace | `CONFIG_DEBUG_COREDUMP` with the flash-partition backend, `coredump_query()`; host decode with `scripts/coredump/coredump_gdbserver.py`. Supported on Cortex-M, ARM64, x86, RISC-V, Xtensa; **not on AArch32 Cortex-A/R** | ● | ● |
| `fault.assert` | Assertion file and line | `CONFIG_ASSERT`; override the weak `zassert_post_action(file, line)` (noreturn). It replaced `assert_post_action()` after v4.4 | ● | ● |
| `fault.stack` | Stack overflow detected | `K_ERR_STACK_CHK_FAIL`; detection by `CONFIG_HW_STACK_PROTECTION` (among 32-bit ARM, Cortex-M only), `CONFIG_STACK_CANARIES` or `CONFIG_STACK_SENTINEL` | ● | ● |
| `wdt.task` | Task watchdog channel that expired, and its thread | `task_wdt_add(reload_ms, cb, user_data)`; the `task_wdt_callback_t(channel_id, user_data)` records the event, then resets (a NULL callback resets directly) | ● | ● |
| `wdt.hw` | Hardware watchdog reset | reset cause | ○ | ● |
| `uptime.last` | Uptime just before the previous reset (last gasp) | agent writes uptime to retained RAM every heartbeat | ○ | ● |
| `boot.time` | Reset to `main()`, per init level and per device | `sys_trace_sys_init_enter/exit()` wrap every SYS_INIT and device init (CTF emits `sys_init_enter/exit` with name, level, result); devices initialized later through `device_init()` are not traced | ● | ○ |
| `hang` | Heartbeat silent while the link is alive and no reset happened | bridge | ● | ● |
| `log.err`, `log.wrn` | Log messages per second at ERR and WRN | agent log backend that counts by level | ● | ● |
| `log.drop` | Dropped log messages | no public getter; the zprof counting backend receives them through the backend `dropped()` callback | ○ | ● |
| `deadline.miss` | Span exceeded its budget | span records (3.10) | ● | ● |

### 3.8 Peripherals and communication

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `uart.<n>.err` | Overrun, parity, framing, break, collision, noise | count | `uart_err_check()` flags (`-ENOSYS` where a driver lacks it; `uart_xlnx_ps` has it) | H | ○ | ● |
| `can.<n>.err` | TX/RX error counters, state, bus-off count; bit / stuff / CRC / form / ACK errors, RX overruns | count | `can_get_state()`, `can_stats_get_*()` (`CONFIG_CAN_STATS`) | H | ○ | ● |
| `net.*` | RX/TX bytes and packets, errors, drops, TCP retransmits | count, B | `CONFIG_NET_STATISTICS` and `_USER_API`, `net_mgmt(NET_REQUEST_STATS_GET_ALL)`; Ethernet MAC counters via `_ETHERNET` | H | ○ | ● |
| `net.pkt_lat` | Per-packet TX / RX latency through the stack | us | `CONFIG_NET_PKT_TXTIME_STATS`, `_RXTIME_STATS` (need `NET_PKT_TIMESTAMP`; `_DETAIL` enlarges every packet) | H | ● | ○ |
| `bus.<dev>.err` | I2C NACK, SPI and flash timeouts, retries | count | no generic API: driver STATS groups or application wrappers. On the N6 the per-block flags are in the SVD: `SPI_SR` `OVR`, `UDR`, `CRCE`, `MODF`, `TIFRE`; `I2C_ISR` `NACKF`, `BERR`, `ARLO`, `OVR`, `PECERR`, `TIMEOUT`. Count them on the driver's error path; sampling the status register misses flags the ISR already cleared | H | ○ | ● |
| `usb.event` | Bus reset, suspend, enumeration | event | USB device stack callbacks | E | ○ | ● |
| `dma.<ch>.err` | DMA error completions | count | DMA callback status; on the N6 the cause from `HPDMA_CxSR` / `GPDMA_CxSR`: `DTEF` transfer error, `ULEF` link update error, `USEF` user setting error, `TOF` timeout | H | ○ | ● |

### 3.9 Power, clocks and environment

| ID | Parameter | Unit | Source | Class | Dev | QA |
|---|---|---|---|---|---|---|
| `pm.device.<d>` | Device runtime PM state and usage count | enum | `pm_device_runtime_usage()` (`CONFIG_PM_DEVICE_RUNTIME`) | H | ○ | |
| `clk.cpu` | CPU clock | Hz | hello, or `clock_control_get_rate()` on change | S/H | ○ | ○ |
| `env.die` | Die temperature | C | `SENSOR_CHAN_DIE_TEMP` where the SoC has a driver; `main` has none for either target (no XADC / SYSMON / AMS for Zynq, no STM32N6 digital temperature sensor). On the N6 the agent reads the DTS itself (`DTS_TS0SDIFDATAR`, `DTS_TS1SDIFDATAR`; conversion per RM0486 33), and its alarm interrupt becomes an Event | H | ● | ● |
| `env.rail.<n>` | Supply voltages | V | ADC or SoC system monitor. On the N6, out-of-range flags from PWR: `PWR_CR3` `VCOREL` / `VCOREH`, `PWR_CR2` `PVDO`, `PWR_BDCR1` `VBATL` / `VBATH` / `TEMPL` / `TEMPH`, `PWR_SVMCR1..3` ready flags | H | ○ | ● |
| `env.chamber` | Chamber temperature and humidity | C, %RH | chamber controller | X | ○ | ● |
| `pwr.*` | Supply current, power, energy per operation | A, W, J | power analyzer | X | ● | ● |

### 3.10 Application metrics (zprof registry)

Declared in the application's `zprof_metrics.def` (PLANS.md section 4). This
spec adds spans, states and marks to the registry kinds.

| Kind | Declares | Shown as | Dev | QA |
|---|---|---|---|---|
| Counter | `ZPROF_METRIC(rx_bytes, ZPROF_COUNTER)` | rate line, KPI | ● | ● |
| Gauge | `ZPROF_METRIC(batt_mv, ZPROF_GAUGE)` | line, bullet | ● | ● |
| Timer | `ZPROF_METRIC(radio_on, ZPROF_TIMER)` | duty cycle % | ● | ○ |
| **Span** (new) | `ZPROF_SPAN(ctrl_loop, 500)`: name and budget in us; `ZPROF_SPAN_BEGIN/END()` in code | latency histogram, p50/p99/max, misses; intervals on the timeline when tracing | ● | ● |
| **State** (new) | `ZPROF_STATE(link_fsm, IDLE, SCAN, CONN)` | its own timeline lane | ● | ○ |
| **Mark** (new) | `ZPROF_MARK(id)` | instant on the timeline, count | ● | ○ |
| **Param** (new) | `ZPROF_PARAM(ctrl_kp, F32, 0, 0.3, 0.005, "%/rpm", ctrl_loop)`: type, range, step, unit, owning thread | Watch & Tune row; each change is a trace event | ● | ○ |
| **Watch** (new) | `ZPROF_WATCH(plant_speed, F32)`: sampled by its owner into the watch block, stamped in target time | scope, watch list | ● | |

Without tracing, spans aggregate on target into log2 histogram buckets per
heartbeat (16 buckets cover 1 us to 32 ms), so QA gets percentiles at 1 Hz for
weeks without streaming a trace.

### 3.11 Function profile (Phase D)

| ID | Parameter | Source | Dev | QA |
|---|---|---|---|---|
| `fn.<f>.self`, `.total` | Self and inclusive share of busy time | instrumentation subsystem (statistical mode) or instruction trace | ● | ○ |
| `fn.<f>.calls`, `.avg`, `.max` | Calls per second, time per call | instrumentation (callgraph mode) | ● | |
| `fn.path` | Call paths with sample counts (flame graph) | same | ● | |
| `fn.overhead` | Instrumented build cost vs the release build | A/B run of the same scenario | ● | ○ |
| `fn.sampled` | Timer-driven stack samples (no instrumented build) | `CONFIG_PROFILING_PERF`, `perf record` shell command: RISC-V, Cortex-M, x86, ARM64 with frame pointers; not AArch32 Cortex-A/R | ● | |
| `pmu.*` | Cycle, cache and branch counters | ARM64 PMUv3 API (`CONFIG_ARM64_PMUV3`, `pmu_counter_read()`); nothing for AArch32 | ○ | |

### 3.12 Build and test artifacts

| ID | Parameter | Source | Dev | QA |
|---|---|---|---|---|
| `build.rom`, `.ram` | Totals and by module, versus budget | `west build -t rom_report` / `ram_report` write `rom.json` / `ram.json` (symbol tree with sizes, `total_size`) | ○ | ● |
| `build.kconfig` | Kconfig differences between two builds | `.config` diff | ○ | ● |
| `build.stack_static` | Worst-case stack per function | GCC `-fstack-usage` output (Zephyr option *unverified*) | ○ | ○ |
| `test.<suite>` | Status per suite and case, execution and build time, `used_ram`, `used_rom` | `twister.json` (also JUnit XML) | ○ | ● |
| `test.coverage` | Line and branch coverage | `CONFIG_COVERAGE_GCOV` dumped over the console, twister `--coverage`; boards opt in and no AMD/Xilinx board does yet | | ● |

### 3.13 Run and test session

| ID | Parameter | Source | QA |
|---|---|---|---|
| `run.elapsed`, `.target` | Elapsed and planned duration, progress | host | ● |
| `run.phase` | Test-plan step, chamber segment, stimulus | host, chamber | ● |
| `run.criteria` | Each pass criterion with limit, worst value, where, status | thresholds file (section 7) | ● |
| `run.verdict` | PASS / WARN / FAIL, live while running | derived | ● |
| `run.notes` | Operator annotations pinned to time | UI | ● |

## 4. Derived metrics

Computed once in the bridge (PLANS.md section 5) so the dashboard, the CLI and
the run report agree.

**Failure classification.** Every reset or stop is one of: planned (commanded
by the test plan), unplanned failure (watchdog, fatal error, assert, brownout,
lockup, hang), or not a DUT event (telemetry gap with the target still
running, detected by uptime continuity). Only unplanned failures count toward
MTBF. A hang followed by its watchdog reset counts once.

**Hang detection.** No heartbeat for 3 periods while the link is alive (RTT
control block still readable, or other channels arriving) and no boot-count
change. If the link is also dead, the state is "unknown" until the next hello
resolves it: a new boot count means reset, the same count with continued
uptime means a link gap.

**MTBF with confidence.** With total device-hours T and r unplanned failures in
a time-terminated test, the one-sided lower bound at confidence C is
`MTBF_L = 2T / chi2(C; 2r + 2)`. Zero failures demonstrate a target MTBF only
after `T = MTBF_target * ln(1 / (1 - C))` device-hours: 2,303 h for 1,000 h at
90%. The Soak view shows both the point estimate T / r and the bound.

**Leak detection.** Ordinary least squares on `heap.<h>.alloc` (or slab used)
against time since the last reset, after a warm-up hour. Report the slope in
bytes per hour with a 95% interval, and time to exhaustion
`(size - current) / slope`. Fail when the whole interval is above the limit;
warn when the point estimate is. Windows shorter than the criterion's
`minWindowHours` (default 8 h) are reported as not evaluable rather than as a
noisy slope (the mockup shows why: a 3 h window after a reset produced a false
179 B/h).

**Stack margin.** `1 - watermark / size`, minimum over the run per thread.
Watermarks only grow, so this is monotone; any increase after the first hour
is itself worth flagging (a new code path reached).

**Percentiles.** Spans and latencies report p50, p99, p99.9 and max per
window. Long runs keep per-window histograms, not raw values, so percentiles
merge exactly across windows.

**Build comparison.** Same board, same scenario, same zprof configuration.
Each metric gets a delta and a status from the thresholds file. Distributions
compare by percentiles; a regression needs both a threshold breach and enough
samples.

**Observer effect.** `agent.self` plus the trace share of the link are shown
next to every CPU figure. A comparison between runs with different agent
configurations is flagged as not comparable.

## 5. Views

All views share the header. Layouts are Sferic `Dashboard` grids (section 9).
The mockup implements the views marked "yes" in section 1.3.

### 5.1 Common header

Brand and breadcrumb (rail group / view); target identity (board, firmware
version and SHA, Zephyr version, build ID); link status pill (transport,
throughput, utilization, loss) colored by status; theme toggle. The rail
carries the alarm count as a badge on Insights.

### 5.2 Engineering: Live

Grid 4 columns by 4 rows.

| Row | Panels |
|---|---|
| 0 | KPI strip: CPU load, interrupts/s, context switches/s, key span p99, deadline misses, minimum stack margin, heap, telemetry link, agent self-cost, uptime and reset cause |
| 1 | Scheduler timeline, full width: one lane per IRQ and per thread; running bars in the thread color, thin bars for ready (waiting for CPU), instant markers for deadline misses and overruns. Live 200 ms window; zoom or pan freezes it, double-click resumes |
| 2 | CPU by thread as stacked bands with ISR at the bottom (30 s) / scheduler activity: switches/s, IRQs/s, link utilization / span latency histogram with budget and p99 lines |
| 3 | Thread table (priority, state, CPU %, run avg/peak, wake p99, switches/s, stack, watermark) / stack headroom bullets / memory, queues and link buffers bullets |

### 5.3 Engineering: Trace

The vertical sequence trace (section 13.1) over a snapshot of the recording or
the live tail, beside the selected job's response anatomy, a plain-language
account of where its time went with the fix to try when a registered parameter
offers one, and the event log of the visible window. Find steps through deadline
misses, priority inversions, lock waits, cooperative work items, parameter
changes and heap failures. Opened from an insight, a raster column, a worst
job, or a soak failure with the flight-recorder window loaded. Not mocked yet:
range selection statistics and registry span lanes.

### 5.4 Engineering: Profile

| Row | Panels |
|---|---|
| 0 | KPI strip: profile source (statistical instrumentation or instruction trace), busy samples, window, busy CPU cross-check against the heartbeat, top function, instrumentation cost, symbolized share, build ID |
| 1 | Flame graph, root on top, colored by module; wheel zooms into a frame |
| 2 | Hot functions table (self %, total %, calls/s, time per call) / self time by module |

### 5.5 Engineering: Boot (spec only)

A timeline from reset to the first heartbeat: pre-kernel, each init level and
each device init, `main()`, first thread activations. Plus the reset cause and
`uptime.last` of the previous boot.

### 5.6 Reliability: Soak run

Grid 4 columns by 4 rows; all time axes share one interval (zooming one zooms
all), so events line up with chamber phases and trends.

| Row | Panels |
|---|---|
| 0 | KPI strip: verdict, elapsed with progress, DUT count and device-hours, unplanned resets by cause, MTBF lower bound, worst heap trend with time to exhaustion, minimum stack margin, worst span p99, telemetry loss, chamber state |
| 1 | Run timeline: a chamber-phase lane, then per DUT an uptime ribbon broken by resets, with gaps, hangs and instant fault markers (hover for the fault detail) / pass criteria table with result, worst value, limit and where |
| 2 | Heap per DUT with the leak fit and its 95% band projected to exhaustion / chamber and die temperatures / span p99 per DUT with the budget line |
| 3 | DUT fleet table (status, uptime, unplanned resets, heap slope, minimum stack, CPU p95, p99, die max, link loss) / unplanned resets by cause / fault signatures grouped across DUTs with count, first and last occurrence and context |

The synthetic run in the mockup tells a story the layout must make obvious:
the storage task-watchdog resets on DUT-03 all fall in cold dwells; DUT-05
leaks 178 B/h; DUT-08 hangs on a lock, then takes a hardware watchdog reset;
DUT-02's telemetry gaps are not counted as failures.

### 5.7 Reliability: Fleet

In the mockup the fleet is a table inside Soak run. A rack of more than about
16 DUTs gets its own view: the same table plus a DUT x hour heatmap of event
counts.

### 5.8 Reliability: Build compare

| Row | Panels |
|---|---|
| 0 | KPI strip: regression gate (BLOCK / REVIEW / PASS from the tiles below), ROM, RAM, busy CPU, key span p99, minimum stack margin, tests, coverage |
| 1 | ROM by module A vs B / CPU by thread A vs B / latency distributions as box plots A vs B |
| 2 | Test suites from `twister.json`, A vs B with duration change / Kconfig differences with impact notes |

### 5.9 Reliability: Fault detail (spec only)

One failure: decoded fault record (registers, faulting thread and symbolized
PC/LR), coredump backtrace, the last 30 s of trace from the flight recorder in
an embedded timeline, the heartbeats before it, chamber and rail values at the
time, and every other occurrence of the same signature.

### 5.10 Engineering: Timing

KPI strip (period, start-latency p99, response p50 and p99, misses, inversions,
worst lock wait, cooperative work delay) / scheduling eye and period raster
(13.3, 13.4) folded on the control period, the SPI period or 2 ms, with a
settable ghost baseline / jitter constellation (13.5) / anatomy of the ten
worst jobs (13.2). Every job and raster column opens the Trace.

### 5.11 Engineering: Objects

Kernel object flow graph (13.6) / kernel calls of the last 10 s as a sunburst,
object type to object to call / object inspector table (state, peak,
waiters, calls and blocks per second, worst wait, longest hold).

### 5.12 Engineering: Memory

KPI strip (static RAM, heap use and peak, largest free run, fragmentation,
leak slope with time to exhaustion, failed allocations, minimum stack margin,
RTT buffer peak) / RAM floor plan (13.7) / heap X-ray by owner or by age
(13.8) / heap by owner, stacked, with the largest free run / leak cone (13.9).

### 5.13 Engineering: Headroom 3D

The headroom landscape (13.10) with camera presets, beside a table ranking
every resource by threshold units.

### 5.14 Debug: Watch & Tune

Left: write path (agent registry or probe), arm switch with a timeout and
"revert all", one row per registered parameter (current value, slider, range,
safe point, request state with timings), the watch list, and the audit trail.
Right: KPI strip (speed, last overshoot and settling, gains, ctrl_loop p99,
misses) / triggered scope with persistence (13.12) / step metrics per setpoint
step / ctrl_loop response box plots before and after the last change.

### 5.15 Reliability: Thermal helix

The thermal helix (13.11) with presets (helix, phase dial, time) and a choice
of radius metric, beside failures by chamber phase with a binomial test, and
the event list ordered by phase.

### 5.16 Intelligence: Insights

Cards ranked by severity (13.13): title, explanation, evidence with numbers and
the rule that set the severity, a trend, links to the evidence, and "Try" for a
registered fix. Counts appear as the rail badge on every view.

### 5.17 Coverage check

Every catalog domain has a home: identity (header, hello), link (header, KPI,
Live, Insights), CPU and scheduling (Live, Trace, Timing, Headroom 3D),
interrupts (Live timeline, Trace, Timing), memory (Live bullets, Memory, Soak
trends, Compare), kernel objects (Objects, Trace, Live bullets), faults (Soak,
Thermal helix, Fault detail), peripherals (Fleet columns, Fault detail; a
peripherals panel is added when a project registers them), environment (Soak,
Thermal helix), application metrics and parameters (KPI, histogram, timeline
lanes, Watch & Tune), function profile (Profile), build and test (Compare),
session (Soak).

## 6. Interaction

- One time cursor per view, linked across panels with the same time base
  (Sferic `synchronizeCursors`), and one shared X interval in Soak
  (`synchronizeAxisIntervals`).
- **Pause.** Live views scroll until paused. Pause (button on the timeline, or
  Space) freezes every live panel at once while the target and the recording
  keep running. Zoom or pan on any live chart also pauses. The panels stop
  ingesting, so nothing scrolls or is evicted from under the user; the frozen
  window keeps everything the timeline held (12 s in the mockup) for zooming
  and hovering. The title shows how far live has moved ahead. Resume (button,
  Space, or double-click on a chart) rebuilds the timeline from the retained
  log and backfills the missed heartbeats. A pause longer than the retained
  log leaves a gap, which the recording (section 8.3) fills on replay.
- Hover always answers "what is this, from which source, at what time":
  provenance tag on KPI tiles, cursor tables on series, fault text on markers.
- Every event marker links to the Fault detail view; every fault detail links
  to the Trace view at that moment.
- **Deep links.** A view can hand another a focus (a time, a job, a parameter
  to stage). Insight links, raster columns, worst-job rows and object nodes all
  land on the evidence; a time without a job selects the job running then.
- **Suggestions are staged, never sent.** "Try" buttons open Watch & Tune with
  the value filled in and highlighted; sending needs the arm switch and Apply
  (section 14).
- Export: PNG of any view (`saveToFile`), CSV of any panel, Perfetto JSON of a
  time range, and a run report (Markdown or HTML) with criteria, verdict,
  evidence links and the build and Kconfig identity.
- Annotations: free text pinned to a time, saved with the recording and
  printed in the report.

## 7. Thresholds and alarms

### 7.1 Status rendering

Five levels: ok, warn, crit, info, idle. Status is always color **and** shape
(ok circle, warn triangle, crit square, info diamond, idle ring) so it survives
color-vision deficiency and grayscale printing.

### 7.2 The thresholds file

All limits live in one file, `config/zprof.thresholds.json`, validated by
`config/zprof.thresholds.schema.json` (JSON Schema 2020-12). The repo copy
holds the defaults; a project copies it next to its firmware and edits it.
The bridge, the dashboard and the run report read the same file, so a pass
criterion is defined exactly once. The defaults are deliberately not repeated
here; the file is authoritative.

Every rule has the same shape and reading: **breach when `value op
threshold`**, with `op` one of `>=`, `>`, `<=`, `<` and optional `warn` and
`crit` thresholds (at least one). `metric` is a catalog ID from section 3; `*`
matches one instance segment (`stack.*.margin`), and the most specific rule
wins.

| Section | Used for | Extra fields | Outcome |
|---|---|---|---|
| `live` | KPI tiles, bullet zones, table colors | `unit` | ok / warn / crit |
| `criteria` | Run pass criteria (Soak, report) | `id`, `title`, `agg` (`count`, `max`, `min`, `last`, `slope`), `per` (`run`, `dut`: worst DUT wins); for slopes `judge`, `confidence`, `warmupHours`, `minWindowHours` | PASS / WARN / FAIL per criterion |
| `gate` | Build compare | `mode` (`absolute`, `delta`, `delta_pct` vs the baseline build) | PASS / REVIEW / BLOCK |

Evaluation rules:

- A crit breach is FAIL (criteria) or BLOCK (gate); a warn breach is WARN or
  REVIEW.
- Slope criteria with `judge: "interval"` FAIL only when the whole confidence
  interval breaches, and WARN when the point estimate does (section 4).
- A criterion whose metric was not measured, or whose window is too short, is
  **n/a**, never PASS. A run verdict is PASS only when every criterion was
  evaluated and passed; otherwise it is FAIL, WARN or INCOMPLETE.
- Bullet zones convert rules to "used" units: a margin rule (`<=` 25%) becomes
  a use threshold of 75% of capacity, and a peak rule (`>=` 75%) stays 75%.
- Span budgets declared in firmware (`ZPROF_SPAN(name, budget_us)`) are what
  the target counts misses against. A criterion may be stricter than the
  budget; that is intentional.

The live section also covers the hybrid views: `fifo.*.peak_pct`,
`heap.*.frag_pct`, `heap.*.growth`, `heap.*.failures`, `sched.*.inversion_us`,
`sched.*.blocked_us`, `wq.*.item_us`, `irq.*.per_s`, and the application's own
`ctrl.overshoot_pct` and `ctrl.settle_ms`.

**Threshold units** put every rule on one scale, for the 3D landscape and the
Headroom ranking: 0 to 1 below warn, 1 to 2 from warn to crit, 2 to 3 past
crit (capped). Margin rules are measured as the share used. A rule with only
crit takes warn at 75% of it; one with only warn takes crit at 133%.

## 8. Non-functional requirements

### 8.1 Latency and rendering

- Heartbeat to screen under 100 ms at 10 Hz.
- 60 fps with the live timeline scrolling; under 16 ms per frame with 10^6
  intervals resident (PLANS.md Phase A exit criterion).
- No layout jank when values change width: tiles and tables have fixed column
  widths.

### 8.2 Rates

| Mode | Heartbeat | Trace | Stack scan |
|---|---|---|---|
| Bench (Engineering) | 10 Hz | on | every 10th heartbeat |
| Soak (Reliability) | 1 Hz | off, or flight recorder only | every 60th heartbeat |

### 8.3 Storage and retention

- Raw frames go to the recording file (PLANS.md section 5); everything is
  replayable.
- Downsampled tiers per metric: 1 s, 10 s, 1 min, 10 min, each keeping min,
  max, mean and count (histograms for spans). A view picks the tier from its
  visible range. The soak mockup uses the 1 min tier.
- Budget: about 450 B per heartbeat is 39 MB per DUT-day at 1 Hz raw, before
  compression. Eight DUTs for 7 days is about 2.2 GB raw.

### 8.4 Flight recorder

The bridge keeps the last 30 s of trace and 10 min of heartbeats per DUT in
memory. On any Event of class fault, reset, hang or criterion breach it
persists that window and links it from the event. Trace streaming must
therefore stay cheap enough to leave on during soak, which RTT allows
(PLANS.md section 8).

## 9. Sferic mapping

| Panel | Sferic component | New? |
|---|---|---|
| KPI strip | `KpiStrip` (Panel subclass; sparklines via `SegmentBatch`) | **new** |
| Scheduler timeline, soak run timeline | `IntervalSeries` on `ChartXY` (`RectBatch`, lane axis from custom ticks and bands) | **new** |
| Flame graph | `IntervalSeries` with labels, lanes as depth | **new** (same series) |
| Stack, memory, queue headroom | `BulletChart` (Panel subclass; bars via `RectBatch`) | **new** |
| CPU by thread | `addAreaRangeSeries` stacked bands, scrolling `Time` axis | existing |
| Rates, trends | `addLineSeries`, second Y axis, constant lines | existing |
| Span histogram | `addRectangleSeries`, constant lines for budget and p99 | existing |
| Thread, fleet, criteria, faults, tests, Kconfig tables | `DataGrid` with bar cells, `PalettedFill` LUT columns | existing |
| Resets by cause | `Pie` (donut) | existing |
| Footprint, CPU A vs B, self time by module | `BarChart` grouped and horizontal | existing |
| Latency A vs B | `addBoxSeries` | existing |
| Linked time axes | `synchronizeAxisIntervals` | existing |
| Vertical sequence trace | `SequenceTrace` (Panel; `RectBatch` spans and label boxes, `SegmentBatch` arrows, leader lines and lifelines) | **new** |
| Response anatomy | `AnatomyChart` (Panel; stacked `RectBatch` bars, hatched segments) | **new** |
| Scheduling eye, period raster | `PhaseEye` (`RectBatch` cells, `SegmentBatch` profiles) and `PeriodRaster` (ring `HeatmapTexture`, categorical LUT), sharing one `PhaseFolder` | **new** |
| Jitter constellation | `addPointSeries` per cause, shape and color | existing |
| Kernel object flow | `FlowGraph` (Panel; bezier `SegmentBatch` edges, `RectBatch` nodes, glowing particles) | **new** |
| Call breakdown | `SunburstChart` | existing |
| RAM floor plan | `AddressMap` (Panel) | **new** |
| Heap X-ray | `HeapXRay` (Panel; static `HeatmapTexture` on a Hilbert layout, glowing path for the largest free run) | **new** |
| Headroom landscape, thermal helix | `Chart3D`: `SurfaceGridSeries3D` ribbons and planes, `LineSeries3D`, `PointSeries3D`; camera presets through `setCameraLocation`; a lane tick strategy | existing, plus `LaneTicks` |
| Scope with persistence | `addLineSeries` sweeps; constant lines and custom ticks mark parameter changes | existing |
| Rail, tunables, audit trail, insight cards | DOM, themed by the same CSS tokens | n/a |

### 9.1 New components

**IntervalSeries** (`web/src/charts/IntervalSeries.ts`). Lanes of `[t0, t1)`
intervals plus instants (`t1 == t0`, drawn at least 2 px wide). Per-lane typed
arrays sorted by start, eviction by a retention window, binary-search culling
(with the lane's longest interval as look-back), and a level-of-detail merge
that folds runs of sub-pixel intervals into one rect per pixel. States carry a
color and an optional bar height (thin "ready" bars). Picking is per lane by
binary search. Optional labels inside wide intervals turn it into a flame
graph. Cursor rows are customizable.

**KpiStrip**. Tiles with label, value and unit, a context line, status color
and glyph, an optional GPU sparkline with glow, an optional progress bar, and
a provenance tag on hover. Wraps to more rows when narrow.

**BulletChart**. One row per resource: track, warn and crit zones, current
value bar colored by status, and a tick at the high-water mark. Status follows
the high-water mark, because that is what overflows. Optional group headings.

**SequenceTrace**. Time runs down; lanes are columns (ISRs, threads by
priority, kernel objects as dashed lifelines). Spans are run, ready, ISR and
"blocked on a lock" states; object lanes show lock ownership in the holder's
color, or queue and semaphore fill as width. Arrows run across lanes at the
instant of a give, put or unlock, and on to the woken thread when it resumes.
The event field keeps the most important annotations that fit (deadline
misses, parameter changes and lock waits first), lays them out top-down with
collision avoidance, and ties each to its instant with an elbow leader line.
Wheel scrolls, Ctrl+wheel zooms at the pointer, drag pans. It reads a
`SeqSource` that answers one window at a time, so a live ring and a frozen
recording look the same to it.

**AnatomyChart**. One stacked bar per job, own execution first, then each
preempting thread, each ISR, the lock holder (hatched) and inversion (hatched,
crit color); a deadline line makes the segment that crossed it obvious.

**PhaseFolder, PhaseEye, PeriodRaster**. The folder cuts every interval at
period boundaries and accumulates occupancy by phase bin per lane, with an
exponential average over about 800 periods; a period is finalized once no more
intervals can arrive for it. The eye draws occupancy as phosphor intensity plus
a profile curve per lane, and an optional ghost baseline. The raster keeps one
column per period in a ring texture, colored by the lane that held each bin.

**FlowGraph**. Fixed normalized node positions, cubic edges entering and
leaving on the facing sides, particles at a thinned rate with the true rate
printed mid-edge, live node state (fill gauge, text, priority tag including an
inherited priority), and pulsing alarms on nodes and edges.

**AddressMap**. Regions in address order with one bytes-to-pixels scale for
every row; free runs over 4 KiB fold to a fixed width with a break mark; live
use as a fill, high-water as a tick, MPU attribute windows as brackets.

**HeapXRay**. Chunk index to a 64 x 64 Hilbert curve, so a contiguous run is a
compact blob. Colored by allocating thread or by log age; the largest free run
traced along the curve with glow; hover gives address, owner, size and age.

### 9.2 Upstreaming to Sferic

The mockup consumes Sferic from source (`../lightning/src`) because the new
components use internals (`SeriesXY`, `RectBatch`, `SegmentBatch`,
`attachSeries`). Moving them into the library means:

- `IntervalSeries` should orphan its instance buffer with `bufferData` instead
  of rebuilding a `RectBatch` that updates with `bufferSubData`, per the
  lightning invariant on in-flight buffers; and gain a precomputed LOD pyramid
  so a fully zoomed-out 10^6-interval lane does not walk every interval each
  frame.
- A public `chart.addIntervalSeries()` and `dashboard.createKpiStrip()` /
  `createBulletChart()`, gallery examples, and `npm run snap` coverage in both
  themes.
- Context-loss handling is inherited from `RectBatch` and `SegmentBatch`
  (they re-upload on a new context); `npm run test:browser` should cover the
  new panels.
- The hybrid panels rebuild their batches when their view changes, and
  `FlowGraph` every frame while particles fly. Fine at mockup scale; library
  versions should orphan buffers as above.
- `HeatmapTexture`: in the period raster, NaN cells were drawn in the first LUT
  color instead of being discarded (Chrome, ANGLE on D3D11). The mockup uses a
  transparent sentinel value. Suspected cause, not verified: the shader's
  `v == v` test is folded away. Worth a minimal repro upstream.

## 10. Mockup

Location `web/` (Vite + TypeScript), served on port 8781 (allocated in the
port registry). Start with `run.cmd` at the repo root, or `npm run dev` in
`web/`. Views: `#insights` (the default), `#live`, `#trace`, `#timing`,
`#objects`, `#memory`, `#headroom`, `#profile`, `#tune`, `#soak`, `#helix`,
`#compare`; `?theme=light` for the daylight theme.

What is synthetic:

- **Target** (`web/src/sim/target.ts`): a microsecond-resolution preemptive
  scheduler with three IRQs and nine threads (one cooperative work queue) that
  run programs of kernel calls against modelled objects: semaphores, a message
  queue, a FIFO, mutexes with priority inheritance, a timer, the work queue and
  a chunk-level heap (`heap.ts`). The SPI1 bus is guarded by a k_sem, the
  deliberate bug: when net_rx preempts storage while ctrl_loop waits for the
  bus, the wait is unbounded. A rare long cooperative work item, network
  bursts and control-loop transients add the other kinds of deadline miss.
  ctrl_loop closes a PI speed loop around a two-lag motor model; a parameter
  registry with staged, safe-point application (and an A/B flag that swaps the
  bus lock for a k_mutex) answers the Watch & Tune view. The SPI DMA runs on its
  own clock, 40 ppm off. It emits intervals, kernel events, job records with
  their decomposition, watch samples and 10 Hz heartbeats as the bridge would,
  and charges the RTT link the PLANS.md byte costs (68 B per switch, 20 B per
  ISR, about 28 B per kernel call).
- **Memory map** (`memmap.ts`): N6 regions, bases and sizes from the pinned
  devicetree; the section layout inside is synthetic.
- **Insights** (`insights.ts`): the rule engine runs on the simulated streams;
  nothing in it is canned except the wording of the explanations.
- **Profile**: a fixed call tree (`web/src/sim/profile.ts`).
- **Soak**: a 72 h, 8-DUT thermal-cycling run at the 1 min tier
  (`web/src/sim/soak.ts`), starting at 52.3 h and advancing one simulated
  minute per real second; one more DUT-03 watchdog reset arrives at 55.45 h.
- **Compare**: fixed numbers for two builds.

Every status color, bullet zone, warning line and the whole Soak criteria
table come from `config/zprof.thresholds.json` (`web/src/thresholds.ts` reads
it); editing the file changes the mockup with no code change. Board, firmware
and test names are placeholders.

Verified on the mockup: `tsc --noEmit` clean; all twelve views in both themes
render in headless Chrome on the real GPU with zero page errors and zero WebGL
warnings; scripted runs exercise Trace to Watch & Tune ("Try", arm, apply,
retune Kp and Ki: overshoot falls from about 20% to about 6%), Insights to
Watch & Tune, raster to Trace, the 3D camera presets, and pause / resume in
Live.

## 11. What the platform choice changes

The two targets are a Zynq PS (part to be chosen) and the STM32N6570-DK
(MB1939C, STM32N657X0, Cortex-M55 at 800 MHz). Zephyr rows are checked at
a915b2f1. N6 hardware rows come from UM3300, RM0486 and the MB1939C schematic;
Zynq probe rows from PLANS.md section 2.6.

| Capability | STM32N6570-DK (Cortex-M55) | Zynq-7000 A9 / ZynqMP R5 (AArch32 A/R) | ZynqMP A53 (AArch64) | `native_sim` / QEMU |
|---|---|---|---|---|
| Timing functions | DWT cycle counter (*unverified*: whether CYCCNT counts while debug is closed, RM0486 78.6.2) | no arch backend: falls back to the kernel cycle counter | same fallback | host clock, not real time |
| Per-IRQ identity | IPSR, trivial | GIC active IRQ, needs a hook | GIC, needs a hook | emulated |
| Debug access while running | **closed in Flash boot** until secure-privileged code writes `BSEC_DBGCR` and `BSEC_AP_UNLOCK` (RM0486 3.9, 4.5.18); nothing in Zephyr does this | open (JTAG/DAP) | open | n/a |
| RTT link | yes once debug is open: J-Link / J-Trace on CN10 (MIPI-20), or ST-LINK via mainline OpenOCD `stlink-dap`; secure AP accesses; buffers in non-cacheable RAM | needs AHB/AXI-AP and non-cacheable buffers | not supported by SEGGER | no |
| Fast link without the debugger | USB HS device (CDC ACM), Ethernet RGMII (RTL8211F); VCP documented only at 115200 | Ethernet (GEM) | Ethernet (GEM) | pty / TCP |
| Instruction trace (zero-overhead profile) | ETM 4-bit on CN10 (TRACECLK PG7, TRACED0-3), shared with SAI1 pins that Zephyr's DT enables; SWO on PB5; J-Trace PRO supports N6 | PTM/ETM via TPIU or ETB | ETM, ETB | no |
| Sampling profiler (`CONFIG_PROFILING_PERF`) | yes: the Cortex-M backend samples from SysTick; needs `SHELL`, `CORTEX_M_SYSTICK`, `THREAD_STACK_INFO`, `ARCH_STACKWALK` (on Cortex-M that needs `EXTRA_EXCEPTION_INFO`), a Secure or non-TrustZone image (the DK's is Secure) and no SMP | **no** | yes (frame pointers) | QEMU x86, RISC-V, Cortex-M, A53: yes; `native_sim`: no |
| PMU counter API | DWT only (the ARMv8.1-M PMU is not enabled) | **none** | PMUv3 API | no |
| Coredump | yes | **no** | yes | arch-dependent |
| HW stack overflow protection | yes: PSPLIM stack guard, on by default | **no** (canaries, sentinel only) | no | no |
| Fault registers in the fatal record | CFSR, HFSR, MMFAR, BFAR | DFSR, DFAR, IFSR, IFAR | ESR, FAR | n/a |
| Reset cause (hwinfo) | yes (`hwinfo_stm32`): pin, software, IWDG, WWDG, brownout, POR, low power; the lockup flag exists but is not mapped (only STM32WB0 maps it), so the agent reads `RCC_RSR.LCKRSTF` (bit 17, ST SVD) itself | **no driver**: agent reads `slcr.REBOOT_STATUS` (7000) or the ZynqMP reset-reason register (*unverified*) | no driver | none |
| Watchdog driver | IWDG enabled (`watchdog0`); WWDG present, disabled | **no PS watchdog driver**; the AXI Timebase WDT in the PL has one | same | n/a |
| Retained RAM for the fault record | backup SRAM, 8 KB, non-cacheable (disabled by default) | OCM, to configure | to configure | n/a |
| Power-state statistics | **none** in Zephyr: `CONFIG_PM` is not available on N6. The agent can count Stop and Standby entries from `PWR_CPUCR` (`STOPF`, `SBF`, cleared with `CSSF`) | not checked | not checked | n/a |
| Die temperature, rails | **no driver** (the silicon has a digital temperature sensor, RM0486 33); ADC gives VBAT and VDDCORE. The agent reads the DTS directly (two sensors with alarm thresholds) and the PWR monitor flags (VCORE low / high, PVD, VBAT and backup-domain temperature, per-rail ready); register positions from ST's SVD | **no XADC / SYSMON driver** | no SYSMON driver | none |
| Latency oracle (zyclictest) | yes: needs `TIMER_HAS_64BIT_CYCLE_COUNTER`, which SysTick provides by default above 60 MHz | Zynq-7000 A9: yes (Arm architected timer driver on the global timer); ZynqMP R5: **no** (the PS TTC driver has no 64-bit counter) | yes (Arm architected timer) | not checked |
| On-chip trace capture | STM (software stimulus ports, hardware timestamps) and an ETR that writes the merged trace into system RAM (RM0486 78); Zephyr has the `arm,stmesp` binding, the STP decoder and the CoreSight deformatter, but no N6 STM node or ETR setup driver | ETB (see instruction trace) | ETB | no |
| gcov coverage on target | not opted in (`FORCE_COVERAGE` only) | no AMD/Xilinx board opts in | same | QEMU Cortex-A53 opts in |
| Thermal and voltage DVT | yes | yes | yes | not meaningful |

Phase B (statistics) runs anywhere. Phase A (timeline) needs a fast link. The
QA reliability views need real hardware, a reset cause, a watchdog, and a way
to power-cycle and observe the DUT that does not depend on the DUT.

What each target needs before the Reliability views are complete:

- **STM32N6570-DK:** almost all of section 3 comes from stock Zephyr. Missing:
  a die-temperature driver and power-state statistics (the agent covers both
  with direct register reads), and an opt-in to reopen debug in Flash boot. Without that opt-in, RTT and instruction trace only work
  in Development boot. The agent provides it as a Kconfig option. The bridge
  falls back to USB CDC ACM when no probe can attach.
- **Zynq PS:** the Engineering views work as planned, but about a third of the
  Reliability sources need new code first: a reset-reason reader, a PS
  watchdog driver (or the PL AXI WDT), an XADC or SYSMON driver, and the
  agent's own fatal record in retained RAM in place of a coredump.

## 12. Open questions and version notes

Resolved by the source check: fragmentation (`sys_heap_get_largest_free_block()`
exists), dropped logs (backend `dropped()` callback), init timing
(`sys_trace_sys_init_enter/exit`), STATS enumeration (`stats_group_walk()`).

Still open:

- Per-IRQ identity on Cortex-A/R: where to read the active IRQ in the GIC path
  without a second acknowledge.
- `cpu_load` backend per target: the idle-hook backend includes ISR time and
  the runtime-stats backend excludes it (Zephyr docs), so the KPI is labelled
  with its backend. Still to confirm: which backend each target's build
  selects.
- Whether `uart_err_check()` clears the error flags on read, per driver.
- Whether debugger reads and writes through the M55's AHB-AP (AP1, entering
  the core's D-AHB port) are coherent with the L1 D-cache; until known, every
  probe-visible variable lives in the NOCACHE window (section 14).
- Whether the N6 resource isolation (RIF / RISAF) blocks AP accesses to some
  SRAM in our configuration.
- Whether the M55 DWT can emit data-value trace through the ITM for exact,
  timestamped variable changes without the agent.
- Kernel-object trace volume on hardware: the mockup's model puts full object
  tracing at a median 50% and a p95 of 94% of a 2 MB/s RTT link during network
  bursts. Measure, then decide between per-class Kconfig, per-object filtering
  in the backend, and the compact format (PLANS.md section 8).
- The ZynqMP reset-reason register and its bit layout (Zynq-7000 is
  `slcr.REBOOT_STATUS`, UG585).
- Report format for QA sign-off (criteria are decided: they live in the
  thresholds file, section 7.2).
- N6 hardware questions from the observability review: STM and ETR use with
  debug closed, the STM timestamp clock, the DTS conversion, which ECC events
  reach software, RIF and probe reads, TCM sizes left by the FSBL
  ([OBSERVABILITY_AND_SVD_REVIEW.md](OBSERVABILITY_AND_SVD_REVIEW.md) section 8).

Things that changed on `main` relative to the last release, which the agent
must use as written here: the assert hook is `zassert_post_action()` (not
`assert_post_action()`), `TRACING_OBJECT_TRACKING` only selects `OBJ_CORE`
(enumerate with `k_obj_type_walk_*()`), and `tracing_packet_drop_count_get()`
is new.

## 13. Hybrid views and visualization concepts

Percepio Tracealyzer's layout was the prompt: a vertical trace whose time axis
runs down, so every kernel call can be annotated in plain horizontal text, and
a rail of analysis views beside it. This section mixes that with Sferic's GPU
paradigms (shared WebGL context, instanced rects and segments, glow, 3D) and
adds views we have not seen in an RTOS tool. Each concept names the question it
answers. Status: **mocked** (running in `web/`) or **concept**.

| # | Concept | Question it answers | Encoding | Status |
|---|---|---|---|---|
| 13.1 | Vertical sequence trace | What happened, in order, and who woke whom? | time down; lanes as columns for ISRs, threads and kernel objects (lifelines); arrows for give / put / unlock and the resume they cause; an event field of text annotations tied to their instants | mocked |
| 13.2 | Response anatomy | Why was this job late? | stacked bar: own execution, each preempting thread, each ISR, lock holder, inversion; deadline line; a generated explanation and the registered fix | mocked |
| 13.3 | Scheduling eye | Is the schedule stable within a period? | fold the trace modulo a period; per lane, the share of periods it ran at each phase, as phosphor intensity plus a profile curve; ghost baseline | mocked |
| 13.4 | Period raster | How does the schedule evolve period by period? | one column per period, phase down, colored by the lane that ran; drift is a slant, beating a moire | mocked |
| 13.5 | Jitter constellation | Are there modes, and what separates them? | per job: start latency vs response, color and shape by dominant delay, deadline line | mocked |
| 13.6 | Kernel object flow | Who talks to whom, how much, and where is it stuck? | live graph of ISRs, threads and objects; GPU particles per call at a thinned rate; true rates on edges; object state on nodes; pulsing inversion alarm | mocked |
| 13.7 | RAM floor plan | Where did the RAM go, and what is close to full? | regions in address order at one scale, free runs folded; live fill and high-water per section; MPU windows | mocked |
| 13.8 | Heap X-ray | Is the heap fragmenting, and who holds the old blocks? | every chunk on a Hilbert curve, by owner or by age; largest free run traced | mocked |
| 13.9 | Leak cone | When will this leak exhaust the heap, and how sure are we? | OLS trend of the leaking owner with its 95% band projected to the room left | mocked |
| 13.10 | Headroom landscape | What is closest to its limit, now and over the last minute? | 3D ribbons per resource over time in threshold units, warn and crit planes; front view = overlay, top = heat strip, side = envelope | mocked |
| 13.11 | Thermal helix | Do failures depend on the chamber phase? | helix per DUT, one turn per chamber cycle, color = temperature; top view = phase dial; binomial test per phase | mocked |
| 13.12 | Triggered scope | What did the control loop do, and did my change help? | sweeps triggered on setpoint steps or deadline misses, persistence of like sweeps, parameter changes marked; step metrics; before / after box plots | mocked |
| 13.13 | Insights | What should I look at first? | rules over the live streams, ranked; evidence, trend, links, registered fix | mocked |
| 13.14 | Scheduler radar | Is the hyperperiod steady at a glance (lab wall display)? | polar sweep over the hyperperiod, lanes as rings, phosphor decay | concept |
| 13.15 | Activation spectrogram | Is there periodic load I did not expect? | FFT of each thread's activation train over sliding windows | concept |
| 13.16 | Causal chain highlight | What did this interrupt lead to? | select an event; light up everything downstream (give, wake, put, get) across lanes | concept |
| 13.17 | Ghost baselines everywhere | Is this build or setting behaving like the good one? | a golden recording overlaid on histograms, eyes, constellations | concept (eye only) |
| 13.18 | Energy attribution | Which thread or job costs the energy? | a current probe's trace aligned to the schedule; energy per thread and per job; energy flame graph | concept |
| 13.19 | Differential flame graph | Where did build B get slower? | flame graph of B colored by change against A | concept |
| 13.20 | Fleet horizon charts | Which of 50 DUTs is drifting? | dense horizon bands per DUT and metric, sorted by anomaly | concept |
| 13.21 | Run fingerprints | How does this build compare across history? | radial glyph per run (each spoke a gated metric in threshold units), small multiples by commit | concept |

Notes on the mocked concepts:

- **Semantic zoom in the trace.** When annotations outnumber the rows, the
  field keeps deadline misses, parameter changes and lock waits first, says how
  many were hidden, and the event log beside it still lists everything in the
  window.
- **Inversion is computed, not guessed.** A job's lock wait is split into time
  the holder ran and time medium-priority threads ran instead (priority between
  the waiter's and the holder's base priority). The second part is inversion;
  with a k_mutex it disappears because the holder inherits the waiter's
  priority, and the trace shows the boost as a stripe on the holder's lane.
- **Rotate to read.** The 3D views are not decoration: each camera preset is a
  different 2D chart of the same data, and the toolbar says which.
- **Statistics instead of eyeballing.** The helix's clustering is backed by a
  one-sided binomial test, flagged as indicative when the events come from few
  DUTs; the leak cone carries the slope's confidence band; the drift finding is
  a fitted ppm figure.

## 14. Writing to a running target

Poking values at run time moves zprof from visualization into debugging. It is
doable on both targets, with four mechanisms that differ in what they risk:

| Mechanism | How | Firmware support | Use it for |
|---|---|---|---|
| Agent registry (default for writes) | `ZPROF_PARAM` entries; the host sends a set command on the RTT down channel (or USB / Ethernet); the agent range-checks, stages, and the owning thread applies at its safe point, then acks with target timestamps | ours | controlled changes, also in soak without a probe |
| Probe direct | J-Link background memory access while the core runs (M55: AP1, the core's AHB-AP; Zynq-7000: the AHB-AP, PLANS.md section 2.6); address and type from the ELF's DWARF | none | watching any global or static; quick pokes in development |
| Stock Zephyr | shell over RTT (`SHELL_BACKEND_RTT`), `devmem` (`DEVMEM_SHELL`, on by default with the shell), `settings` shell, MCUmgr settings group | config only | a fallback with no host code; `devmem` writes raw physical memory with no types |
| Full debugger | Ozone or GDB on the same probe; on the M55, SEGGER monitor mode (`CORTEX_M_DEBUG_MONITOR_HOOK` + `SEGGER_DEBUGMON`) halts a thread while higher-priority IRQs keep running | config only | breakpoints, locals; zprof shades halted time on the timeline instead of reinventing it. Zephyr's gdbstub is selected for Cortex-A only (its Kconfig notes it is untested on M and R) |

All the Kconfig symbols above exist at a915b2f1.

Safety rules, all implemented in the mockup:

- **Arm switch with a timeout** (120 s, renewed by each write). Disarmed, Apply
  is disabled.
- **Two range checks**: the UI and the agent. The agent's rejection is
  reported with its reason.
- **Safe points**: each parameter names the place its owner applies it (start
  of the next job, next timer expiry, next storage job with the bus idle). An
  A/B flag that swaps a lock type is only applied with no holder and no
  waiters: swapping it under a waiter would leave the waiter blocked on a lock
  nobody gives.
- **Every write is evidence**: the request, the staging and the application
  are trace events at their target times, so the scope and the Trace show
  exactly when a change took effect; the audit trail lists every request with
  its round trip.
- **Suggestions never send**: "Try" fills in and highlights the value; the
  engineer arms and applies.
- **Revert all** sends the default of every changed parameter.

Risks of the probe-direct path, which the mockup only reads through:

- **Caches.** MEM-AP accesses bypass the Zynq's caches (AN08005, PLANS.md
  section 2.6): a cached copy goes stale, and a later write-back of a dirty
  line overwrites the poke. Whether the M55's debug path is coherent with its
  L1 D-cache is not verified (section 12). Until it is, probe-visible variables
  (RTT buffers, the tunables and watch blocks) live in the NOCACHE window.
- **Compiler.** A non-volatile global may be held in a register for a whole
  loop, constant-folded, or placed in flash; a poke then does nothing, or does
  it partly. Registry entries are volatile, in their own section, read once
  per iteration.
- **Torn writes.** An aligned 32-bit write is single-copy atomic; a `double`
  or a set of related values (PID gains) is not. The registry uses a seqlock
  per entry; the probe path cannot.
- **Timestamps.** Probe reads are host-timed and cannot line up with the
  microsecond trace; agent watch samples carry target time.
- **Access on the N6.** AP1 needs debug opened through BSEC in Flash boot
  (section 11), and resource isolation may block some SRAM (section 12).
