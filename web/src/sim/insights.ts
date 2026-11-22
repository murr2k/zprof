// SPDX-License-Identifier: Apache-2.0
import { targetSim, AP, CTRL_BUDGET_US, EVENT_BYTES, LINK_BUDGET_BPS, OB, SWITCH_BYTES, TH, IDLE, type Job, type TargetSim } from './target'
import { SoakSim, DUTS, isFailure } from './soak'
import { linfit } from './rng'
import { level, liveRule } from '../thresholds'
import type { Focus } from '../nav'

/**
 * Insights: rules evaluated once a second over the live streams (jobs,
 * events, heartbeats) and the soak record. Each finding explains itself with
 * numbers, links to where the evidence is, and names a registered parameter
 * when one can fix it. Severity comes from the thresholds file wherever a rule
 * exists; findings with no rule are 'info'.
 */
export type Sev = 'crit' | 'warn' | 'info'
export interface Insight {
  id: string
  sev: Sev
  title: string
  detail: string
  evidence: string[]
  spark?: number[]
  sparkLabel?: string
  links: { label: string; view: string; focus?: Focus }[]
  action?: { label: string; param: { id: string; value: number } }
  /** Target ms when first raised in this session, and evaluations it has held for. */
  since: number
  held: number
}

const sevOf = (s: string): Sev | null => (s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : null)
const f0 = (v: number) => v.toFixed(0)

/** Count per second over the last `n` seconds of jobs matching `pred`. */
function perSecond(jobs: Job[], now: number, n: number, pred: (j: Job) => boolean) {
  const out = new Array(n).fill(0)
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]
    const age = now - j.end
    if (age >= n * 1000) break
    if (age >= 0 && pred(j)) out[n - 1 - Math.floor(age / 1000)]++
  }
  return out
}

export class InsightEngine {
  list: Insight[] = []
  private seen = new Map<string, { since: number; held: number }>()
  private listeners: (() => void)[] = []
  private soakNote: Insight | null

