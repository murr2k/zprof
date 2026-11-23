# Changelog

All notable changes to zprof. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). The firmware module, the bridge
and the live views run on the STM32N6570-DK; the other dashboard views are
still the mockup on synthetic data.

## [Unreleased]

## [0.4.0] - 2026-11-22

The scope-like trigger on the live timeline, and the stm32n6-demo's release
build now includes zprof. The firmware module is the same as 0.3.0's.

### Added

- The Live target timeline triggers like a scope: pick a lane in its
  *Trigger* menu and the window is placed on that lane's latest release (a
  thread made ready, or run, after a gap in its activity; an interrupt
  entered), at 10 % from the left with a marker line there. The lane stands
  still and the others stream against it: on the demo, triggered on the
  audio thread, its jobs held to within 1 px over seconds (under 20 us at a
  23 ms window), the microphone's stood still with them (one clock), and the
  UI thread streamed past. With no trigger seen yet it follows the newest
  data. The menu and a *Hold* / *Live* button sit on the timeline's title row.

### Fixed

- A zoomed timeline no longer empties: a zoom or pan held the axis while new
  data went on evicting everything older than the bridge's 12 s, so the view
  ran empty. Held, the timeline is fed nothing (nothing in view is evicted,
  nothing grows); *Live* follows again with the span zoomed to as the new
  window width, a double-click with the last one, and both refill it from
  the link's retained window.

- What-ifs that move a thread now recompute the blocking it causes. A
  cooperative thread made preemptible, or moved above, still counted as
  blocking the threads above it, so "make rx_q[0] preemptible" left the
  audio thread's blocking (and its bound) as measured. The measured
  inversion is dropped when the thread that caused it can no longer block,
  and the cooperative bound follows the priorities given
  (`sched.blocking`); the plain analysis is unchanged.

### Changed

- The stm32n6-demo builds zprof into every firmware; its settings moved to
  the demo (`app/zprof.conf`), so `integrations/stm32n6-demo/zprof.conf` is
  gone. The demo's deadlines and the P3 exit check stay here.

## [0.3.0] - 2026-11-22

The first public release: zprof as a SystemView work-alike over the
target's own Ethernet, through phase P3 (live timeline, recordings and
replay, Perfetto export, capture-then-upload, schedulability analysis,
metrics and application marks).

### Added

- `LICENSE` (Apache-2.0), `NOTICE`, and an SPDX line in every source file.

- zprof is now a SystemView work-alike over the target's own Ethernet
  (PLANS.md section 0): first target the STM32N6570-DK running the
  stm32n6-demo; phases P0 to P5, first public release after P3.
- `firmware/zprof/`: the Zephyr module, Zephyr's tracing format through
  `CONFIG_TRACING_CUSTOM`. The hooks it does not record (367 at v4.4.0) are
  generated empty from the pinned `tracing.h` at configure time
  (`scripts/gen_trace_defaults.py`), so a new hook in a later Zephyr is empty
  instead of a build break. The hooks run from RAM on an XIP image. On the
  demo the module costs about 5 KB of image and 70 KB of internal RAM (its
  64 KB ring).
- `integrations/stm32n6-demo/zprof.conf`: the demo's zprof build, with the
  tracing classes that default on and would hurt (syscalls, networking, power
  management) turned off.
- `docs/PROTOCOL.md`: the wire format (TCP frames, records, time, hello, the
  `.zpr` recording).
- P1, data off the target: the hooks write timestamped records (switches
  with the switch reason, interrupts with their IRQ number, idle, ready, pend,
  priority, create, abort, rename) into a ring in internal RAM under one IRQ
  lock, DWT cycle counter timestamps; a sender thread serves tcp/5560 with a
  hello (versions, build id, clocks, thread and interrupt tables), SYNC
  records, the kernel's own per-thread counts once a second, and the measured
  cost of a hook. A per-build id identifies the ELF.
- `host/bridge/`: `python -m zprof_bridge discover | capture | summary`:
  records a session to a replayable `.zpr`, names threads, interrupts and
  wait queues from the ELF, and reports per-thread CPU, interrupts, wake
  latency, time in WFI and zprof's own cost; unit tests on synthetic streams.
- Measured on the stm32n6-demo: per-thread CPU from the trace agrees with the
  kernel's own counts within 0.03 points; the DWT counter runs through WFI;
  a hook costs 159 ns; about 10,000 events a second on Home (110 KB/s) and
  12,500 through a full regression tour, with zprof at 1.2 % of the CPU (plus
  about 0.3 % in the network stack). With a client streaming through the
  whole tour: 0 dropped frames, 0 audio underruns, 0 trace records lost in
  7.5 million.
