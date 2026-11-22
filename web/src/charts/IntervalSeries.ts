// SPDX-License-Identifier: Apache-2.0
import { AxisTickStrategies, emptyLine, SolidFill, type Axis, type ChartXY, type Color } from 'sferic'
import { SeriesXY, type CursorHit, type ResultTableRows } from 'sferic/xy/series/SeriesXY'
import { RectBatch, type XYMaps } from 'sferic/render/draw'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import type { LegendSymbol } from 'sferic/core/Legend'
import type { Rect } from 'sferic/core/util'
import type { Bounds } from 'sferic/xy/store'

/**
 * Append-only lanes of [t0, t1) intervals (thread states, ISR spans, soak
 * uptime) plus instants (t1 === t0: resets, faults, deadline misses).
 *
 * Built for streaming: per-lane typed arrays sorted by start, eviction by a
 * retention window, binary-search culling and picking, and a level-of-detail
 * merge that folds runs of sub-pixel intervals into one rect per pixel so a
 * zoomed-out view of 10^5+ intervals stays one small instanced draw.
 *
 * Mockup note: it rebuilds a RectBatch from the visible range every frame.
 * The upstream Sferic version should orphan its instance buffer (bufferData)
 * instead of bufferSubData, per the lightning invariants.
 */
export interface IntervalState {
  name: string
  color: Color
  /** Bar height as a fraction of the lane (default 1). Thin bars suit "ready" states. */
  height?: number
}

export interface IntervalSeriesOptions {
  lanes: string[]
  states: IntervalState[]
  /** Fraction of the lane left empty above and below bars (default 0.12). */
  lanePad?: number
  /** Drop intervals that ended more than this many X units before the newest one. */
  retention?: number
  /** Cursor text for durations (X units in, text out). */
  formatDuration?: (d: number) => string
  /** Cursor text for positions. */
  formatTime?: (t: number) => string
  /** Draw labels inside intervals wider than this many CSS px (flame graphs). 0 disables. */
  labelMinPx?: number
  /** Custom cursor rows. */
  tooltip?: (hit: IntervalHit) => ResultTableRows
  axisX?: Axis
  axisY?: Axis
}

export interface IntervalHit {
  lane: number
  laneName: string
  t0: number
  t1: number
  state: IntervalState
  label: string | null
}

class Lane {
  n = 0
  head = 0
  t0 = new Float64Array(256)
  t1 = new Float64Array(256)
  st = new Uint8Array(256)
  lb = new Int32Array(256)
  maxDur = 0

  push(a: number, b: number, s: number, label: number) {
    if (this.n === this.t0.length) {
      if (this.head > this.n / 2) this.compact()
      else this.grow()
    }
    const i = this.n++
    this.t0[i] = a
    this.t1[i] = b
    this.st[i] = s
    this.lb[i] = label
    if (b - a > this.maxDur) this.maxDur = b - a
  }
  private grow() {
    const cap = this.t0.length * 2
    const t0 = new Float64Array(cap); t0.set(this.t0); this.t0 = t0
    const t1 = new Float64Array(cap); t1.set(this.t1); this.t1 = t1
    const st = new Uint8Array(cap); st.set(this.st); this.st = st
    const lb = new Int32Array(cap); lb.set(this.lb); this.lb = lb
  }
  private compact() {
    const h = this.head
    this.t0.copyWithin(0, h, this.n)
    this.t1.copyWithin(0, h, this.n)
    this.st.copyWithin(0, h, this.n)
    this.lb.copyWithin(0, h, this.n)
    this.n -= h
    this.head = 0
  }
  /** First index in [head, n) whose start is >= v. */
  lower(v: number) {
    let lo = this.head, hi = this.n
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (this.t0[m] < v) lo = m + 1
      else hi = m
    }
    return lo
  }
  evict(cutoff: number) {
    while (this.head < this.n && this.t1[this.head] < cutoff) this.head++
  }
  clear() { this.n = this.head = 0; this.maxDur = 0 }
}