  constructor(private sim: TargetSim) {
    this.soakNote = soakClustering()
    sim.onHeartbeat((h) => { if (h.seq % 10 === 0) this.evaluate() })
    this.evaluate()
  }
  onChange(fn: () => void) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn) } }
  summary() { return { crit: this.list.filter((i) => i.sev === 'crit').length, warn: this.list.filter((i) => i.sev === 'warn').length } }

  evaluate() {
    const sim = this.sim
    const now = sim.now / 1000
    const out: Omit<Insight, 'since' | 'held'>[] = []
    const ctrl: Job[] = []
    for (let i = sim.jobs.length - 1; i >= 0; i--) {
      const j = sim.jobs[i]
      if (j.end < now - 10_000) break
      if (j.thread === TH.CTRL) ctrl.push(j)
    }
    const hb = sim.heartbeats[sim.heartbeats.length - 1]

    // ---------------------------------------------------------------- priority inversion
    const inv = ctrl.filter((j) => j.inv > 0)
    if (inv.length) {
      const worst = inv.reduce((a, b) => (b.inv > a.inv ? b : a))
      const missesByInv = ctrl.filter((j) => j.miss && j.cause === 'inversion').length
      const st = sevOf(level('sched.ctrl_loop.inversion_us', worst.inv)) ?? 'warn'
      const mutex = sim.busIsMutex
      out.push({
        id: 'inversion', sev: st,
        title: 'Unbounded priority inversion on the SPI1 bus lock',
        detail: `ctrl_loop (prio 3) waits for ${OBJ(worst.lock)} while storage (prio 8) holds it, and net_rx (prio 5) preempts storage, so the wait grows with network load. ${mutex ? 'The lock is now a k_mutex; these are jobs from before the switch.' : 'bus_lock is a k_sem: semaphores have no owner, so the kernel cannot apply priority inheritance.'}`,
        evidence: [
          `${inv.length} inverted ctrl_loop jobs in the last 10 s, worst ${f0(worst.inv)} us of inversion`,
          `${missesByInv} deadline misses where inversion was the deciding delay`,
          `rule sched.ctrl_loop.inversion_us: ${limit('sched.ctrl_loop.inversion_us')}`,
        ],
        spark: perSecond(sim.jobs, now, 30, (j) => j.thread === TH.CTRL && j.inv > 0), sparkLabel: 'inverted jobs per second, 30 s',
        links: [{ label: 'Worst one in Trace', view: 'trace', focus: { t: worst.release, job: worst.id, label: 'Insight: inversion' } }, { label: 'Timing', view: 'timing' }],
        action: mutex ? undefined : { label: 'Try storage.bus_mutex = 1', param: { id: 'storage.bus_mutex', value: 1 } },
      })
    }

    // ---------------------------------------------------------------- deadline misses
    const miss = ctrl.filter((j) => j.miss)
    if (miss.length) {
      const by = new Map<string, number>()
      for (const j of miss) by.set(j.cause, (by.get(j.cause) ?? 0) + 1)
      const parts = [...by].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${CAUSE[c] ?? c}`)
      const last = miss[0]
      out.push({
        id: 'misses', sev: sevOf(level('span.ctrl_loop.miss', miss.length)) ?? 'warn',
        title: `ctrl_loop missed its ${CTRL_BUDGET_US} us deadline ${miss.length} times in 10 s`,
        detail: `Each miss is decomposed into what delayed it. Dominant causes: ${parts.join(', ')}.`,
        evidence: [
          `${((miss.length / Math.max(1, ctrl.length)) * 100).toFixed(2)}% of ${ctrl.length} jobs; worst response ${f0(Math.max(...miss.map((j) => j.resp)))} us`,
          `latest at ${clock(last.end)}: ${f0(last.resp)} us, cause ${CAUSE[last.cause] ?? last.cause}`,
        ],
        spark: perSecond(sim.jobs, now, 30, (j) => j.thread === TH.CTRL && j.miss), sparkLabel: 'misses per second, 30 s',
        links: [{ label: 'Latest in Trace', view: 'trace', focus: { t: last.release, job: last.id, label: 'Insight: deadline miss' } }, { label: 'Worst jobs', view: 'timing' }],
      })
    }

    // ---------------------------------------------------------------- cooperative work queue
    const coop = ctrl.filter((j) => j.pre[TH.SYSWQ] > 0)
    const coopWorst = coop.length ? coop.reduce((a, b) => (b.pre[TH.SYSWQ] > a.pre[TH.SYSWQ] ? b : a)) : null
    if (coopWorst && sevOf(level('wq.sysworkq.item_us', coopWorst.pre[TH.SYSWQ]))) {
      out.push({
        id: 'coop', sev: sevOf(level('wq.sysworkq.item_us', coopWorst.pre[TH.SYSWQ]))!,
        title: 'A long item on the cooperative system work queue delays ctrl_loop',
        detail: 'sysworkq runs at priority -1 (cooperative): once an item starts, no thread preempts it until it returns. An occasional long item (about 1 in 120, 380 to 640 us) lands right when ctrl_loop is released.',
        evidence: [`worst delay ${f0(coopWorst.pre[TH.SYSWQ])} us to ctrl_loop job ${coopWorst.id}`, `rule wq.sysworkq.item_us: ${limit('wq.sysworkq.item_us')}`, 'fix: a preemptible work queue below ctrl_loop (k_work_queue_start), or split the item'],
        spark: perSecond(sim.jobs, now, 30, (j) => j.thread === TH.CTRL && j.pre[TH.SYSWQ] > 150), sparkLabel: 'jobs delayed > 150 us, per second',
        links: [{ label: 'Show it in Trace', view: 'trace', focus: { t: coopWorst.release, job: coopWorst.id, label: 'Insight: cooperative item' } }],
      })
    }

    // ---------------------------------------------------------------- lock hold (once inheritance is in place)
    // With the k_sem the inversion finding covers this; with the k_mutex the remaining wait is the hold itself.
    const blocked = sim.busIsMutex ? ctrl.filter((j) => j.holderRan > 0 && j.inv === 0) : []
    const blkWorst = blocked.length ? blocked.reduce((a, b) => (b.holderRan > a.holderRan ? b : a)) : null
    if (blkWorst) {
      const w = blkWorst.holderRan
      const s = sevOf(level('sched.ctrl_loop.blocked_us', w))
      if (s) out.push({
        id: 'hold', sev: s,
        title: 'storage holds the bus long enough to threaten ctrl_loop',
        detail: `Even with priority inheritance, ctrl_loop waits for the rest of storage's critical section. At ${sim.param('storage.chunk')} B per hold the section runs about ${f0(60 + sim.param('storage.chunk') * 0.55)} us before preemption.`,
        evidence: [`worst lock wait ${f0(w)} us (job ${blkWorst.id})`, `rule sched.ctrl_loop.blocked_us: ${limit('sched.ctrl_loop.blocked_us')}`],
        links: [{ label: 'Show it in Trace', view: 'trace', focus: { t: blkWorst.release, job: blkWorst.id } }],
        action: sim.param('storage.chunk') > 128 ? { label: 'Try storage.chunk = 128', param: { id: 'storage.chunk', value: 128 } } : undefined,
      })
    }

    // ---------------------------------------------------------------- heap
    const hbs = sim.heartbeats.slice(-600)
    if (hbs.length > 100) {
      const xs = hbs.map((h) => (h.t - hbs[0].t) / 1000), ys = hbs.map((h) => h.heap.byOwner[TH.MAIN])
      const f = linfit(xs, ys)
      const s = sevOf(level('heap.main.growth', f.b))
      if (s && f.b - f.ci95 > 0) {
        const last = hbs[hbs.length - 1]
        const room = last.heap.size - last.heap.alloc
        out.push({
          id: 'leak', sev: s,
          title: `Heap leak: main's live allocations grow ${f.b.toFixed(1)} B/s`,
          detail: 'Allocations by main (config snapshots, 72 B) are not all freed: the X-ray shows its old blocks accumulating between short-lived packet buffers. Rebuilt on the host from k_heap alloc / free trace events.',
          evidence: [`slope ${f.b.toFixed(1)} +/- ${f.ci95.toFixed(1)} B/s over ${f0(xs[xs.length - 1])} s (OLS, 95%)`, `${(room / 1024).toFixed(1)} KiB free: exhausted in about ${f0(room / f.b / 60)} min`, `rule heap.*.growth: ${limit('heap.main.growth')}`],
          spark: hbs.filter((_, i) => i % 20 === 0).map((h) => h.heap.byOwner[TH.MAIN]), sparkLabel: 'main live bytes, 60 s',
          links: [{ label: 'Memory: X-ray and leak cone', view: 'memory' }],
        })
      }
      const fr = hb ? hb.heap.frag * 100 : 0
      const fs = sevOf(level('heap._system_heap.frag_pct', fr))
      if (fs) out.push({ id: 'frag', sev: fs, title: `Heap fragmentation ${f0(fr)}%`, detail: 'The largest free run is a small share of the free bytes: a large allocation can fail with plenty free.', evidence: [`largest free ${(hb!.heap.largestFree / 1024).toFixed(1)} KiB of ${((hb!.heap.size - hb!.heap.alloc) / 1024).toFixed(1)} KiB free`], links: [{ label: 'Memory', view: 'memory' }] })
    }

    // ---------------------------------------------------------------- interrupt bursts
    const ethPeak = Math.max(0, ...sim.heartbeats.slice(-300).map((h) => h.irqs[2].perS))
    const es = sevOf(level('irq.eth0.per_s', ethPeak))
    if (es) out.push({
      id: 'irq', sev: es, title: `eth0 interrupt bursts reach ${(ethPeak / 1000).toFixed(1)}k/s`,
      detail: 'Network bursts (about 0.7 s every 6 to 10 s) multiply the Ethernet ISR rate twelvefold. During a burst net_rx is runnable most of the time, which is exactly when it preempts storage inside the bus lock.',
      evidence: [`peak ${f0(ethPeak)}/s in the last 30 s`, `rule irq.*.per_s: ${limit('irq.eth0.per_s')}`],
      spark: sim.heartbeats.slice(-300).filter((_, i) => i % 5 === 0).map((h) => h.irqs[2].perS), sparkLabel: 'eth0 IRQ/s, 30 s',
      links: [{ label: 'Live', view: 'live' }, { label: 'Objects', view: 'objects' }],
    })

    // ---------------------------------------------------------------- observer effect: link share of object events
    const recent = sim.heartbeats.slice(-300)
    if (recent.length) {
      const peak = recent.reduce((a, h) => (h.linkBps > a.linkBps ? h : a))
      const util = (peak.linkBps / LINK_BUDGET_BPS) * 100
      const ls = sevOf(level('link.util', util))
      if (ls) {
        const evB = peak.eventsPerS * EVENT_BYTES
        out.push({
          id: 'link', sev: ls, title: `Trace link peaks at ${f0(util)}% of the RTT budget`,
          detail: `Kernel-object events (an enter and exit pair per call) are ${f0((evB / peak.linkBps) * 100)}% of the bytes at the peak, on top of ${f0((peak.ctxPerS * SWITCH_BYTES / peak.linkBps) * 100)}% for context switches. Drops show as sequence gaps, never silently, but the margin is thin during network bursts.`,
          evidence: [`peak ${(peak.linkBps / 1e6).toFixed(2)} MB/s of ${(LINK_BUDGET_BPS / 1e6).toFixed(1)} MB/s, ${f0(peak.eventsPerS)} kernel events/s`, `rule link.util: ${limit('link.util')}`, 'options: trace only the object classes in question (CONFIG_TRACING_SEMAPHORE and siblings), filter by object in the zprof backend, or the compact format (PLANS.md section 8)'],
          spark: recent.filter((_, i) => i % 5 === 0).map((h) => (h.linkBps / LINK_BUDGET_BPS) * 100), sparkLabel: 'link use %, 30 s',
          links: [{ label: 'Live: link', view: 'live' }],
        })
      }
    }

    // ---------------------------------------------------------------- stacks
    if (hb) {
      const worst = hb.threads.filter((_, i) => i !== IDLE).map((s) => ({ s, m: (1 - s.stackHwm / s.stackSize) * 100 })).sort((a, b) => a.m - b.m)[0]
      const ss = sevOf(level(`stack.${worst.s.name}.margin`, worst.m))
      if (ss) out.push({ id: 'stack', sev: ss, title: `${worst.s.name} stack margin ${f0(worst.m)}%`, detail: 'The watermark (highest stack use since boot) leaves less than the configured margin. Stack overflow on the M55 trips the PSPLIM guard into a fatal error.', evidence: [`watermark ${worst.s.stackHwm} of ${worst.s.stackSize} B`, `rule stack.*.margin: ${limit(`stack.${worst.s.name}.margin`)}`], links: [{ label: 'Live: stack headroom', view: 'live' }, { label: 'Memory floor plan', view: 'memory' }] })
    }

    // ---------------------------------------------------------------- clock-domain drift (no threshold: info)
    const drift = spiDrift(sim)
    if (drift) out.push({
      id: 'drift', sev: 'info', title: `spi0_dma drifts ${drift.ppm.toFixed(0)} ppm against ctrl_tmr`,
      detail: 'The SPI DMA completes on the ADC\'s clock, not the kernel tick, so its phase walks through the control period. Sample age at ctrl_loop varies from 0 to one SPI period; the period raster in Timing shows it as a slant.',
      evidence: [`phase walks ${drift.usPerS.toFixed(1)} us per second (fit over ${drift.n} completions)`, 'not a fault: worth knowing when sample age matters to the control law'],
      links: [{ label: 'Timing: period raster', view: 'timing' }],
    })

    if (this.soakNote) out.push(this.soakNote)
    // Keep first-seen times across evaluations.
    const ids = new Set(out.map((o) => o.id))
    for (const k of [...this.seen.keys()]) if (!ids.has(k)) this.seen.delete(k)
    this.list = out.map((o) => {
      const s = this.seen.get(o.id) ?? { since: now, held: 0 }
      s.held++
      this.seen.set(o.id, s)
      return { ...o, since: s.since, held: s.held }
    }).sort((a, b) => RANK[a.sev] - RANK[b.sev])
    for (const f of this.listeners) f()
  }
}