- `config/zprof.thresholds.json`: observer A/B criteria (the application's
  own faults with zprof streaming, trace records lost). Found and fixed on
  the way: a 1.5 MB transfer by another service made up to 130,000 events a
  second, which filled a 32 KB ring between two of the sender's looks (0.13 %
  of a tour's events lost); the sender now looks every 2 ms while the ring
  fills fast, and the demo's ring is 64 KB.
- P2 so far: the live dashboard. `python -m zprof_bridge serve` decodes a
  target (or replays a recording) and serves 127.0.0.1:8786; the new Live
  target view shows the board as it runs: KPIs (CPU busy, switches,
  interrupts, trace events and bytes, records dropped, zprof's own cost),
  the scheduler timeline (interrupts by their handler, threads by priority,
  ready waits, drop marks), CPU by thread per second and the thread and
  interrupt tables. Interrupts are named by their handler from the ELF, with
  the chip's name when a device header is given. The other views are still
  the mockup on synthetic data. The header describes only what the current
  view shows: on the live view the target's address, its Zephyr version,
  whether the ELF is the board's build and the link rate; on a mockup view
  the simulator's invented target, labelled simulated (it used to show both
  at once, and "mockup, synthetic data" on the live view).
- The stream recovers by itself from a broken link (a cable replugged, a
  switch rebooting, an error, the target reset): the bridge reconnects with a
  back-off, the timeline runs on the target's clock so it continues after the
  gap, a reboot starts a new one, the header and the timeline title say when
  the link is down and why, and recordings mark the reconnects. On the N6:
  streaming resumed 0.5 s after a 4 s carrier drop came back, with 0 records
  lost, and 1 s after a reset board's network was up.
- Kernel objects: semaphores, mutexes, message queues, queues (fifo, lifo),
  sleeps, polls, timer expiry functions and work items (named by their
  handler), each call with its timeout, what made it wait (a mutex's owner,
  a queue's fill) and its return. The bridge names every object from the ELF
  and times each wait; the summary and the live view list them: calls,
  blocks, time waited, the calls that returned without the object (a timeout,
  an empty poll). The timeline shows a thread waiting for an event as a thin
  neutral bar and a thread blocked on a mutex another holds as red
  (contention); contended mutexes head the table. A class mask (all on) and
  the sender's own calls left out. A call that does not block is one record;
  one that blocks adds a BLOCK record with its timeout or the mutex's owner.
  On the demo, with an ENTER and an EXIT for every call, the events doubled
  (20,000 a second on Home, 37,000 while the film plays) and a full tour lost
  3.6 million records; with one record per call and the demo's sender at
  priority 1 (`CONFIG_ZPROF_SENDER_PRIO`, it was starved by the NPU and the
  video decoder at 14), 167,000, and the tour's deadlines held both times (0
  dropped frames, 0 audio underruns). zprof's own cost 2 to 3.7 %. It found a
  TCP connection's mutex contended up to 6 ms between the network's receive
  thread and zprof's own sender.
- Schedulability view (`#sched`): a response-time analysis of the measured
  system against its deadlines. Jobs per thread from the scheduler's records
  (its release object, or a declared period for a loop without one), arrival
  curves and workload curves per thread and interrupt, Zephyr's cooperative
  threads as blocking, self-suspension; the bound, slack, how much each thread
  can grow, the factor every execution time can scale by, Audsley's priority
  order, and recommendations with their numbers and causes (limits in the
  thresholds file: `sched.*.slack_pct`, `blocking_pct`, `sporadic_pct`,
  `sched.scale`). What-ifs (priority, execution time, period, deadline) are
  analysed by the bridge on the measured model and follow the live data. A
  priority-against-period map marks pairs out of deadline monotonic order.
  Deadlines come from a file (`serve --deadlines`; the demo's:
  `integrations/stm32n6-demo/deadlines.json`); only declared ones make the
  verdict. `python -m zprof_bridge sched rec.zpr` prints it for a recording.
  Checked against the textbook example and a scheduler simulation (150+ random
  task sets, exact). Interference is each thread's and interrupt's measured
  workload (the most it ran in any window), not its densest arrivals times its
  worst run (17 ms of network interrupts in 27 ms that never happened). On the
  demo's Home screen: audio_tid and mic_tid meet their 2.68 ms with 64 to 76 %
  slack, both blocked up to 170 us by the network's cooperative receive thread;
  main's 16.7 ms frame can be missed when its busiest frames meet the network's
  densest bursts (its per-period work is an upper bound until a frame marker
  exists). Over a whole tour it found mic_tid (cooperative, just below
  audio_tid) running up to 1.7 ms instead of its usual 22 us, only on the Camera
  screen (the NPU and the camera in PSRAM, where its ring is): audio_tid can wait
  that long behind it. The tour itself: 0 dropped frames, 0 audio underruns,
  with the Timing preset streaming. Model and blind spots: `docs/SCHEDULABILITY.md`.
