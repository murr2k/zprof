import { Panel, LUT, type Color, type Theme } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { HeatmapTexture, RectBatch, SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'

/**
 * Phase folding: every interval of the scheduler stream is cut at period
 * boundaries and accumulated by phase within the period. Two panels read the
 * same accumulator:
 *
 * - PhaseEye: per lane, the share of periods in which the lane ran at each
 *   phase (a digital-phosphor "scheduling eye"), with the occupancy profile
 *   drawn as a curve and an optional ghost baseline to compare against.
 *   Release jitter blurs edges; interference shows up as ghost bands.
 * - PeriodRaster: one column per period, phase running down, colored by the
 *   lane that owned each phase bin. A stable schedule is horizontal stripes;
 *   a clock-domain drift is a slant; a beat between rates is a moire.
 */
export interface FoldLane { name: string; color: Color }

export class PhaseFolder {
  readonly bins: number
  readonly nLanes: number
  period: number
  epoch: number
  /** Exponential average of per-period occupancy, [lane * bins + bin], 0..1. */
  occ: Float32Array
  baseline: Float32Array | null = null
  alpha = 1 / 800
  periods = 0
  private ring: { n: number; acc: Float32Array }[] = []
  private listeners: ((n: number, acc: Float32Array, tStartUs: number) => void)[] = []
  version = 0

  constructor(nLanes: number, bins: number, periodUs: number, epochUs: number) {
    this.nLanes = nLanes
    this.bins = bins
    this.period = periodUs
    this.epoch = epochUs
    this.occ = new Float32Array(nLanes * bins)
  }

  onPeriod(fn: (n: number, acc: Float32Array, tStartUs: number) => void) { this.listeners.push(fn) }

  /** New period or phase origin: start over (the baseline is kept, it may not line up). */
  reset(periodUs: number, epochUs: number) {
    this.period = periodUs
    this.epoch = epochUs
    this.occ.fill(0)
    this.ring = []
    this.periods = 0
    this.version++
  }
  setBaseline() { this.baseline = this.occ.slice(); this.version++ }
  clearBaseline() { this.baseline = null; this.version++ }

  private slot(n: number) {
    let s = this.ring.find((x) => x.n === n)
    if (s) return s
    // Finalize periods that can no longer receive data (intervals close at most a few ms late).
    this.ring.sort((a, b) => a.n - b.n)
    while (this.ring.length && this.ring[0].n < n - 6) this.finalize(this.ring.shift()!)
    s = { n, acc: new Float32Array(this.nLanes * this.bins) }
    this.ring.push(s)
    return s
  }
  private finalize(s: { n: number; acc: Float32Array }) {
    const a = this.periods < 50 ? 1 / (this.periods + 1) : this.alpha
    const binW = this.period / this.bins
    const occ = this.occ, acc = s.acc
    for (let i = 0; i < occ.length; i++) occ[i] += (Math.min(1, acc[i] / binW) - occ[i]) * a
    this.periods++
    this.version++
    for (const f of this.listeners) f(s.n, acc, this.epoch + s.n * this.period)
  }

  /** Accumulate [aUs, bUs] of `lane`. */
  add(lane: number, aUs: number, bUs: number) {
    if (lane < 0 || lane >= this.nLanes || !(bUs > aUs)) return
    const P = this.period, binW = P / this.bins
    let n = Math.floor((aUs - this.epoch) / P)
    let t = aUs
    while (t < bUs) {
      const pEnd = this.epoch + (n + 1) * P
      const e = Math.min(bUs, pEnd)
      const acc = this.slot(n).acc
      let ph = t - (this.epoch + n * P)
      const phEnd = e - (this.epoch + n * P)
      const base = lane * this.bins
      while (ph < phEnd - 1e-9) {
        const bi = Math.min(this.bins - 1, Math.floor(ph / binW))
        const binEnd = (bi + 1) * binW
        const seg = Math.min(phEnd, binEnd) - ph
        acc[base + bi] += seg
        ph += seg
      }
      t = e
      n++
    }
  }
}

export interface PhaseMarker { phase: number; label: string; color: Color }

interface FoldPanelOptions extends PanelOptions { surface?: Surface; [k: string]: unknown }

const fmtUs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 2 : 0)} ms` : `${v.toFixed(0)} us`)

// ---------------------------------------------------------------- eye

export class PhaseEye extends Panel {
  private fold: PhaseFolder | null = null
  private lanes: FoldLane[] = []
  private markers: PhaseMarker[] = []
  private cells = new RectBatch()
  private lines = new SegmentBatch()
  private ghost = new SegmentBatch()
  private marks = new SegmentBatch()
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private labelW = 92
  private builtVersion = -1
  private builtKey = ''
  private mouse: { x: number; y: number } | null = null

  constructor(o: FoldPanelOptions) {
    super(o)
    this.padding = { left: 8, right: 12, top: 8, bottom: 6 }
  }
  setFolder(f: PhaseFolder, lanes: FoldLane[]) { this.fold = f; this.lanes = lanes; this.builtVersion = -1; this.requestRender(); return this }
  setMarkers(m: PhaseMarker[]) { this.markers = m; this.builtVersion = -1; this.requestRender(); return this }
  /** Call after feeding the folder; rebuilds at most once per frame. */
  refresh() { this.requestRender(); return this }

  override layout(_ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    this.area = { x: c.x + this.labelW, y: c.y + 4, w: Math.max(10, c.w - this.labelW), h: Math.max(10, c.h - 26) }
    const key = `${c.x},${c.y},${c.w},${c.h}`
    if (this.fold && (this.fold.version !== this.builtVersion || key !== this.builtKey)) {
      this.builtVersion = this.fold.version
      this.builtKey = key
      this.build()
    }
  }

  private build() {
    const f = this.fold!, a = this.area, t = this.theme
    const cells = this.cells, lines = this.lines, ghost = this.ghost, marks = this.marks
    cells.clear(); lines.clear(); ghost.clear(); marks.clear()
    const rowH = a.h / this.lanes.length
    const bw = a.w / f.bins
    const gc = t.isDark ? 0xb4ffffff : 0xb4000000
    this.lanes.forEach((ln, li) => {
      const y0 = a.y + li * rowH + 1, y1 = a.y + (li + 1) * rowH - 1
      const base = li * f.bins
      cells.push(a.x, y0, a.x + a.w, y1, t.gridMinorColor.toUint32())
      let px = NaN, py = NaN, gx = NaN, gy = NaN
      for (let b = 0; b < f.bins; b++) {
        const v = f.occ[base + b]
        const x = a.x + b * bw
        if (v > 0.003) cells.push(x, y0, x + bw + 0.5, y1, ln.color.setA(Math.min(255, 30 + Math.pow(v, 0.55) * 225)).toUint32())
        const cy = y1 - v * (y1 - y0)
        if (px === px) lines.push(px, py, x + bw / 2, cy, ln.color.setA(255).toUint32())
        px = x + bw / 2; py = cy
        if (f.baseline) {
          const g = f.baseline[base + b]
          const gyy = y1 - g * (y1 - y0)
          if (gx === gx) ghost.push(gx, gy, x + bw / 2, gyy, gc)
          gx = x + bw / 2; gy = gyy
        }
      }
    })
    for (const m of this.markers) {
      const x = a.x + (m.phase / f.period) * a.w
      if (x >= a.x - 1 && x <= a.x + a.w + 1) marks.push(x, a.y - 2, x, a.y + a.h + 2, m.color.toUint32())
    }
  }

  override hasGL() { return !!this.fold }
  override drawGL(r: GLRenderer) {
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    r.scissor(this.rect)
    this.cells.draw(r, maps)
    r.glow = 1
    this.lines.draw(r, maps, 1.2)
    r.glow = 0
    this.ghost.draw(r, maps, 1.2)
    this.marks.draw(r, maps, 1.5)
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily, a = this.area, f = this.fold
    ctx.save()
    if (f) {
      const rowH = a.h / this.lanes.length
      ctx.font = `11px ${ff}`
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      this.lanes.forEach((ln, i) => {
        ctx.fillStyle = ln.color.setA(255).toCSS()
        ctx.fillText(ln.name, a.x - 8, a.y + (i + 0.5) * rowH, this.labelW - 10)
      })
      // Phase axis.
      ctx.font = `10.5px ${ff}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = t.tickLabelColor.toCSS()
      const steps = 5
      for (let i = 0; i <= steps; i++) ctx.fillText(fmtUs((f.period * i) / steps), a.x + (a.w * i) / steps, a.y + a.h + 6)
      for (const m of this.markers) {
        const x = a.x + (m.phase / f.period) * a.w
        ctx.fillStyle = m.color.setA(255).toCSS()
        ctx.textAlign = x > a.x + a.w - 60 ? 'right' : 'left'
        ctx.fillText(m.label, x + (ctx.textAlign === 'left' ? 4 : -4), a.y - 1)
      }
      if (this.mouse && rectContains(a, this.mouse.x, this.mouse.y)) {
        const li = Math.floor((this.mouse.y - a.y) / rowH)
        const b = Math.floor(((this.mouse.x - a.x) / a.w) * f.bins)
        const v = f.occ[li * f.bins + b] ?? 0
        const g = f.baseline ? f.baseline[li * f.bins + b] : NaN
        const rows = [`${this.lanes[li]?.name} at phase ${fmtUs(((b + 0.5) * f.period) / f.bins)}`, `ran in ${(v * 100).toFixed(1)}% of periods`]
        if (g === g) rows.push(`baseline ${(g * 100).toFixed(1)}%`)
        tip(ctx, t, this.rect, this.mouse.x, this.mouse.y, rows)
      }
    }
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  override onPointer(e: PointerInfo) {
    if (this.handleUI(e)) return true
    this.mouse = e.type === 'leave' ? null : { x: e.x, y: e.y }
    this.requestRender()
    return false
  }
  override disposeGL(r: GLRenderer | null) { this.cells.dispose(r); this.lines.dispose(r); this.ghost.dispose(r); this.marks.dispose(r) }
}

