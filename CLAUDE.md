# zephyr-dev (zprof): Claude Code Configuration

## What this is

zprof: a Zephyr RTOS execution profiler and telemetry dashboard. A firmware
agent (Memfault-style metric registry and heartbeat, clean-room) plus a Python
host bridge feed a browser dashboard built on Sferic (`~/projects/lightning`).
Two audiences: firmware dev/DVT engineers (live timeline, latency, headroom,
profile) and QA/reliability engineers (soak runs, faults, MTBF, build
regression). Since 2026-11-21 it is a SystemView work-alike (runtime
visualization, timing analysis, protocol analyzer; Zephyr thread-aware and
Cortex-M55-aware) with the data over the target's own Ethernet (TCP 5560) and
the dashboard in the browser. First target: the STM32N6570-DK running
`~/projects/stm32n6-demo` (Zephyr v4.4.0); the Zynq PS later. Plan:
`docs/PLANS.md` section 0 (decisions, phases P0 to P5 and the first release
R1 after P3); wire format: `docs/PROTOCOL.md`. Built so far: the firmware
module (trace, kernel objects, capture presets from the host), the bridge (live,
recordings, Perfetto export, schedulability analysis) and two live views (Live
target, Schedulability: `docs/SCHEDULABILITY.md`); the other views are the mockup.

## Run / build / test

```powershell
# The bridge (P1): from host\bridge, with the project venv (pyelftools, pytest)
cd host\bridge
..\..\.venv\Scripts\python.exe -m pytest -q tests                      # decoder and analysis on synthetic streams
..\..\.venv\Scripts\python.exe -m zprof_bridge discover                # boards answering N6HQ on udp/5557
..\..\.venv\Scripts\python.exe -m zprof_bridge capture --host 192.168.254.86 --secs 10 -o ..\..\captures\x.zpr --elf <demo>\build-zprof\app\zephyr\zephyr.elf --irq-header <demo>\modules\hal\stm32\stm32cube\stm32n6xx\soc\stm32n657xx.h
..\..\.venv\Scripts\python.exe -m zprof_bridge summary ..\..\captures\x.zpr   # decode a recording again
#   capture --raw: record only (long sessions: a decoded tour is millions of events)
..\..\.venv\Scripts\python.exe -m zprof_bridge export ..\..\captures\x.zpr     # Trace Event JSON for ui.perfetto.dev
..\..\.venv\Scripts\python.exe -m zprof_bridge serve --host 192.168.254.86 --elf ... --irq-header ...   # live, ws://127.0.0.1:8786; then http://127.0.0.1:8781/#target
..\..\.venv\Scripts\python.exe -m zprof_bridge serve --replay ..\..\captures\x.zpr --loop                # a recording, as if live
#   serve --deadlines ..\..\integrations\stm32n6-demo\deadlines.json --preset timing   # the Schedulability view's deadlines; what the target records (the page can change it)
..\..\.venv\Scripts\python.exe -m zprof_bridge sched ..\..\captures\x.zpr --deadlines ..\..\integrations\stm32n6-demo\deadlines.json   # the schedulability analysis of a recording, as text
cd ..\..
cd web; node scripts\snap.mjs --views target,live --theme storm   # headless Chrome (Sferic's harness, ../lightning): PNGs in captures\snaps and every page error / WebGL warning; cd ..
#   --click "x,y;x,y": click page points (a table heading) after the wait, then <view>-<theme>-click.png

cd web; npm install            # first time
.\run.cmd                      # mockup at http://127.0.0.1:8781 (#insights #live #trace #timing #objects #memory #headroom #profile #tune #soak #helix #compare; ?theme=light)
cd web; npx tsc --noEmit       # must stay clean
# N6 register workbook (python -m venv .venv; .venv\Scripts\pip install -r host\svd\requirements.txt):
.venv\Scripts\python -I host\svd\svd_workbook.py <ST's stm32n6-svd.zip> <zephyr tree at the pin> <out.xlsx>
.venv\Scripts\python -I host\svd\svd_workbook.py --check [<zip>]   # 0 current, 1 different SVD exists, 2 could not tell
```

## Architecture