- The call site of every blocking call: each `*_blocking` hook and the sleep
  hooks record a return address, and the thread's blocking switch-out carries
  it (a third word, with every preset). The bridge names it `file.c:123
  (function)` through inlined calls (`addr2line -i` from the Zephyr SDK when
  found, `ZPROF_ADDR2LINE` to name one; else the DWARF line table). Zephyr
  fires some blocking hooks before it checks for `K_NO_WAIT`: those calls now
  record neither a site nor a BLOCK record (they were counted as blocks).
- Event loops in the Schedulability view: each thread's shape (active object:
  one wait point, every event run to completion; one event wait point that
  blocks inside N % of its handlers; a sequential loop of N wait points;
  marked), an *Event loop* column, the selected thread's wait points with
  their source lines in the side panel, and recommendations for handlers that
  block (`sched.*.inside_pct`).
- Application marks (`zprof.h`): `ZPROF_MARK_START(name)` and
  `ZPROF_MARK_STOP(name, value)`, one record each, with every preset. A
  deadlines entry `"job": "frame"` takes the thread's jobs from them (STOP with
  0: no job). The demo marks its frames (branch `zprof-integration`): main's
  frame on Home measured 6.3 ms of work and a bound of 11.3 ms against 16.7 ms
  (32 % slack), where one period's work (15.6 ms) had said it could miss.
