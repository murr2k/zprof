import { gauss, linfit, mtbfLower, rng } from './rng'

/**
 * Synthetic 72 h thermal-cycling soak of 8 DUTs, one sample per minute per DUT
 * (the bridge's 1-minute downsampling tier, spec section 8.3). The story baked
 * in: DUT-03 trips the storage task watchdog during cold dwells, DUT-05 leaks
 * heap, DUT-06 browns out once, DUT-07 asserts, DUT-08 hangs then takes a
 * hardware watchdog reset, DUT-02 loses telemetry briefly (not a DUT failure).
 */
export const DUTS = Array.from({ length: 8 }, (_, i) => `DUT-${String(i + 1).padStart(2, '0')}`)
export const RUN_HOURS = 72
export const START_H = 52.3
export const STEP_H = 1 / 60
export const HEAP_SIZE = 24 * 1024
// Limits, windows and confidence levels come from config/zprof.thresholds.json, not from here.

export type Phase = 'ambient' | 'ramp up' | 'hot dwell' | 'ramp down' | 'cold dwell' | 'recover'
const CYCLE = 4
/** Chamber profile: 25 C hold, ramp to 70, dwell, ramp to -20, dwell, back to 25. */
export function chamber(h: number): { c: number; phase: Phase } {
  const p = ((h % CYCLE) + CYCLE) % CYCLE
  if (p < 1) return { c: 25, phase: 'ambient' }
  if (p < 1.5) return { c: 25 + (p - 1) / 0.5 * 45, phase: 'ramp up' }
  if (p < 2.5) return { c: 70, phase: 'hot dwell' }
  if (p < 3.25) return { c: 70 - (p - 2.5) / 0.75 * 90, phase: 'ramp down' }
  if (p < 3.75) return { c: -20, phase: 'cold dwell' }
  return { c: -20 + (p - 3.75) / 0.25 * 45, phase: 'recover' }
}
export const PHASE_SEGMENTS = (() => {
  const out: { h0: number; h1: number; phase: Phase }[] = []
  const edges: [number, Phase][] = [[0, 'ambient'], [1, 'ramp up'], [1.5, 'hot dwell'], [2.5, 'ramp down'], [3.25, 'cold dwell'], [3.75, 'recover']]
  for (let c = 0; c < RUN_HOURS; c += CYCLE) edges.forEach(([a, ph], i) => out.push({ h0: c + a, h1: c + (edges[i + 1]?.[0] ?? CYCLE), phase: ph }))
  return out
})()

export type EventKind = 'wdt' | 'hwwdt' | 'brownout' | 'fatal' | 'hang' | 'linkgap'
export interface SoakEvent { dut: number; h: number; dur?: number; kind: EventKind; detail: string }
export const EVENTS: SoakEvent[] = [
  { dut: 1, h: 12.1, dur: 0.05, kind: 'linkgap', detail: 'no frames 3.0 min, probe USB re-enumerated' },
  { dut: 5, h: 27.4, kind: 'brownout', detail: 'RESET_BROWNOUT, VCCINT dipped to 0.94 V at -20 C' },
  { dut: 2, h: 31.42, kind: 'wdt', detail: 'task_wdt ch2 "storage" not fed for 2000 ms; last trace PC qspi_page_program' },
  { dut: 1, h: 33.7, dur: 0.1, kind: 'linkgap', detail: 'no frames 6.0 min, bridge restarted' },
  { dut: 7, h: 38.95, dur: 0.07, kind: 'hang', detail: 'heartbeat silent 4.2 min, RTT alive: ctrl_loop blocked on flash_lock held by storage' },
  { dut: 7, h: 39.02, kind: 'hwwdt', detail: 'RESET_WATCHDOG after hang (hardware WDT)' },
  { dut: 6, h: 44.1, kind: 'fatal', detail: 'ASSERTION FAIL proto.c:212 len <= CONFIG_PROTO_MAX, K_ERR_KERNEL_PANIC' },
  { dut: 1, h: 45.2, dur: 0.04, kind: 'linkgap', detail: 'no frames 2.4 min' },
  { dut: 2, h: 47.55, kind: 'wdt', detail: 'task_wdt ch2 "storage" not fed for 2000 ms; last trace PC qspi_page_program' },
  { dut: 2, h: 55.45, kind: 'wdt', detail: 'task_wdt ch2 "storage" not fed for 2000 ms; last trace PC qspi_page_program' },
]
/** Counts toward MTBF: anything that ends a DUT's uptime unplanned (a hang and its WDT reset count once). */
export const isFailure = (e: SoakEvent) => e.kind === 'wdt' || e.kind === 'brownout' || e.kind === 'fatal' || e.kind === 'hwwdt'
export const isReset = (e: SoakEvent) => e.kind !== 'linkgap' && e.kind !== 'hang'

