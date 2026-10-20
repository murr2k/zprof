import {
  AP, API, IRQS, LANES, OB, OBJECTS, PARAMS, RS, THREADS, laneOfThread, threadOfLane,
  type EventRing, type IntervalLog, type Job,
} from './target'
import { HEAP_BASE, hex } from './memmap'

/**
 * Window queries over the recorded streams: what the bridge's recording
 * store answers for a view that scrolls through time (PLANS.md section 5).
 * Everything here works on a live ring or on a frozen copy of one.
 */

/** Visit intervals overlapping [t0, t1] (ms). The log is in t1 order to within one ISR. */
export function intervalsIn(L: IntervalLog, t0: number, t1: number, fn: (lane: number, a: number, b: number, st: number) => void, slackMs = 10) {
  const cap = L.lane.length, start = (L.w - L.n + cap) % cap
  const target = t0 - 0.05
  let lo = 0, hi = L.n
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (L.t1[(start + m) % cap] < target) lo = m + 1
    else hi = m
  }
  for (let k = lo; k < L.n; k++) {
    const i = (start + k) % cap
    const a = L.t0[i], b = L.t1[i]
    if (b > t1 + slackMs) break
    if (b < t0 || a > t1) continue
    fn(L.lane[i], a, b, L.st[i])
  }
}
export function logSpan(L: IntervalLog) {
  const cap = L.lane.length
  if (!L.n) return { t0: 0, t1: 0 }
  return { t0: L.t0[(L.w - L.n + cap) % cap], t1: L.t1[(L.w - 1 + cap) % cap] }
}

/** Visit event ids with t in [t0, t1]. */
export function eventsIn(E: EventRing, t0: number, t1: number, fn: (id: number, slot: number) => void) {
  for (let id = E.lowerBound(t0); id < E.total; id++) {
    const k = id & (E.cap - 1)
    if (E.t[k] > t1) break
    fn(id, k)
  }
}

/** Objects used as locks (ownership spans), the rest carry a depth or count. */
export const LOCKS = new Set<number>([OB.BUS_LOCK, OB.BUS_MTX, OB.CFG_MTX])

export interface ObjSpan { obj: number; t0: number; t1: number; owner: number; level: number }
export interface BoostSpan { thread: number; t0: number; t1: number; prio: number }

/**
 * Object state over [t0, t1]: lock ownership (owner thread) and queue / semaphore
 * fill level (0..1), rebuilt from the events of a lookback window before t0.
 */
export function objectSpans(E: EventRing, t0: number, t1: number, lookMs = 30) {
  const spans: ObjSpan[] = []
  const boosts: BoostSpan[] = []
  const st = OBJECTS.map(() => ({ owner: -1, level: 0, since: t0 - lookMs }))
  const boost = THREADS.map(() => ({ prio: NaN, since: 0 }))
  const close = (o: number, t: number) => {
    const s = st[o]
    if ((s.owner >= 0 || s.level > 0) && t >= t0 && s.since <= t1) spans.push({ obj: o, t0: Math.max(s.since, t0), t1: Math.min(t, t1), owner: s.owner, level: s.level })
    s.since = t
  }
  eventsIn(E, t0 - lookMs, t1, (_id, k) => {
    const o = E.obj[k], api = E.api[k], res = E.res[k], t = E.t[k]
    const th = threadOfLane(E.ctx[k])
    if (api === AP.BOOST) { boost[th] = { prio: E.val[k], since: t }; return }
    if (api === AP.RESTORE) {
      const b = boost[th]
      if (b.prio === b.prio && t >= t0) boosts.push({ thread: th, t0: Math.max(b.since, t0), t1: Math.min(t, t1), prio: b.prio })
      boost[th] = { prio: NaN, since: 0 }
      return
    }
    if (o < 0) return
    const d = OBJECTS[o]
    if (LOCKS.has(o)) {
      if ((api === AP.SEM_TAKE || api === AP.MTX_LOCK) && res === RS.OK) { close(o, t); st[o].owner = th }
      else if ((api === AP.SEM_GIVE || api === AP.MTX_UNLOCK) && (res === RS.OK || res === RS.WAKES)) {
        close(o, t)
        st[o].owner = res === RS.WAKES ? threadOfLane(E.peer[k]) : -1
      }
      return
    }
    let lvl = NaN
    if (d.kind === 'msgq' || d.kind === 'fifo') {
      if (res === RS.OK && (api === AP.MSGQ_PUT || api === AP.FIFO_PUT || api === AP.MSGQ_GET || api === AP.FIFO_GET)) lvl = E.val[k] / d.cap
      else if (res === RS.FULL) lvl = 1
    } else if (d.kind === 'sem') {
      if (res === RS.OK && (api === AP.SEM_GIVE || api === AP.SEM_TAKE)) lvl = E.val[k] / Math.max(1, d.cap)
    }
    if (lvl === lvl && lvl !== st[o].level) { close(o, t); st[o].level = lvl }
  })
  for (let o = 0; o < st.length; o++) close(o, t1)
  for (let th = 0; th < boost.length; th++) {
    const b = boost[th]
    if (b.prio === b.prio) boosts.push({ thread: th, t0: Math.max(b.since, t0), t1, prio: b.prio })
  }
  return { spans, boosts }
}