// ---------------------------------------------------------------- raster

export class PeriodRaster extends Panel {
  private tex: HeatmapTexture | null = null
  private stale: HeatmapTexture[] = []
  private lut: LUT | null = null
  private lanes: FoldLane[] = []
  private fold: PhaseFolder | null = null
  private starts: Float64Array
  private head = 0
  private filled = 0
  private every = 1
  private skip = 0
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private marks = new SegmentBatch()
  private markers: PhaseMarker[] = []
  private mouse: { x: number; y: number } | null = null
  readonly cap: number

  constructor(o: FoldPanelOptions & { columns?: number }) {
    super(o)
    this.cap = o.columns ?? 640
    this.starts = new Float64Array(this.cap)
    this.padding = { left: 8, right: 12, top: 8, bottom: 6 }
  }

  setFolder(f: PhaseFolder, lanes: FoldLane[]) {
    this.fold = f
    this.lanes = lanes
    this.tex = this.newTex()
    // Categorical palette: value i + 0.5 is lane i; -0.5 (nothing ran) is transparent. A sentinel
    // instead of NaN, because the NaN test in the heatmap shader can be compiled away.
    const none = lanes[0].color.setA(0)
    this.lut = new LUT({
      interpolate: false,
      steps: [{ value: -1, color: none }, ...lanes.map((l, i) => ({ value: i, color: l.color.setA(255) })), { value: lanes.length, color: lanes[lanes.length - 1].color.setA(255) }],
    })
    this.filled = 0
    this.head = 0
    f.onPeriod((_n, acc, t0) => this.push(acc, t0))
    this.requestRender()
    return this
  }
  setMarkers(m: PhaseMarker[]) { this.markers = m; this.requestRender(); return this }
  /** Keep one column per `n` periods. */
  setDecimation(n: number) { this.every = Math.max(1, n); this.skip = 0; return this }
  private newTex() {
    const tex = new HeatmapTexture(this.cap, this.fold!.bins, this.cap)
    tex.data.fill(-0.5)
    return tex
  }
  clear() {
    if (!this.tex || !this.fold) return this
    // Released on the next GL pass, where the renderer that owns the texture is at hand.
    this.stale.push(this.tex)
    this.tex = this.newTex()
    this.filled = 0
    this.head = 0
    this.requestRender()
    return this
  }