export interface Series { h: number[]; heap: number[]; p99: number[]; die: number[]; vcc: number[]; cpu95: number[]; marginNet: number[] }

export class SoakSim {
  readonly series: Series[] = DUTS.map(() => ({ h: [], heap: [], p99: [], die: [], vcc: [], cpu95: [], marginNet: [] }))
  elapsed = 0
  private r = rng(1234)
  private heapLeak = DUTS.map(() => 0)
  private margin = DUTS.map((_, i) => 19.6 - i * 0.05)

  constructor(startH = START_H) { this.advanceTo(startH) }

  /** Generate samples up to `h` hours. */
  advanceTo(h: number) {
    const r = this.r
    for (let t = this.elapsed + STEP_H; t <= Math.min(h, RUN_HOURS) + 1e-9; t += STEP_H) {
      const { c } = chamber(t)
      DUTS.forEach((_, d) => {
        const s = this.series[d]
        const gap = EVENTS.some((e) => e.dut === d && e.kind === 'linkgap' && t >= e.h && t < e.h + (e.dur ?? 0))
        if (gap) return
        const reset = EVENTS.find((e) => e.dut === d && isReset(e) && t >= e.h && t - STEP_H < e.h)
        if (reset) this.heapLeak[d] = 0
        if (d === 4) this.heapLeak[d] += 178 * STEP_H
        if (d === 3 && t > 29 && this.margin[d] > 17.2) this.margin[d] = 17.2
        const brown = d === 5 && Math.abs(t - 27.4) < 0.02
        s.h.push(t)
        s.heap.push((9800 + 220 * Math.sin(t * 1.7 + d) + gauss(r) * 140 + this.heapLeak[d]) / 1024)
        s.p99.push(338 + d * 4 + 0.95 * (c - 25) + gauss(r) * 11 + (r() < 0.004 ? 60 : 0))
        s.die.push(c + 13.5 + d * 0.4 + gauss(r) * 0.5)
        s.vcc.push(brown ? 0.94 : 1.0 + gauss(r) * 0.0018 - (c < 0 ? 0.004 : 0))
        s.cpu95.push(41 + 3 * Math.sin(t * 0.9 + d) + gauss(r) * 1.2)
        s.marginNet.push(this.margin[d])
      })
      this.elapsed = t
    }
  }

  eventsSoFar() { return EVENTS.filter((e) => e.h <= this.elapsed) }

  /**
   * Heap trend for one DUT since its last reset, after a warm-up: slope in
   * bytes/hour with a 95% CI and time to exhaustion. Needs `minH` hours of
   * data; shorter windows are not evaluable rather than a noisy slope.
   */
  leak(d: number, warmupH: number, minH: number) {
    const s = this.series[d]
    const lastReset = Math.max(0, ...this.eventsSoFar().filter((e) => e.dut === d && isReset(e)).map((e) => e.h))
    const warm = lastReset + warmupH
    const xs: number[] = [], ys: number[] = []
    s.h.forEach((h, i) => { if (h >= warm) { xs.push(h); ys.push(s.heap[i] * 1024) } })
    if (this.elapsed - warm < minH) return { ok: false, slope: 0, ci: Infinity, tte: Infinity, a: 0, from: warm }
    const f = linfit(xs, ys)
    const now = f.a + f.b * this.elapsed
    const tte = f.b > 0 ? (HEAP_SIZE - now) / f.b : Infinity
    return { ok: true, slope: f.b, ci: f.ci95, tte, a: f.a, from: warm }
  }

  reliability(conf: number, targetH: number) {
    const fails = this.eventsSoFar().filter(isFailure)
    const hours = DUTS.length * this.elapsed
    const point = fails.length ? hours / fails.length : Infinity
    const lower = mtbfLower(hours, fails.length, conf)
    // Device-hours a zero-failure test needs to show targetH at conf.
    const demo = targetH * Math.log(1 / (1 - conf))
    return { fails, hours, point, lower, demo }
  }
}