| Path | Role |
|---|---|
| `docs/PLANS.md` | Research, architecture, agent, transport (RTT), phases B then A then D, link budget |
| `docs/DASHBOARD_SPEC.md` | Parameter catalog with verified Zephyr sources, views, thresholds, Sferic mapping; section 13 hybrid views, section 14 the write path |
| `config/zprof.thresholds.json` | Single source of live alarm levels, run pass criteria and the build gate; schema beside it |
| `firmware/west.yml` | Zephyr v4.4.0 pinned by SHA (684c9e8f, the demo's); the repo root is the west workspace (`west init -l firmware`, not initialized on this PC: the module is built inside the demo's workspace) |
| `firmware/zprof/` | The Zephyr module (`zephyr/module.yml`): Zephyr's tracing format through `CONFIG_TRACING_CUSTOM` (`include/zephyr_custom_tracing.h`), hooks in `src/`; every hook it does not record is generated empty from the pinned `tracing.h` by `scripts/gen_trace_defaults.py` at configure time |
| `integrations/stm32n6-demo/zprof.conf` | The demo's zprof build (`build-zprof`), passed by absolute path with the module: `n6.cmd -d build-zprof build -p -- '-Dapp_EXTRA_CONF_FILE=<this>' '-Dapp_ZEPHYR_EXTRA_MODULES=<repo>/firmware/zprof'` |
| `docs/PROTOCOL.md` | Wire format: TCP frames, records, time, hello, the `.zpr` recording |
| `web/src/thresholds.ts` | Reads the thresholds file; every status in the mockup goes through it |
| `web/src/charts/` | New Sferic-paradigm panels: `IntervalSeries` (timeline / flame), `KpiStrip`, `BulletChart`, `SequenceTrace` (vertical trace), `AnatomyChart`, `PhaseFold` (eye, raster), `FlowGraph`, `AddressMap`, `HeapXRay` |
| `web/src/sim/` | Synthetic data: scheduler with kernel objects, jobs, PI plant and parameter registry (`target.ts`), heap model, N6 memory map, window queries (`query.ts`), job explanations, insight rules, soak run, profile tree |
| `web/src/views/` | One file per dashboard view; `main.ts` builds the rail, `nav.ts` carries a focus between views, `dom.ts` and `icons.ts` the DOM chrome |
| `docs/OBSERVABILITY_AND_SVD_REVIEW.md` | Zephyr observability services and the STM32N6 SVD measured against the plan; recommendations, corrections (applied), hardware questions |
| `host/svd/svd_workbook.py` | Annotated STM32N657 register workbook from ST's SVD (not vendored; Apache-2.0) and the pinned devicetree; fails if a curated zprof signal names a register or field the SVD lacks; checks the SVD against its baseline and Arm's STM32N6xx_DFP. Provenance in `host/svd/README.md` |
| `web/src/live/link.ts`, `web/src/views/liveTarget.ts` | The page's link to the bridge (opened only by a live view) and the Live target view: KPIs, scheduler timeline (lanes appear with their first run or interrupt; colors by CPU share), CPU by thread (top 8 + others), thread and interrupt tables. Every other view is still the mockup on the simulator, and the header says so |
| `host/bridge/zprof_bridge/live.py`, `perfetto.py` | `serve`: live (or replayed) session to the browser: hello with lanes, binary timeline batches (`ZIV1`, typed-array aligned) every 50 ms, stats per second of target time; keeps only the last 12 s. `export`: Trace Event JSON |
| `host/bridge/zprof_bridge/sched.py`, `docs/SCHEDULABILITY.md` | Schedulability: jobs per thread (release object, or a declared period), arrival curves, workload curves, response-time analysis with Zephyr's cooperative threads, room to grow, scaling factor, Audsley's order, recommendations; `web/src/views/liveSched.ts` (#sched) and `charts/PriorityMap.ts` show it, with what-ifs the bridge analyses |
| `host/bridge/zprof_bridge/presets.py`, `thresholds.py` | Capture presets (Scheduling, Timing, Kernel objects) and the CT_CLASSES control frame; the thresholds file read the way the dashboard reads it |
| `integrations/stm32n6-demo/deadlines.json` | The demo's deadlines (main 16.7 ms per period, audio_tid and mic_tid 2.679 ms), with why |
| `host/bridge/zprof_bridge/` | The bridge (P1): `link` (discovery, TCP), `stream` (preamble, frames, hello, records, timestamp unwrap and re-anchor after drops), `elf` (names from the ELF, build id check), `record` (`.zpr`), `analyze` (per-thread CPU, interrupts, wake latency, self-cost, the check against the kernel's own counts), `__main__` (CLI). Ids come from `firmware/zprof/include/zprof/proto.h` at import |

## Invariants & "do not regress"

- `web/` imports Sferic from source through the `sferic` alias (`vite.config.ts`, `tsconfig.json` paths), because the new charts use internals (`SeriesXY`, `RectBatch`, `SegmentBatch`). **Why:** the published package exports none of them. Keep `../lightning` checked out beside this repo.
- Read colors from the Sferic theme, never hard-code a palette in charts; status is color plus glyph (`charts/status.ts`). **Why:** dark and daylight themes, and color-blind safety (spec section 7.1).
- Zero page errors and zero WebGL warnings on every view, both themes, before calling a change done. **Why:** Sferic drops bad draws silently; warnings are the only signal. Check with `web/scripts/snap.mjs` (headless; the Chrome extension's screenshots time out on these pages). The Live target view needs a bridge for that: without one the browser logs its failed connection as an error, which a page cannot suppress.
- No limits hard-coded in views: statuses, zones and criteria come from `config/zprof.thresholds.json`. **Why:** pass criteria must be defined once and shared by the bridge, the dashboard and the run report.
- Zephyr is pinned by SHA, never `revision: main`. **Why:** Build compare needs identical Zephyr on both sides; bumping the pin means re-checking spec section 3 sources.
- **Private until the first release (R1, after P3); nothing in the public stm32n6-demo repo may announce zprof before then.** Demo-side changes (discovery `prof=`, port hooks, markers) live on the demo's local branch `zprof-integration`, never pushed before R1; the demo's build conf lives here. **Why:** the user's decision, 2026-11-21.
- **A broken link recovers by itself, end to end: never add a step that needs a restart.** The target ends a session on a failed or 5 s stalled send and keeps listening (the listening socket is made again if accept keeps failing); the bridge re-makes the connection (3 s silent = broken, back-off 0.5 to 5 s), places every session on the target's clock since boot (anchored at its first SYNC), so the page's timeline continues after a gap and rebuilds only for a reboot (a new `epoch`) or new lanes. **Why:** the user's requirement, 2026-11-21 (replugging, errors). Measured on the N6: a reflash (board reset) reconnected 1 s after the board's network was up; a carrier drop of 4 s (`ctl.py "carrier 4000"` in the demo) ended the board's session at once, 0 records lost, and streaming resumed 0.5 s after the link returned.
- **Kernel-object calls that may block (sem take, mutex lock, msgq put and get, queue get) are one record unless they block.** No ENTER; EXIT carries the return; BLOCK (then EXIT) carries the timeout or a mutex's owner. **Why:** with an ENTER and an EXIT for every call, object events doubled the stream (20,000 to 39,000 events a second on the demo) and a tour lost 3.6 million records; with one record per call and the demo's sender at priority 1 (`integrations/stm32n6-demo/zprof.conf`), 167,000. A waiting thread is drawn as rest (thin, neutral), a thread blocked on a mutex another holds as contention (red): most threads spend their lives waiting on a semaphore, which is not a fault.
- **The schedulability verdict is measurement-based and says so ("under the load observed"); a measured thread interferes with its workload curve (the most work it did in any window), never its densest arrivals times its worst job.** **Why:** network receive threads run bursts of small jobs and a rare long one: arrivals times the worst job exceeded the CPU, and every thread below them had no bound. Only declared deadlines make the verdict when any are declared (polling loops have periods, not deadlines). Model and blind spots: `docs/SCHEDULABILITY.md`.
- **The page's capture preset is re-applied by the bridge at every session; the target starts each session recording every class.** **Why:** a reconnect or a reboot must not silently change what is recorded (the recovery invariant above).
- **The tracing hooks never wake a thread or take a kernel lock; the sender polls the ring.** **Why:** a `k_sem_give` from a hook is itself traced, and `sched_ready`/`sched_pend` fire with the scheduler's spinlock held.
- **The zprof build turns off `TRACING_SYSCALL`, `TRACING_NETWORKING` and `TRACING_PM`.** **Why:** they default to y with `TRACING`; syscall tracing hooks every syscall site, and the network classes would trace zprof's own packets.
- Simulated quantities stay honest: link bytes use the PLANS.md CTF costs, memory regions come from the pinned devicetree, and anything else synthetic is labelled so. **Why:** the mockup is used to argue design trade-offs (link budget, write safety); fudged numbers would argue the wrong way.
- Parameter suggestions ("Try") only stage values in Watch & Tune; writes need the arm switch and Apply. **Why:** the same UI will drive real hardware (spec section 14).
- The SVD is not vendored and the update check never poses as a browser to reach st.com; it asks GitHub for Arm's DFP copy. **Why:** the user sources the SVD from ST to get its updates, and ST's site refuses non-browser clients on purpose.
- **Every table sorts by its headings: make grids with `dataTable()` (`web/src/charts/dataTable.ts`), never `createDataGrid` directly; wrap HTML tables that have headings in `sortableTable()` (`dom.ts`) and write their headings as `<th>`.** Rows keep their content index (a view's row clicks, row colours and `setCellContent` are unaffected); give a cell whose text mixes units a `value` to sort by. **Why:** the user's rule, 2026-11-21. Sorting lives in Sferic's DataGrid (`setSortable`, `../lightning`).
- No em dashes in docs or UI text (global rule).

## Open questions / known gaps

See `docs/DASHBOARD_SPEC.md` section 12 and `docs/PLANS.md` section 9. First
platform: the STM32N6570-DK with the stm32n6-demo (2026-11-21). To measure in
P1: whether the DWT cycle counter runs through WFI with no probe attached,
and whether the PMU cycle counter is the same counter as DWT CYCCNT.