- Capture presets chosen from the page (the header's *recording* control):
  Scheduling (no kernel-object events), Timing (mutexes), Kernel objects (all).
  The target takes a CT_CLASSES control frame and answers with what it records;
  the bridge sends the choice again at every session (`serve --preset` sets the
  first). On the demo's Home screen: 9,800, 10,600 and 15,700 events a second,
  zprof's own cost 1.15, 1.30 and 1.96 %.
- The timeline's waits (rest and contention) come from the thread switches
  themselves, so they show with every preset.
- Every table sorts by a click on its heading: numbers highest first, text A
  to Z, a second click reverses, a third restores the view's order, with a
  mark in the heading; live tables keep their sort as values change. Grid
  tables through `charts/dataTable.ts` (Sferic's DataGrid, which gained
  `setSortable`), HTML tables with headings through `sortableTable` in
  `dom.ts` (Watch & Tune's probe and audit tables). `snap.mjs --click "x,y"`
  clicks page points before a second screenshot.
- Capture-then-upload: the header's *Capture* button (or `python -m
  zprof_bridge capture --buffer --secs N`) has the target record into its own
  buffer (`CONFIG_ZPROF_CAPTURE_KB` from the port's `zprof_port_alloc()`; the
  demo's is 4 MB of PSRAM) with nothing but a status on the network, then
  upload it as ordinary trace frames; progress and Stop in the header. The
  hooks write the buffer directly, so no record is lost inside the window
  whatever holds the sender off: during the attract lap with two 1.5 MB
  screenshots sent meanwhile, 8 s and 4 MB with none lost, where moving the
  ring into the buffer lost about 7,900 at the screenshots. What the ring
  cannot hold during the upload is an OVERFLOW after the capture.
- Replay equals live: `python -m zprof_bridge check rec.zpr` decodes a
  recording as it arrived and in other pieces and compares totals, statistics
  windows, jobs and Timing series, and the batch analysis's per-thread and
  per-interrupt totals (481,881 records of Home: the same). The live
  statistics windows now close at whole seconds of the target's clock, not
  where a socket read happened to end.
- P3, metrics and application data: a heartbeat every 100 ms latches every
  metric (`ZPROF_METRIC_DEFINE` with `ZPROF_ADD`, `ZPROF_SET`,
  `ZPROF_TIMER_START/STOP`; built-ins `cpu.load`, `zprof.dropped`,
  `zprof.ring_peak`; the port's `zprof_port_heartbeat()` sets the
  application's gauges) and every 10th adds each thread's stack watermark;
  `ZPROF_PLOT(name, value)` and `ZPROF_PRINT(fmt, ...)` (integers, formatted
  on the host). The metric dictionary is in the hello.
- The live Timing view (`#ltiming`): marked jobs (each job's duration) and
  their spread, plots, the heartbeat's metrics (click one to chart it), stack
  watermarks and prints; plots draw points, so a gap (no margin without
  consecutive frames) is not bridged by a line.
- The demo (branch `zprof-integration`): `prof.c` gives zprof its capture
  buffer and puts `gfx_stats()` (frames, dropped, refresh period, least
  margin) and the DAC's block and underrun counts into every heartbeat;
  `gfx.c` plots each frame's margin.
- `integrations/stm32n6-demo/p3check.py`, the P3 exit check: the trace against
  those counters as the heartbeat reads them, beat by beat. On Home and over
  60 s of the attract lap: frame marks equal frames counted, the median
  present interval equals the refresh period (16,673 us), the drops the trace
  implies equal `gfx.dropped`, `margin_min_us` equals the least plotted margin
  at all 560 heartbeats, and the audio refill wakeups equal the DAC's blocks
  (22,300 of 22,300; 47.73 kHz).
- `python -m zprof_bridge export`: Trace Event JSON for ui.perfetto.dev.
- `web/scripts/snap.mjs`: headless screenshots of views with every page
  error and WebGL warning listed (Sferic's harness).
- `docs/OBSERVABILITY_AND_SVD_REVIEW.md`: what Zephyr's observability
  services and ST's STM32N6 SVD add to fidelity, features and testing, with
  16 ranked recommendations; the first is a spike on the N6's on-chip STM and
  ETR as the event-trace path.
- `host/svd/svd_workbook.py`: builds an annotated STM32N657 register workbook
  from ST's SVD: every block with both bus aliases, clock enable, reset,
  debug freeze and its Zephyr node at the pin; every register and field with
  addresses, read side effects and write semantics; interrupts with the
  exception number IPSR reports; the registers zprof reads, checked against
  the SVD; and the Arm core and trace registers the SVD leaves out.
- SVD version check in the generator: each run compares the SVD with the
  baseline the curated tables were reviewed against and with the copy in
  Arm's STM32N6xx_DFP on GitHub (ST's site refuses non-browser clients), and
  writes the result to the About tab; `--check` does only that, for scripts.
  The generator reads ST's zip as downloaded. Provenance of both inputs in
  `host/svd/README.md`; the SVD stays out of the repository.
- Known SVD defects are checked against the SVD, so one that ST fixes drops
  out of the report.

### Changed

- Zephyr pinned to v4.4.0 (684c9e8f) instead of `main` a915b2f1; zcbor
  dropped from the manifest (no CBOR). DASHBOARD_SPEC.md section 3 re-checked
  at v4.4.0: 14 corrections in a table at its head (no
  `tracing_packet_drop_count_get`, one `cpu_load` implementation, no
  largest-free-block heap API, no CTF heap, fifo or pipe events, inheritance
  boosts traced as `sched_priority_set`, `assert_post_action`, no PMU API).
- PLANS.md: section 0 with the 2026-11-21 decisions (target Ethernet with an
  observer A/B as the answer to section 8's objection, the zprof trace format
  through `TRACING_CUSTOM`, no CBOR, names from the ELF, release after P3), and
  corrections where the earlier text named `TRACING_FORMAT_HEADER` or relied
  on `main`.
- DASHBOARD_SPEC.md section 11: the perf sampler's real requirements
  (`CORTEX_M_SYSTICK`, `THREAD_STACK_INFO`, `ARCH_STACKWALK`, which on
  Cortex-M needs `EXTRA_EXCEPTION_INFO`, a Secure image, no SMP); new rows for
  zyclictest and on-chip trace; N6 die temperature, rail flags, Stop / Standby
  entries and the lockup reset flag read by the agent directly.
- DASHBOARD_SPEC.md sections 3.3, 3.8, 3.9 and 12: the `cpu_load` threshold
  callback and backend label; N6 SPI, I2C and DMA error sources; DTS and PWR
  sources; the N6 hardware questions.
- PLANS.md: the trace format is a Phase A decision between CTF, a zprof
  format and the N6 STM, with the trade-offs in section 8.
- README: the N6 on-chip trace path (STM events into an ETR RAM ring) as a
  candidate to replace RTT streaming, and the spike that opens Phase A; a
  Mermaid diagram of the path there and in the review's section 5.
- README rewritten for the release: what zprof records and shows, the cost
  and agreement measured on the STM32N6570-DK, how to add the module to a
  Zephyr application, the bridge and the dashboard; screenshots of the live
  views from the board; the mockup views labelled as simulated.

### Fixed

- `discover` showed only the first word of a board's build date (`fw=` has
  spaces and ends the line); it also names the board now.

## [0.2.0] - 2026-10-20

The hybrid dashboard: Tracealyzer-style analysis views mixed with new GPU
visualizations, an intelligence layer, and a safe write path to the target.

### Added

- Left navigation rail grouped Intelligence, Engineering, Debug, Reliability,
  collapsible, with an alarm badge; deep links between views carry a time, a
  job or a parameter to stage.
- **Insights** view and rule engine: priority inversion, deadline misses by
  cause, cooperative work items, lock hold, heap leak and fragmentation,
  interrupt bursts, stack margin, link cost of tracing, clock-domain drift,
  and temperature-phase clustering of soak failures.
- **Trace** view: vertical sequence trace (`SequenceTrace` panel) with kernel
  objects as lifelines, causal arrows and an annotated event field; response
  anatomy (`AnatomyChart`) with a plain-language explanation and suggested
  fix; event log; find next and previous by kind; snapshot or live tail.
- **Timing** view: scheduling eye and period raster (`PhaseFold`), jitter
  constellation by cause, worst jobs.
- **Objects** view: live kernel-object flow graph with GPU particles
  (`FlowGraph`), kernel-call sunburst, object inspector.
- **Memory** view: RAM floor plan from the pinned STM32N6 devicetree
  (`AddressMap`), heap X-ray on a Hilbert curve (`HeapXRay`), heap by owner,
  leak cone with time to exhaustion.
- **Headroom 3D** view: every budgeted resource in threshold units on one 3D
  landscape with warn and crit planes, and camera presets.
- **Watch & Tune** view: parameter registry writes with arm switch, range
  checks, safe points, acks and audit trail; triggered scope with
  persistence; step-response metrics; before and after comparison.
- **Thermal helix** view: soak data by chamber phase in 3D with a binomial
  clustering test.
- Simulated target rewritten around kernel objects: semaphores, message
  queue, FIFO, mutexes with priority inheritance, timer, work queue,
  chunk-level heap; per-job response decomposition; a PI motor loop; a
  parameter registry; kernel events, job records and watch samples.
- Thresholds file: live rules for FIFOs, heap fragmentation, growth and
  failures, priority inversion, lock waits, work items, IRQ rates, and the
  application's overshoot and settling time.
- DASHBOARD_SPEC.md sections 13 (hybrid views and visualization concepts) and
  14 (writing to a running target); new catalog rows for kernel objects, jobs,
  the heap map and clock drift; new record kinds and the probe provenance
  class.
- PLANS.md: parameter registry protocol, watch block, heap-call wrapping,
  kernel-object events, bridge derivations, link cost of object tracing, new
  risks.
- README with the feature spec sheet, and this changelog.

### Changed

- The simulated link charges kernel calls at CTF cost (an enter and exit
  pair, about 28 B), which puts full object tracing near the RTT budget during
  network bursts.
- The SPI DMA interrupt keeps its jitter around its own clock instead of
  accumulating it.

### Fixed

- Period raster: idle bins no longer take the first lane's color (NaN cells
  were not discarded; a transparent sentinel is used instead).