export type LinkKind = 'signal' | 'handoff' | 'data' | 'block'
/** A causal arrow: from a context lane to an object, or from an object to the thread it woke. */
export interface Link { t0: number; from: number; t1: number; to: number; kind: LinkKind; fromObj: boolean; toObj: boolean; obj: number; id: number }

/** Arrows for the sequence view; lanes are sim lanes, objects are object indices (fromObj/toObj say which). */
export function links(E: EventRing, t0: number, t1: number): Link[] {
  const out: Link[] = []
  eventsIn(E, t0, t1, (id, k) => {
    const o = E.obj[k], api = E.api[k], res = E.res[k], t = E.t[k], ctx = E.ctx[k]
    if (o < 0 || o === OB.HEAP || api === AP.BOOST || api === AP.RESTORE) return
    if (res === RS.WAKES) {
      out.push({ t0: t, from: ctx, t1: t, to: o, kind: 'signal', fromObj: false, toObj: true, obj: o, id })
      // Pair with the woken thread's "returned after wait" on the same object.
      const peer = E.peer[k]
      let tr = t
      for (let j = id + 1, n = 0; j < E.total && n < 4000; j++, n++) {
        const q = j & (E.cap - 1)
        if (E.t[q] > t + 20) break
        if (E.ctx[q] === peer && E.obj[q] === o && E.res[q] === RS.WOKE) { tr = E.t[q]; break }
      }
      out.push({ t0: tr, from: o, t1: tr, to: peer, kind: LOCKS.has(o) ? 'handoff' : 'signal', fromObj: true, toObj: false, obj: o, id })
    } else if (res === RS.BLOCKS) {
      out.push({ t0: t, from: ctx, t1: t, to: o, kind: 'block', fromObj: false, toObj: true, obj: o, id })
    } else if (res === RS.OK || res === RS.FULL) {
      const into = api === AP.SEM_GIVE || api === AP.MSGQ_PUT || api === AP.FIFO_PUT || api === AP.MTX_UNLOCK || api === AP.WORK_SUBMIT || api === AP.EXPIRY
      if (api === AP.EXPIRY) out.push({ t0: t, from: ctx, t1: t, to: OB.CTRL_TMR, kind: 'signal', fromObj: false, toObj: true, obj: o, id })
      else if (into) out.push({ t0: t, from: ctx, t1: t, to: o, kind: 'data', fromObj: false, toObj: true, obj: o, id })
      else out.push({ t0: t, from: o, t1: t, to: ctx, kind: 'data', fromObj: true, toObj: false, obj: o, id })
    }
  })
  return out
}

// ---------------------------------------------------------------- text

