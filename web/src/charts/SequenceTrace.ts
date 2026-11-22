// SPDX-License-Identifier: Apache-2.0
import { Panel, type Color } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { RectBatch, SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'
import { drawStatusGlyph, statusColor, type Status } from './status'

/**
 * Vertical sequence trace: time runs down, lanes are columns (ISRs, threads,
 * then kernel objects as lifelines), causal arrows run across lanes at the
 * moment they happen, and an event field to the right holds horizontal
 * annotations tied to their instants by leader lines. Swapping the axes is
 * what makes room to annotate every kernel call in plain text.
 *
 * Generic over a SeqSource that answers one time window at a time, so it
 * reads a live ring or a frozen recording alike. Everything geometric is
 * built in CSS px and drawn through the shared GL pass (RectBatch and
 * SegmentBatch with an identity map); text is 2D overlay.
 *
 * Interaction: wheel scrolls time, Ctrl+wheel zooms at the pointer, drag pans,
 * double-click zooms in, click selects an annotation or a span.
 */
export type Tone = 'crit' | 'warn' | 'ok' | 'wake' | 'param' | 'info' | 'dim'
export interface SeqLane { name: string; kind: 'irq' | 'thread' | 'object'; color: Color; sub?: string }
/** w: width as a fraction of the lane; x: left offset fraction (default centered). */
export interface SeqSpan { lane: number; t0: number; t1: number; color: number; w: number; x?: number }
export interface SeqItem { id: number; t: number; lane: number; text: string; tone: Tone; prio: number }
export interface SeqLink { t0: number; lane0: number; t1: number; lane1: number; color: number; id: number }
export interface SeqMark { lane: number; t: number; color: number }
export interface SeqFrame { spans: SeqSpan[]; items: SeqItem[]; links: SeqLink[]; marks: SeqMark[] }
export interface SeqSource {
  frame(t0: number, t1: number, upp: number): SeqFrame
  /** Recorded range (ms). */
  range(): { t0: number; t1: number }
  /** Tooltip rows for a span under the pointer. */
  spanInfo?(lane: number, t: number): string[] | null
}
export interface SeqBand { t0: number; t1: number; label: string; color: Color }

export interface SequenceTraceOptions extends PanelOptions {
  surface?: Surface
  [k: string]: unknown
}

interface Col { x: number; w: number; cx: number }
interface Box { item: SeqItem; x: number; y: number; w: number; h: number; ay: number; ax: number }

const HDR = 96
const RULER = 86
const ROW = 19
const FIELD_GAP = 30

const TONE_STATUS: Partial<Record<Tone, Status>> = { crit: 'crit', warn: 'warn', ok: 'ok', param: 'info' }

export class SequenceTrace extends Panel {
  private lanes: SeqLane[] = []
  private src: SeqSource | null = null
  private t0 = 0
  /** ms per CSS px. */
  private upp = 0.004
  private cols: Col[] = []
  private plot: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private field: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private frame: SeqFrame | null = null
  private frameKey = ''
  private boxes: Box[] = []
  private hiddenN = 0
  private hover: Box | null = null
  private hoverSpan: { lane: number; t: number; rows: string[] } | null = null
  private selected = -1
  private band: SeqBand | null = null
  private mouse: { x: number; y: number } | null = null
  private drag: { y: number; t0: number; moved: boolean } | null = null
  private dirty = true
  private pending: { t: number; upp: number; at: number } | null = null
  private bg = new RectBatch()
  private spanB = new RectBatch()
  private boxB = new RectBatch()
  private hiB = new RectBatch()
  private gridB = new SegmentBatch()
  private lifeB = new SegmentBatch()
  private linkB = new SegmentBatch()
  private leadB = new SegmentBatch()
  private hiLinkB = new SegmentBatch()

  constructor(o: SequenceTraceOptions) {
    super(o)
    this.padding = { left: 6, right: 8, top: 8, bottom: 6 }
  }

  setLanes(l: SeqLane[]) { this.lanes = l; this.invalidate(); return this }
  setSource(s: SeqSource) { this.src = s; this.invalidate(); return this }
  /** Data changed (new snapshot, live tail): rebuild the window. */
  invalidate() { this.dirty = true; this.frameKey = ''; this.requestRender(); return this }
  getView() { return { t0: this.t0, t1: this.t0 + this.plot.h * this.upp, upp: this.upp } }
  setView(t0: number, upp = this.upp) {
    this.upp = Math.min(0.5, Math.max(0.0005, upp))
    this.t0 = t0
    this.dirty = true
    this.requestRender()
    this.emit('viewchange', this.getView())
    return this
  }
  /** Put t at a fraction of the height (default one third down); waits for the first layout. */
  centerOn(t: number, upp = this.upp, at = 1 / 3) {
    if (this.plot.h < 20) { this.pending = { t, upp, at }; this.upp = upp; this.requestRender(); return this }
    return this.setView(t - this.plot.h * upp * at, upp)
  }
  /** Keep the newest time at the bottom edge. */
  tail(t1: number) { return this.centerOn(t1, this.upp, 1) }
  zoom(f: number, aroundY?: number) {
    const y = aroundY ?? this.plot.y + this.plot.h / 3
    const tm = this.t0 + (y - this.plot.y) * this.upp
    const upp = Math.min(0.5, Math.max(0.0005, this.upp * f))
    return this.setView(tm - (y - this.plot.y) * upp, upp)
  }
  setSelected(id: number) { this.selected = id; this.dirty = true; this.requestRender(); return this }
  getSelected() { return this.selected }
  setBand(b: SeqBand | null) { this.band = b; this.dirty = true; this.requestRender(); return this }
  get uppMs() { return this.upp }

  private yOf(t: number) { return this.plot.y + (t - this.t0) / this.upp }
  private tOf(y: number) { return this.t0 + (y - this.plot.y) * this.upp }

  // ---------------------------------------------------------------- layout

  override layout(ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    const top = c.y + HDR
    let x = c.x + RULER
    this.cols = this.lanes.map((l, i) => {
      if (i > 0 && l.kind !== this.lanes[i - 1].kind) x += 10
      const w = l.kind === 'irq' ? 16 : l.kind === 'thread' ? 22 : 26
      const col = { x, w, cx: x + w / 2 }
      x += w + 2
      return col
    })
    const lanesRight = x
    this.plot = { x: c.x + RULER, y: top, w: lanesRight - (c.x + RULER), h: Math.max(10, c.y + c.h - top) }
    this.field = { x: lanesRight + FIELD_GAP, y: top, w: Math.max(60, c.x + c.w - lanesRight - FIELD_GAP), h: this.plot.h }
    if (this.pending && this.plot.h >= 20) {
      const pc = this.pending
      this.pending = null
      this.upp = pc.upp
      this.t0 = pc.t - this.plot.h * pc.upp * pc.at
      this.emit('viewchange', this.getView())
    }
    const key = `${this.t0},${this.upp},${c.w},${c.h}`
    if (this.src && (this.dirty || key !== this.frameKey)) {
      this.frameKey = key
      const t1 = this.t0 + this.plot.h * this.upp
      this.frame = this.src.frame(this.t0, t1, this.upp)
      this.layoutLabels(ctx)
      this.build()
      this.dirty = false
    }
  }

  /** Greedy top-down placement in time order, after keeping the most important items that fit. */
  private layoutLabels(ctx: CanvasRenderingContext2D) {
    const f = this.frame!
    const fd = this.field
    const cap = Math.max(1, Math.floor(fd.h / (ROW + 2)))
    let items = f.items
    this.hiddenN = 0
    if (items.length > cap * 0.9) {
      const keep = Math.floor(cap * 0.9)
      const ranked = [...items].sort((a, b) => a.prio - b.prio || (a.id === this.selected ? -1 : b.id === this.selected ? 1 : 0))
      const kept = new Set(ranked.slice(0, keep).map((i) => i.id))
      if (this.selected >= 0) kept.add(this.selected)
      this.hiddenN = items.length - kept.size
      items = items.filter((i) => kept.has(i.id))
    }
    ctx.font = `11px ${this.theme.fontFamily}`
    const boxes: Box[] = []
    let bottom = fd.y
    for (const it of items) {
      const ay = this.yOf(it.t)
      const w = Math.min(fd.w - 8, ctx.measureText(it.text).width + 26)
      const y = Math.max(ay - ROW / 2, bottom + 2)
      const col = this.cols[it.lane]
      boxes.push({ item: it, x: fd.x, y, w, h: ROW, ay, ax: col ? col.cx : fd.x })
      bottom = y + ROW
    }
    // Overflowed past the bottom: push back up, keeping order.
    let limit = fd.y + fd.h
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i]
      if (b.y + b.h > limit) b.y = limit - b.h
      limit = b.y - 2
    }
    this.boxes = boxes.filter((b) => b.y >= fd.y - 1)
  }

  private build() {
    const t = this.theme
    const f = this.frame!
    const p = this.plot
    const c = this.content
    const bg = this.bg, spans = this.spanB, boxes = this.boxB, hi = this.hiB
    const grid = this.gridB, life = this.lifeB, links = this.linkB, lead = this.leadB, hil = this.hiLinkB
    for (const b of [bg, spans, boxes, hi]) b.clear()
    for (const b of [grid, life, links, lead, hil]) b.clear()
    const band = t.gridMinorColor.toUint32()
    // Lane backgrounds: alternate threads, tint object lifelines.
    this.cols.forEach((col, i) => {
      const k = this.lanes[i].kind
      if (k === 'object') bg.push(col.x, p.y, col.x + col.w, p.y + p.h, this.lanes[i].color.setA(t.isDark ? 18 : 22).toUint32())
      else if (i % 2 === 0) bg.push(col.x, p.y, col.x + col.w, p.y + p.h, band)
    })
    // Time grid across lanes and field.
    const { step } = this.tickStep()
    const gc = t.gridMajorColor.setA(t.isDark ? 120 : 160).toUint32()
    for (let tt = Math.ceil(this.t0 / step) * step; this.yOf(tt) <= p.y + p.h; tt += step) {
      const y = this.yOf(tt)
      grid.push(c.x + RULER - 6, y, this.field.x + this.field.w, y, gc)
    }
    // Lifelines: dashed center line per object lane.
    const lc = t.tickColor.setA(150).toUint32()
    this.cols.forEach((col, i) => {
      if (this.lanes[i].kind !== 'object') return
      for (let y = p.y; y < p.y + p.h; y += 8) life.push(col.cx, y, col.cx, Math.min(y + 4, p.y + p.h), lc)
    })
    // Selected job band.
    if (this.band) {
      const y0 = Math.max(p.y, this.yOf(this.band.t0)), y1 = Math.min(p.y + p.h, this.yOf(this.band.t1))
      if (y1 > y0) bg.push(p.x - 4, y0, this.field.x + this.field.w, Math.max(y0 + 1, y1), this.band.color.setA(t.isDark ? 34 : 40).toUint32())
    }
    // Spans, merged per lane when sub-pixel.
    for (const s of f.spans) {
      const col = this.cols[s.lane]
      if (!col) continue
      const y0 = this.yOf(s.t0), y1 = this.yOf(s.t1)
      if (y1 < p.y || y0 > p.y + p.h) continue
      const w = col.w * s.w
      const x0 = s.x === undefined ? col.cx - w / 2 : col.x + col.w * s.x
      spans.push(x0, Math.max(p.y, y0), x0 + w, Math.min(p.y + p.h, Math.max(y0 + 1, y1)), s.color)
    }
    for (const m of f.marks) {
      const col = this.cols[m.lane]
      if (!col) continue
      const y = this.yOf(m.t)
      spans.push(col.x - 3, y - 1.5, col.x + col.w + 3, y + 1.5, m.color)
    }
    // Arrows.
    const sel = this.selected
    for (const l of f.links) {
      const a = this.cols[l.lane0], b = this.cols[l.lane1]
      if (!a || !b) continue
      const ya = this.yOf(l.t0), yb = this.yOf(l.t1)
      const dir = b.cx >= a.cx ? 1 : -1
      const xa = a.cx + dir * a.w * 0.3, xb = b.cx - dir * b.w * 0.3
      const tgt = l.id === sel ? hil : links
      tgt.push(xa, ya, xb, yb, l.color)
      const ang = Math.atan2(yb - ya, xb - xa)
      for (const s of [-0.45, 0.45]) tgt.push(xb, yb, xb - 6 * Math.cos(ang + s), yb - 6 * Math.sin(ang + s), l.color)
    }
    // Event field: boxes, accent bars, leader lines.
    const fill = t.uiFill.toUint32()
    for (const b of this.boxes) {
      const tone = this.toneColor(b.item.tone)
      const isSel = b.item.id === sel
      boxes.push(b.x, b.y, b.x + b.w, b.y + b.h, b.item.tone === 'crit' ? tone.mix(t.uiFill, 0.78).toUint32() : fill)
      boxes.push(b.x, b.y + 2, b.x + 3, b.y + b.h - 2, tone.toUint32())
      const lcol = (isSel ? tone : tone.setA(t.isDark ? 110 : 140)).toUint32()
      const ex = this.field.x - FIELD_GAP + 6
      const tgt = isSel ? hil : lead
      tgt.push(b.ax, b.ay, ex, b.ay, lcol)
      tgt.push(ex, b.ay, b.x, b.y + b.h / 2, lcol)
      if (isSel || b === this.hover) hi.push(b.x - 1, b.y - 1, b.x + b.w + 1, b.y + b.h + 1, tone.setA(isSel ? 120 : 70).toUint32())
    }
  }

  private toneColor(tone: Tone): Color {
    const t = this.theme
    switch (tone) {
      case 'crit': return statusColor(t, 'crit')
      case 'warn': return statusColor(t, 'warn')
      case 'ok': return statusColor(t, 'ok')
      case 'wake': return t.seriesColors[0]
      case 'param': return t.examples.highlightColor
      case 'info': return t.seriesColors[6 % t.seriesColors.length]
      default: return t.minorTickLabelColor
    }
  }

  /** Grid step in ms, aiming at about 80 px between labels. */
  private tickStep() {
    const target = this.upp * 80
    const pow = Math.pow(10, Math.floor(Math.log10(target)))
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target) ?? pow * 10
    return { step }
  }

  // ---------------------------------------------------------------- draw

  override hasGL() { return true }

  override drawGL(r: GLRenderer) {
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    const c = this.content
    r.scissor({ x: c.x, y: this.plot.y, w: c.w, h: this.plot.h })
    this.bg.draw(r, maps)
    this.gridB.draw(r, maps, 1)
    this.lifeB.draw(r, maps, 1)
    this.spanB.draw(r, maps, { minPx: 1 })
    this.linkB.draw(r, maps, 1.2)
    this.leadB.draw(r, maps, 1)
    this.boxB.draw(r, maps, { radius: 3 })
    r.glow = 1
    this.hiB.draw(r, maps, { radius: 4 })
    this.hiLinkB.draw(r, maps, 2)
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily
    const c = this.content, p = this.plot
    ctx.save()
    // Lane headers, rotated so they read bottom to top.
    ctx.font = `11px ${ff}`
    ctx.textBaseline = 'middle'
    this.cols.forEach((col, i) => {
      const l = this.lanes[i]
      ctx.save()
      ctx.translate(col.cx, p.y - 6)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'left'
      ctx.fillStyle = (l.kind === 'object' ? t.tickLabelColor : l.color.setA(255)).toCSS()
      ctx.fillText(l.name, 0, 0, HDR - 26)
      ctx.restore()
    })
    // Group captions above the headers.
    ctx.font = `600 9.5px ${ff}`
    ctx.fillStyle = t.minorTickLabelColor.toCSS()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const groups: [string, string][] = [['irq', 'ISR'], ['thread', 'THREADS'], ['object', 'OBJECTS']]
    for (const [k, label] of groups) {
      const i = this.lanes.findIndex((l) => l.kind === k)
      if (i >= 0) ctx.fillText(label, this.cols[i].x, c.y)
    }
    ctx.fillText('EVENTS', this.field.x, c.y)
    if (this.hiddenN > 0) {
      ctx.textAlign = 'right'
      ctx.font = `10px ${ff}`
      ctx.fillText(`${this.hiddenN} lower-priority events hidden at this zoom`, this.field.x + this.field.w, c.y)
    }
    // Ruler.
    const { step } = this.tickStep()
    ctx.font = `10.5px ${ff}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = t.tickLabelColor.toCSS()
    ctx.beginPath()
    ctx.rect(c.x, p.y, c.w, p.h)
    ctx.clip()
    for (let tt = Math.ceil(this.t0 / step) * step; this.yOf(tt) <= p.y + p.h; tt += step) ctx.fillText(fmtRuler(tt, step), c.x + RULER - 10, this.yOf(tt))
    ctx.restore()
    ctx.save()
    ctx.font = `10px ${ff}`
    ctx.fillStyle = t.minorTickLabelColor.toCSS()
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`${fmtHM(this.t0)}  s.ms us`, c.x + RULER - 10, c.y + 14)
    ctx.fillText(`${fmtScale(this.upp)}/px`, c.x + RULER - 10, c.y + 28)
    // Band label.
    if (this.band) {
      const y = this.yOf(this.band.t0)
      if (y >= p.y && y <= p.y + p.h) {
        ctx.textAlign = 'left'
        ctx.font = `600 10.5px ${ff}`
        ctx.fillStyle = this.band.color.setA(255).toCSS()
        ctx.fillText(this.band.label, c.x + 2, Math.max(p.y + 2, y + 2), RULER - 6)
      }
    }
    // Event field text.
    ctx.beginPath()
    ctx.rect(this.field.x, p.y, this.field.w, p.h)
    ctx.clip()
    ctx.font = `11px ${ff}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const b of this.boxes) {
      const st = TONE_STATUS[b.item.tone]
      const tc = this.toneColor(b.item.tone)
      if (st) drawStatusGlyph(ctx, st, b.x + 12, b.y + b.h / 2, 3.6, tc.toCSS())
      ctx.fillStyle = (b.item.tone === 'dim' ? t.tickLabelColor : t.titleColor).toCSS()
      ctx.fillText(b.item.text, b.x + 20, b.y + b.h / 2 + 0.5, b.w - 24)
    }
    ctx.restore()
    // Cursor line and readout.
    if (this.mouse && rectContains({ x: c.x, y: p.y, w: c.w, h: p.h }, this.mouse.x, this.mouse.y) && !this.drag?.moved) {
      const y = this.mouse.y
      ctx.save()
      ctx.strokeStyle = t.cursor.lineColor.toCSS()
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(c.x + RULER - 4, y + 0.5)
      ctx.lineTo(this.field.x - 4, y + 0.5)
      ctx.stroke()
      ctx.restore()
      this.tooltip(ctx, this.mouse.x, y, this.hover ? [this.hover.item.text, `at ${fmtFull(this.hover.item.t)}`] : this.hoverSpan ? this.hoverSpan.rows : [fmtFull(this.tOf(y))])
    }
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private tooltip(ctx: CanvasRenderingContext2D, x: number, y: number, rows: string[]) {
    const t = this.theme
    ctx.save()
    ctx.font = `11px ${t.fontFamily}`
    const w = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 16
    const h = rows.length * 15 + 10
    let bx = x + 14, by = y + 12
    if (bx + w > this.rect.x + this.rect.w) bx = x - w - 14
    if (by + h > this.rect.y + this.rect.h) by = y - h - 12
    roundRect(ctx, bx, by, w, h, 5)
    ctx.fillStyle = t.cursor.tableFill.toCSS()
    ctx.fill()
    ctx.strokeStyle = t.cursor.tableStroke.toCSS()
    ctx.stroke()
    ctx.fillStyle = t.cursor.textColor.toCSS()
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    rows.forEach((r, i) => ctx.fillText(r, bx + 8, by + 6 + i * 15))
    ctx.restore()
  }

  // ---------------------------------------------------------------- interaction

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const c = this.content, p = this.plot
    const inside = rectContains({ x: c.x, y: p.y, w: c.w, h: p.h }, e.x, e.y)
    switch (e.type) {
      case 'wheel': {
        if (!inside) return false
        if (e.ctrlKey || e.altKey) this.zoom(e.deltaY > 0 ? 1.18 : 1 / 1.18, e.y)
        else this.setView(this.t0 + e.deltaY * this.upp * 0.8)
        this.emit('userscroll', {})
        return true
      }
      case 'down':
        if (!inside) return false
        this.drag = { y: e.y, t0: this.t0, moved: false }
        return true
      case 'move': {
        this.mouse = { x: e.x, y: e.y }
        if (this.drag) {
          if (Math.abs(e.y - this.drag.y) > 3) this.drag.moved = true
          if (this.drag.moved) {
            this.setView(this.drag.t0 - (e.y - this.drag.y) * this.upp)
            this.emit('userscroll', {})
            this.surface.setCursor('grabbing')
          }
          return true
        }
        const box = this.boxes.find((b) => rectContains(b, e.x, e.y)) ?? null
        let span: typeof this.hoverSpan = null
        if (!box && this.src?.spanInfo) {
          const li = this.cols.findIndex((col) => e.x >= col.x - 1 && e.x <= col.x + col.w + 1)
          if (li >= 0 && inside) {
            const rows = this.src.spanInfo(li, this.tOf(e.y))
            if (rows) span = { lane: li, t: this.tOf(e.y), rows }
          }
        }
        if (box !== this.hover) { this.hover = box; this.dirty = true }
        this.hoverSpan = span
        this.surface.setCursor(box || span ? 'pointer' : inside ? 'grab' : 'default')
        this.requestRender()
        return false
      }
      case 'up': {
        const d = this.drag
        this.drag = null
        this.surface.setCursor('default')
        return !!d
      }
      case 'click': {
        if (!inside) return false
        const box = this.boxes.find((b) => rectContains(b, e.x, e.y))
        if (box) { this.setSelected(box.item.id); this.emit('select', { item: box.item }); return true }
        if (this.hoverSpan) { this.emit('spanclick', { lane: this.hoverSpan.lane, t: this.hoverSpan.t }); return true }
        return false
      }
      case 'dblclick':
        if (!inside) return false
        this.zoom(0.5, e.y)
        return true
      case 'leave':
        this.mouse = null
        if (this.hover) { this.hover = null; this.dirty = true }
        this.hoverSpan = null
        this.requestRender()
        return false
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) {
    for (const b of [this.bg, this.spanB, this.boxB, this.hiB]) b.dispose(r)
    for (const b of [this.gridB, this.lifeB, this.linkB, this.leadB, this.hiLinkB]) b.dispose(r)
  }
}

// ---------------------------------------------------------------- time text (target ms since boot)

/** "31.468 200": seconds within the minute, ms, then us when the step is finer than 1 ms. */
export function fmtRuler(tMs: number, stepMs: number) {
  const totalUs = Math.round(tMs * 1000)
  const s = Math.floor(totalUs / 1e6) % 60
  const ms = Math.floor(totalUs / 1000) % 1000
  const u = totalUs % 1000
  const base = `${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  return stepMs >= 1 ? base : `${base} ${String(u).padStart(3, '0')}`
}
export function fmtHM(tMs: number) {
  const m = Math.floor(tMs / 60000)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:`
}
export function fmtFull(tMs: number) { return `${fmtHM(tMs)}${fmtRuler(tMs, 0.001)}` }
export function fmtScale(ms: number) { return ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(ms < 0.01 ? 1 : 0)} us` }
