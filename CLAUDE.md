# zephyr-dev (zprof): Claude Code Configuration

## What this is

zprof: a Zephyr RTOS execution profiler and telemetry dashboard. A firmware
agent (Memfault-style metric registry and heartbeat, clean-room) plus a Python
host bridge feed a browser dashboard built on Sferic (`~/projects/lightning`).
Two audiences: firmware dev/DVT engineers (live timeline, latency, headroom,
profile) and QA/reliability engineers (soak runs, faults, MTBF, build
regression). Targets: a Zynq PS and the STM32N6570-DK (Cortex-M55, for
development practice; its board quirks are in `~/projects/STM32N6570-DK/CLAUDE.md`).
Today only the plan, the spec, the thresholds file, the west manifest and a
dashboard mockup on synthetic data exist; no firmware or bridge yet.

## Run / build / test

```powershell
cd web; npm install            # first time
.\run.cmd                      # mockup at http://127.0.0.1:8781 (#insights #live #trace #timing #objects #memory #headroom #profile #tune #soak #helix #compare; ?theme=light)
cd web; npx tsc --noEmit       # must stay clean
```

## Architecture

| Path | Role |
|---|---|
| `docs/PLANS.md` | Research, architecture, agent, transport (RTT), phases B then A then D, link budget |
| `docs/DASHBOARD_SPEC.md` | Parameter catalog with verified Zephyr sources, views, thresholds, Sferic mapping; section 13 hybrid views, section 14 the write path |
| `config/zprof.thresholds.json` | Single source of live alarm levels, run pass criteria and the build gate; schema beside it |
| `firmware/west.yml` | Zephyr `main` pinned by SHA; the repo root is the west workspace (`west init -l firmware`) |
| `web/src/thresholds.ts` | Reads the thresholds file; every status in the mockup goes through it |
| `web/src/charts/` | New Sferic-paradigm panels: `IntervalSeries` (timeline / flame), `KpiStrip`, `BulletChart`, `SequenceTrace` (vertical trace), `AnatomyChart`, `PhaseFold` (eye, raster), `FlowGraph`, `AddressMap`, `HeapXRay` |
| `web/src/sim/` | Synthetic data: scheduler with kernel objects, jobs, PI plant and parameter registry (`target.ts`), heap model, N6 memory map, window queries (`query.ts`), job explanations, insight rules, soak run, profile tree |
| `web/src/views/` | One file per dashboard view; `main.ts` builds the rail, `nav.ts` carries a focus between views, `dom.ts` and `icons.ts` the DOM chrome |
| `firmware/`, `host/` | Planned (PLANS.md section 3), not started |

## Invariants & "do not regress"

- `web/` imports Sferic from source through the `sferic` alias (`vite.config.ts`, `tsconfig.json` paths), because the new charts use internals (`SeriesXY`, `RectBatch`, `SegmentBatch`). **Why:** the published package exports none of them. Keep `../lightning` checked out beside this repo.
- Read colors from the Sferic theme, never hard-code a palette in charts; status is color plus glyph (`charts/status.ts`). **Why:** dark and daylight themes, and color-blind safety (spec section 7.1).
- Zero page errors and zero WebGL warnings on every view, both themes, before calling a change done. **Why:** Sferic drops bad draws silently; warnings are the only signal.
- No limits hard-coded in views: statuses, zones and criteria come from `config/zprof.thresholds.json`. **Why:** pass criteria must be defined once and shared by the bridge, the dashboard and the run report.
- Zephyr is pinned by SHA, never `revision: main`. **Why:** Build compare needs identical Zephyr on both sides; bumping the pin means re-checking spec section 3 sources.
- Simulated quantities stay honest: link bytes use the PLANS.md CTF costs, memory regions come from the pinned devicetree, and anything else synthetic is labelled so. **Why:** the mockup is used to argue design trade-offs (link budget, write safety); fudged numbers would argue the wrong way.
- Parameter suggestions ("Try") only stage values in Watch & Tune; writes need the arm switch and Apply. **Why:** the same UI will drive real hardware (spec section 14).
- No em dashes in docs or UI text (global rule).

## Open questions / known gaps

See `docs/DASHBOARD_SPEC.md` section 12 and `docs/PLANS.md` section 9. Platform not chosen yet.