export const laneName = (lane: number) => (lane >= 0 && lane < LANES.length ? (lane < IRQS.length ? `ISR ${IRQS[lane]}` : LANES[lane]) : '')
export const us = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v.toFixed(0)} us`)

export type Tone = 'crit' | 'warn' | 'ok' | 'wake' | 'param' | 'info' | 'dim'
/** Label text, tone and priority (0 = always shown) for one event. */
export function describe(E: EventRing, k: number): { text: string; tone: Tone; prio: number } {
  const o = E.obj[k], api = E.api[k], res = E.res[k], v = E.val[k], peer = E.peer[k]
  const on = o >= 0 ? OBJECTS[o].name : ''
  const call = `${API[api]}(${on})`
  switch (api) {
    case AP.MISS: return { text: `DEADLINE MISS: response ${us(v)} > 500 us (job ${E.aux[k]})`, tone: 'crit', prio: 0 }
    case AP.PARAM: {
      const p = PARAMS[E.aux[k]]
      const name = p ? p.id : '?'
      const val = p?.options ? p.options[v] ?? v : Number(v.toFixed(5))
      if (res === RS.STAGED) return { text: `zprof: ${name} = ${val} staged for ${laneName(peer)}`, tone: 'param', prio: 0 }
      if (res === RS.REJECTED) return { text: `zprof: ${name} = ${val} rejected`, tone: 'crit', prio: 0 }
      return { text: `${name} = ${val} applied at safe point`, tone: 'param', prio: 0 }
    }
    case AP.BOOST: return { text: `priority boost to ${v} (${on}, waiter ${laneName(peer)})`, tone: 'warn', prio: 1 }
    case AP.RESTORE: return { text: `priority restored to ${v} (${on})`, tone: 'info', prio: 1 }
    case AP.EXPIRY: return { text: `k_timer expiry(${on}), period ${v} us`, tone: 'dim', prio: 4 }
    case AP.MALLOC:
      if (res === RS.FAILED) return { text: `k_malloc(${v}) FAILED: heap exhausted or fragmented`, tone: 'crit', prio: 0 }
      return { text: `k_malloc(${v}) -> ${hex(HEAP_BASE + E.aux[k])}`, tone: 'dim', prio: 4 }
    case AP.FREE: return { text: `k_free(${hex(HEAP_BASE + E.aux[k])}) ${v} B`, tone: 'dim', prio: 4 }
  }
  switch (res) {
    case RS.BLOCKS: return { text: `${call} blocks${peer >= 0 ? `, held by ${laneName(peer)}` : ''}`, tone: peer >= 0 ? 'warn' : 'dim', prio: peer >= 0 ? 1 : 3 }
    case RS.WOKE: return { text: `${call} returned after ${us(v)}`, tone: LOCKS.has(o) ? 'warn' : 'ok', prio: LOCKS.has(o) ? 1 : 3 }
    case RS.WAKES: return { text: `${call} wakes ${laneName(peer)}`, tone: 'wake', prio: LOCKS.has(o) ? 1 : 2 }
    case RS.FULL: return { text: `${call} FULL, item dropped`, tone: 'crit', prio: 0 }
  }
  const d = o >= 0 ? OBJECTS[o] : null
  if (api === AP.MSGQ_GET && E.aux[k] > 0) return { text: `${call} drained ${E.aux[k]}`, tone: 'ok', prio: 3 }
  if (d && (d.kind === 'msgq' || d.kind === 'fifo')) return { text: `${call} -> ${v}/${d.cap}`, tone: 'ok', prio: 3 }
  if (d && d.kind === 'sem' && !LOCKS.has(o)) return { text: `${call} count ${v}`, tone: 'dim', prio: 3 }
  return { text: `${call} ok`, tone: LOCKS.has(o) ? 'info' : 'dim', prio: LOCKS.has(o) ? 2 : 3 }
}

/** Job of `thread` whose [release, end] contains t (jobs are in completion order). */
export function jobAt(jobs: Job[], thread: number, t: number): Job | null {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]
    if (j.thread !== thread) continue
    if (j.end < t) return null
    if (j.release <= t) return j
  }
  return null
}

/** Lanes of the sequence view: IRQs, threads by priority, then the kernel objects worth a lifeline. */
export const SEQ_OBJECTS = [OB.CTRL_TMR, OB.CTRL_TICK, OB.SPI_DONE, OB.SAMPLE_Q, OB.BUS_LOCK, OB.BUS_MTX, OB.RX_FIFO, OB.SYSWQ, OB.CFG_MTX]
export const seqLaneOfObj = (o: number) => { const i = SEQ_OBJECTS.indexOf(o as typeof SEQ_OBJECTS[number]); return i < 0 ? -1 : LANES.length + i }
export { laneOfThread }