const RANK: Record<Sev, number> = { crit: 0, warn: 1, info: 2 }
const CAUSE: Record<string, string> = { inversion: 'priority inversion', coop: 'cooperative work item', blocked: 'lock wait', preempt: 'preemption', isr: 'ISR time', clean: 'none' }
const OBJ = (o: number) => (o === OB.BUS_MTX ? 'bus_mtx' : 'bus_lock')
function limit(id: string) {
  const r = liveRule(id)
  if (!r) return 'no rule'
  const u = r.unit && r.unit !== 'count' ? ` ${r.unit}` : ''
  return `${r.warn !== undefined ? `warn ${r.op} ${r.warn}${u}` : ''}${r.warn !== undefined && r.crit !== undefined ? ', ' : ''}${r.crit !== undefined ? `crit ${r.op} ${r.crit}${u}` : ''}`
}
function clock(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`
}

/** Phase slope of SPI completions against the ctrl_tmr grid, from the event stream. */
function spiDrift(sim: TargetSim) {
  const E = sim.events
  const t1 = sim.now / 1000, t0 = t1 - 3000
  const xs: number[] = [], ys: number[] = []
  let prev = NaN, wrap = 0
  for (let id = E.lowerBound(t0); id < E.total; id++) {
    const k = id & (E.cap - 1)
    if (E.obj[k] !== OB.SPI_DONE || E.api[k] !== AP.SEM_GIVE) continue
    const t = E.t[k] * 1000
    let ph = t % 500
    if (prev === prev) {
      if (ph - prev > 250) wrap -= 500
      else if (prev - ph > 250) wrap += 500
    }
    prev = ph
    ph += wrap
    xs.push(t / 1e6)
    ys.push(ph)
  }
  if (xs.length < 200) return null
  const f = linfit(xs, ys)
  // A phase slope of 1 us per second against a 1 s timebase is 1 ppm.
  return { usPerS: f.b, ppm: Math.abs(f.b), n: xs.length }
}

/** The soak record: do failures cluster in one chamber phase? (binomial, one-sided) */
function soakClustering(): Insight | null {
  const soak = new SoakSim()
  const ev = soak.eventsSoFar().filter(isFailure)
  const n = ev.length
  if (n < 3) return null
  const cold = ev.filter((e) => { const p = e.h % 4; return p >= 3.25 && p < 3.75 })
  const k = cold.length, p = 0.125
  let tail = 0
  for (let i = k; i <= n; i++) {
    let c = 1
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1)
    tail += c * Math.pow(p, i) * Math.pow(1 - p, n - i)
  }
  if (tail > 0.05) return null
  const duts = new Set(cold.map((e) => DUTS[e.dut]))
  return {
    id: 'soak-cold', sev: 'warn', since: 0, held: 0,
    title: `Soak: ${k} of ${n} failures in the -20 C cold dwell`,
    detail: `The cold dwell is 12.5% of the chamber cycle, yet it holds ${k} of the ${n} failures so far (binomial p = ${tail.toFixed(3)}). They come from ${duts.size} DUTs (${[...duts].join(', ')}), so treat p as indicative: repeat failures on one unit are not independent.`,
    evidence: cold.map((e) => `${DUTS[e.dut]} at ${e.h.toFixed(2)} h: ${e.kind}, ${e.detail}`),
    links: [{ label: 'Thermal helix', view: 'helix' }, { label: 'Soak run', view: 'soak' }],
  }
}

let engine: InsightEngine | null = null
export function insights() {
  if (!engine) engine = new InsightEngine(targetSim())
  return engine
}