export class IntervalSeries extends SeriesXY {
  private lanes: Lane[]
  private laneNames: string[]
  private states: IntervalState[]
  private colors: number[]
  private labels: string[] = []
  private labelIds = new Map<string, number>()
  private pad: number
  private retention: number
  private o: IntervalSeriesOptions
  private bars = new RectBatch()
  private ticks = new RectBatch()
  private xmin = Infinity
  private xmax = -Infinity
  private laneTicks: ReturnType<Axis['addCustomTick']>[] = []

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, o: IntervalSeriesOptions) {
    super(chart, ax, ay, colorIndex, 'Intervals')
    this.o = o
    this.laneNames = [...o.lanes]
    this.lanes = o.lanes.map(() => new Lane())
    this.states = o.states.map((s) => ({ ...s }))
    this.colors = this.states.map((s) => s.color.toUint32())
    this.pad = o.lanePad ?? 0.12
    this.retention = o.retention ?? Infinity
    this.effect = false
    this.autoScroll = true
  }

  get laneCount() { return this.lanes.length }
  /** Live intervals across all lanes. */
  count() { return this.lanes.reduce((a, l) => a + l.n - l.head, 0) }

  /** Append [t0, t1) in `lane`. Starts must not decrease within a lane. */
  append(lane: number, t0: number, t1: number, state: number, label?: string) {
    const ln = this.lanes[lane]
    if (!ln || !(t1 >= t0)) return this
    let id = -1
    if (label !== undefined) {
      id = this.labelIds.get(label) ?? -1
      if (id < 0) {
        id = this.labels.length
        this.labels.push(label)
        this.labelIds.set(label, id)
      }
    }
    ln.push(t0, t1, state, id)
    if (t0 < this.xmin) this.xmin = t0
    if (t1 > this.xmax) {
      this.xmax = t1
      if (this.retention < Infinity) {
        const cut = t1 - this.retention
        for (const l of this.lanes) l.evict(cut)
        this.xmin = Math.max(this.xmin, cut)
      }
    }
    return this
  }
  /** Instant event (drawn as a tick at least 2 px wide). */
  mark(lane: number, t: number, state: number, label?: string) { return this.append(lane, t, t, state, label) }

  clear() {
    for (const l of this.lanes) l.clear()
    this.labels = []
    this.labelIds.clear()
    this.xmin = Infinity
    this.xmax = -Infinity
    this.chart.onSeriesData(this)
    return this
  }
  /** Notify the chart after a batch of appends (one render request per batch). */
  commit() { this.chart.onSeriesData(this); return this }

  /** Lane names as Y custom ticks, no numeric ticks, Y fixed to the lanes, alternating lane bands. */
  setupLaneAxis(bands = true) {
    const ay = this.axisY
    const L = this.lanes.length
    ay.setTickStrategy(AxisTickStrategies.Empty)
    ay.setInterval({ start: 0, end: L, stopAxisAfter: true })
    ay.setMouseInteractions(false)
    this.laneTicks = this.laneNames.map((name, i) =>
      ay.addCustomTick().setValue(L - i - 0.5).setText(name).setGridStrokeStyle(emptyLine).setTickLength(0))
    if (bands) {
      const t = this.chart.getTheme()
      const fill = new SolidFill({ color: t.gridMinorColor })
      for (let i = 1; i < L; i += 2) {
        const b = ay.addBand()
        b.setValueStart(L - i - 1)
        b.setValueEnd(L - i)
        b.setFillStyle(fill)
        b.setStrokeStyle(emptyLine)
      }
    }
    return this
  }

  /** The text of a lane's label on the lane axis (after setupLaneAxis); cursor rows keep the lane's name. */
  setLaneLabel(lane: number, text: string) {
    this.laneTicks[lane]?.setText(text)
    return this
  }

  private laneY(li: number, s: number): [number, number] {
    const L = this.lanes.length
    const h = this.states[s]?.height ?? 1
    const top = L - li - this.pad, bot = L - 1 - li + this.pad
    if (h >= 1) return [bot, top]
    const mid = (top + bot) / 2, half = ((top - bot) * h) / 2
    return [mid - half, mid + half]
  }

  bounds(): Bounds | null {
    if (!(this.xmin <= this.xmax)) return null
    return { xmin: this.xmin, xmax: this.xmax, ymin: 0, ymax: this.lanes.length } as Bounds
  }

  drawGL(r: GLRenderer, maps: XYMaps, rect: Rect) {
    const x0 = maps.x0, x1 = maps.x1
    if (!(x1 > x0) || rect.w <= 0) return
    const upp = (x1 - x0) / rect.w // X units per CSS px
    const bars = this.bars, ticks = this.ticks
    bars.clear()
    ticks.clear()
    bars.setOrigin(x0, 0)
    ticks.setOrigin(x0, 0)
    for (let li = 0; li < this.lanes.length; li++) {
      const ln = this.lanes[li]
      if (ln.n === ln.head) continue
      // Merge state: a run of sub-pixel intervals collapses into one rect, colored by its longest member.
      let ms = NaN, me = 0, mc = 0, mlen = -1, my0 = 0, my1 = 0
      const flush = () => { if (ms === ms) bars.push(ms, my0, me, my1, mc); ms = NaN }
      for (let i = ln.lower(x0 - ln.maxDur); i < ln.n; i++) {
        const a = ln.t0[i]
        if (a > x1) break
        const e = ln.t1[i]
        if (e < x0) continue
        const s = ln.st[i]
        const [ya, yb] = this.laneY(li, s)
        if (e === a) {
          ticks.push(a, ya, a, yb, this.colors[s])
          continue
        }
        if (e - a >= upp) {
          flush()
          bars.push(a, ya, e, yb, this.colors[s])
          continue
        }
        if (ms === ms && a - me < upp) {
          if (e > me) me = e
          if (e - a > mlen) { mlen = e - a; mc = this.colors[s] }
          if (ya < my0) my0 = ya
          if (yb > my1) my1 = yb
        } else {
          flush()
          ms = a; me = e; mlen = e - a; mc = this.colors[s]; my0 = ya; my1 = yb
        }
      }
      flush()
    }
    bars.draw(r, maps, { minPx: 1 })
    ticks.draw(r, maps, { minPx: 2 })
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, rect: Rect) {
    const minPx = this.o.labelMinPx ?? 0
    if (!minPx || !this.labels.length) return
    const ax = this.axisX, ay = this.axisY
    const x0 = ax.pxToValue(rect.x), x1 = ax.pxToValue(rect.x + rect.w)
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1)
    const t = this.chart.getTheme()
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.w, rect.h)
    ctx.clip()
    ctx.font = `11px ${t.fontFamily}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = t.isDark ? '#0b0f18' : '#ffffff'
    for (let li = 0; li < this.lanes.length; li++) {
      const ln = this.lanes[li]
      const yc = ay.valueToPx(this.lanes.length - li - 0.5)
      if (yc < rect.y - 10 || yc > rect.y + rect.h + 10) continue
      for (let i = ln.lower(lo - ln.maxDur); i < ln.n; i++) {
        const a = ln.t0[i]
        if (a > hi) break
        if (ln.lb[i] < 0) continue
        const pa = Math.max(ax.valueToPx(a), rect.x), pb = Math.min(ax.valueToPx(ln.t1[i]), rect.x + rect.w)
        const w = pb - pa
        if (w < minPx) continue
        let s = this.labels[ln.lb[i]]
        const avail = w - 8
        if (ctx.measureText(s).width > avail) {
          while (s.length > 2 && ctx.measureText(s + '..').width > avail) s = s.slice(0, -1)
          s += '..'
        }
        ctx.fillText(s, pa + 4, yc)
      }
    }
    ctx.restore()
  }

  private hitAt(px: number, py: number): { li: number; i: number; d: number } | null {
    if (!Number.isFinite(py)) return null
    const L = this.lanes.length
    const li = L - 1 - Math.floor(this.axisY.pxToValue(py))
    const ln = this.lanes[li]
    if (!ln || ln.n === ln.head) return null
    const xv = this.axisX.pxToValue(px)
    const tol = Math.abs(this.axisX.pxToValue(px + 4) - xv)
    let best = -1, bd = Infinity
    for (let i = Math.max(ln.head, ln.lower(xv - ln.maxDur - tol)); i < ln.n; i++) {
      const a = ln.t0[i]
      if (a > xv + tol) break
      const e = ln.t1[i]
      const d = xv < a ? a - xv : xv > e ? xv - e : 0
      // Prefer containment, then instants (drawn on top), then the nearest edge.
      const score = d === 0 ? (e === a ? -1 : 0) : d
      if (score <= tol && score < bd) { bd = score; best = i }
    }
    return best < 0 ? null : { li, i: best, d: Math.max(0, bd) }
  }

  nearest(px: number, py: number, _byX: boolean): CursorHit | null {
    const h = this.hitAt(px, py)
    if (!h) return null
    const ln = this.lanes[h.li]
    const s = ln.st[h.i]
    const L = this.lanes.length
    const yc = L - h.li - 0.5
    const a = ln.t0[h.i], e = ln.t1[h.i]
    const x = Math.min(Math.max(this.axisX.pxToValue(px), a), e)
    return {
      series: this,
      x,
      y: yc,
      px: this.axisX.valueToPx(x),
      py: this.axisY.valueToPx(yc),
      color: this.states[s].color.setA(255),
      dist2: 0,
      extra: { lane: h.li, index: h.i },
    }
  }

  /** Interval under a cursor hit (for linked selections). */
  hitInfo(hit: CursorHit): IntervalHit | null {
    const li = hit.extra?.lane as number, i = hit.extra?.index as number
    const ln = this.lanes[li]
    if (!ln || i < ln.head || i >= ln.n) return null
    return {
      lane: li,
      laneName: this.laneNames[li],
      t0: ln.t0[i],
      t1: ln.t1[i],
      state: this.states[ln.st[i]],
      label: ln.lb[i] >= 0 ? this.labels[ln.lb[i]] : null,
    }
  }

  override tableRows(hit: CursorHit): ResultTableRows {
    const h = this.hitInfo(hit)
    if (!h) return []
    if (this.o.tooltip) return this.o.tooltip(h)
    const ft = this.o.formatTime ?? ((v: number) => this.axisX.formatCursor(v))
    const fd = this.o.formatDuration ?? ((v: number) => this.axisX.formatCursor(v))
    const rows: ResultTableRows = [[{ text: h.laneName, color: h.state.color.setA(255) }]]
    rows.push(['State:', h.label ?? h.state.name])
    rows.push([h.t1 === h.t0 ? 'At:' : 'Start:', ft(h.t0)])
    if (h.t1 > h.t0) rows.push(['Duration:', fd(h.t1 - h.t0)])
    return rows
  }

  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor() } }
  primaryColor(): Color { return this.states[0].color.setA(255) }

  override disposeGL(r: GLRenderer | null) {
    this.bars.dispose(r)
    this.ticks.dispose(r)
  }
}

/** `chart.addIntervalSeries(o)` equivalent for an out-of-tree series. */
export function addIntervalSeries(chart: ChartXY, o: IntervalSeriesOptions): IntervalSeries {
  const [ax, ay] = chart.resolveAxes(o)
  return chart.attachSeries(new IntervalSeries(chart, ax, ay, chart.allocColorIndex(), o))
}
