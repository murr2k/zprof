# Changelog

All notable changes to zprof. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Until 1.0 the project is a design
and a dashboard mockup on synthetic data; no firmware or bridge has shipped.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/murr2k/zprof/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/murr2k/zprof/releases/tag/v0.2.0