  private push(acc: Float32Array, t0: number) {
    if (!this.tex || !this.fold) return
    if (this.skip++ % this.every) return
    const f = this.fold, binW = f.period / f.bins
    const col = new Float32Array(f.bins)
    for (let b = 0; b < f.bins; b++) {
      let best = -1, bv = binW * 0.3
      for (let l = 0; l < f.nLanes; l++) { const v = acc[l * f.bins + b]; if (v > bv) { bv = v; best = l } }
      col[b] = best < 0 ? -0.5 : best + 0.5
    }
    this.tex.pushColumns([col])
    this.starts[this.head] = t0
    this.head = (this.head + 1) % this.cap
    this.filled = Math.min(this.cap, this.filled + 1)
  }

  /** Target time (us) at a pointer position, for jumping to the trace. */
  timeAt(x: number, y: number): number | null {
    const a = this.area, f = this.fold
    if (!f || !rectContains(a, x, y) || !this.filled) return null
    const ci = Math.floor(((x - a.x) / a.w) * this.cap)
    const first = this.filled < this.cap ? 0 : this.head
    if (ci >= this.filled) return null
    const slot = (first + ci) % this.cap
    return this.starts[slot] + ((y - a.y) / a.h) * f.period
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    this.area = { x: c.x + 52, y: c.y + 4, w: Math.max(10, c.w - 52), h: Math.max(10, c.h - 26) }
    this.marks.clear()
    if (this.fold) for (const m of this.markers) {
      const y = this.area.y + (m.phase / this.fold.period) * this.area.h
      this.marks.push(this.area.x, y, this.area.x + this.area.w, y, m.color.toUint32())
    }
  }
  override hasGL() { return !!this.tex }
  override drawGL(r: GLRenderer) {
    for (const s of this.stale) s.dispose(r)
    this.stale = []
    if (!this.tex || !this.lut) return
    const a = this.area
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    r.scissor(a)
    this.tex.draw(r, maps, { x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h }, this.lut, { visibleCols: this.cap })
    r.scissor(this.rect)
    this.marks.draw(r, maps, 1.5)
    r.scissor(null)
  }
  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily, a = this.area, f = this.fold
    ctx.save()
    ctx.strokeStyle = t.gridMajorColor.toCSS()
    ctx.strokeRect(a.x - 0.5, a.y - 0.5, a.w + 1, a.h + 1)
    if (f) {
      ctx.font = `10.5px ${ff}`
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (let i = 0; i <= 4; i++) ctx.fillText(fmtUs((f.period * i) / 4), a.x - 6, a.y + (a.h * i) / 4)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const span = (this.cap * this.every * f.period) / 1e6
      ctx.fillText(`${this.every > 1 ? `one column per ${this.every} periods, ` : ''}${span.toFixed(span < 2 ? 2 : 1)} s across, newest right`, a.x + a.w / 2, a.y + a.h + 6)
      for (const m of this.markers) {
        const y = a.y + (m.phase / f.period) * a.h
        ctx.fillStyle = m.color.setA(255).toCSS()
        ctx.textAlign = 'right'
        ctx.textBaseline = 'bottom'
        ctx.fillText(m.label, a.x + a.w - 4, y - 2)
      }
      if (this.mouse && this.tex && rectContains(a, this.mouse.x, this.mouse.y)) {
        const ci = Math.floor(((this.mouse.x - a.x) / a.w) * this.cap)
        const bi = Math.floor(((this.mouse.y - a.y) / a.h) * f.bins)
        if (ci < this.filled) {
          const first = this.filled < this.cap ? 0 : this.head
          const slot = (first + ci) % this.cap
          const v = this.tex.data[bi * this.tex.texW + slot]
          const ln = v >= 0 ? this.lanes[Math.floor(v)]?.name : 'idle'
          tip(ctx, t, this.rect, this.mouse.x, this.mouse.y, [`${ln}`, `phase ${fmtUs(((bi + 0.5) * f.period) / f.bins)}`, 'click: open this period in Trace'])
        }
      }
    }
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }
  override onPointer(e: PointerInfo) {
    if (this.handleUI(e)) return true
    this.mouse = e.type === 'leave' ? null : { x: e.x, y: e.y }
    if (e.type === 'click') {
      const tUs = this.timeAt(e.x, e.y)
      if (tUs !== null) { this.emit('periodclick', { tUs }); return true }
    }
    if (e.type === 'move') this.surface.setCursor(rectContains(this.area, e.x, e.y) ? 'pointer' : 'default')
    this.requestRender()
    return false
  }
  override disposeGL(r: GLRenderer | null) {
    for (const s of this.stale) s.dispose(r)
    this.stale = []
    this.tex?.dispose(r)
    this.marks.dispose(r)
  }
}

function tip(ctx: CanvasRenderingContext2D, t: Theme, bounds: Rect, x: number, y: number, rows: string[]) {
  ctx.font = `11px ${t.fontFamily}`
  const w = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 16
  const h = rows.length * 15 + 10
  let bx = x + 12, by = y + 12
  if (bx + w > bounds.x + bounds.w) bx = x - w - 12
  if (by + h > bounds.y + bounds.h) by = y - h - 8
  roundRect(ctx, bx, by, w, h, 5)
  ctx.fillStyle = t.cursor.tableFill.toCSS()
  ctx.fill()
  ctx.strokeStyle = t.cursor.tableStroke.toCSS()
  ctx.stroke()
  ctx.fillStyle = t.cursor.textColor.toCSS()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  rows.forEach((r, i) => ctx.fillText(r, bx + 8, by + 6 + i * 15))
}