- Simulator could stall when an ISR carried time past the heartbeat instant.

### Verified

- Stock CTF heap events cannot build an allocator map at the pinned SHA
  (`heap_alloc_exit` has no size, `heap_free` has neither size nor pointer);
  the agent will wrap the heap calls and use `sys_heap_usable_size()`.

## 0.1.1 - 2026-10-19 (before the repository, not tagged)

### Added

- Live view pause and resume: a button on the timeline or Space freezes every
  live panel while the target keeps running; zoom or pan also pauses;
  double-click, the button or Space resumes and catches up from the retained
  log and heartbeats.

### Fixed

- Freezing the timeline by zooming no longer lets its data be evicted.

## 0.1.0 - 2026-10-18 (before the repository, not tagged)

### Added

- PLANS.md: research on what Zephyr already exposes, architecture, the
  Memfault-style firmware agent, host bridge, phases B, A and D, egress through
  a J-Link / J-Trace over RTT, link budget, risks.
- DASHBOARD_SPEC.md: users and their questions, data model, a parameter
  catalog checked against Zephyr sources, views, interaction, thresholds,
  non-functional requirements, Sferic mapping, platform comparison for the
  Zynq PS and the STM32N6570-DK.
- Dashboard mockup on synthetic data: Live, Profile, Soak run and Build
  compare views, with the new Sferic panels `IntervalSeries`, `KpiStrip` and
  `BulletChart`.
- Thresholds file with JSON Schema: live alarms, run pass criteria, build gate.
- Zephyr `main` pinned by SHA in `firmware/west.yml`.

[Unreleased]: https://github.com/murr2k/zprof/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/murr2k/zprof/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/murr2k/zprof/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/murr2k/zprof/releases/tag/v0.2.0
