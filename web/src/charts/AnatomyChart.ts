import { Panel, type Color } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { RectBatch, SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'
import { drawStatusGlyph, statusColor, type Status } from './status'

/**
 * Response-time anatomy: one horizontal bar per job, split into what the time
 * was spent on (own execution, each preempting thread, each ISR, the lock
 * holder, inversion by medium-priority threads). A budget line marks the
 * deadline, so the segment that pushed a job over it is the one crossing it.
 * Segments are GPU rects; labels, legend and tooltips are overlay.
 */
export interface AnatomySeg { name: string; us: number; color: Color; hatch?: boolean }
export interface AnatomyRow { id: number; label: string; sub?: string; segs: AnatomySeg[]; status?: Status }

export interface AnatomyChartOptions extends PanelOptions {
  surface?: Surface
  [k: string]: unknown
}

export class AnatomyChart extends Panel {
  private rows: AnatomyRow[] = []
  private budget = NaN
  private scaleUs = NaN
  private bars = new RectBatch()
  private ticks = new SegmentBatch()
  private hitBoxes: { r: Rect; row: AnatomyRow; seg: AnatomySeg | null }[] = []
  private legendItems: { name: string; color: Color }[] = []
  private hover: { x: number; y: number; row: AnatomyRow; seg: AnatomySeg | null } | null = null
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private labelW = 128
  private empty = 'No job selected'

  constructor(o: AnatomyChartOptions) {
    super(o)
    this.padding = { left: 10, right: 12, top: 8, bottom: 8 }
  }

  setRows(rows: AnatomyRow[]) { this.rows = rows; this.requestRender(); return this }
  setBudget(us: number) { this.budget = us; this.requestRender(); return this }
  /** Fixed X scale in us (NaN: fit the longest row and the budget). */
  setScale(us: number) { this.scaleUs = us; this.requestRender(); return this }
  setEmptyText(s: string) { this.empty = s; this.requestRender(); return this }

  override layout(ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    // Legend: unique segment names in first-seen order.
    const seen = new Map<string, Color>()
    for (const r of this.rows) for (const s of r.segs) if (s.us > 0 && !seen.has(s.name)) seen.set(s.name, s.color)
    this.legendItems = [...seen].map(([name, color]) => ({ name, color }))
    ctx.font = `11px ${this.theme.fontFamily}`
    let lx = c.x, lines = 1
    for (const it of this.legendItems) {
      const w = ctx.measureText(it.name).width + 26
      if (lx + w > c.x + c.w) { lines++; lx = c.x }
      lx += w
    }
    const legendH = this.legendItems.length ? lines * 16 + 6 : 0
    this.labelW = Math.min(150, Math.max(96, c.w * 0.24))
    this.area = { x: c.x + this.labelW, y: c.y + legendH, w: Math.max(10, c.w - this.labelW - 64), h: Math.max(10, c.h - legendH - 18) }
    this.build()
  }

  private build() {
    const t = this.theme, a = this.area
    this.bars.clear()
    this.ticks.clear()
    this.hitBoxes = []
    if (!this.rows.length) return
    const totals = this.rows.map((r) => r.segs.reduce((s, x) => s + x.us, 0))
    const max = this.scaleUs === this.scaleUs ? this.scaleUs : Math.max(...totals, this.budget === this.budget ? this.budget * 1.08 : 0) * 1.04
    const k = a.w / (max || 1)
    const rowH = Math.min(30, a.h / this.rows.length)
    const barH = Math.max(6, rowH * 0.62)
    this.rows.forEach((row, i) => {
      const y = a.y + i * rowH + (rowH - barH) / 2
      let x = a.x
      this.hitBoxes.push({ r: { x: this.content.x, y: a.y + i * rowH, w: this.content.w, h: rowH }, row, seg: null })
      for (const s of row.segs) {
        if (s.us <= 0) continue
        const w = s.us * k
        this.bars.push(x, y, x + Math.max(1, w), y + barH, s.color.toUint32())
        if (s.hatch) for (let hx = x + 3; hx < x + w; hx += 5) this.ticks.push(hx, y + barH, Math.min(x + w, hx + barH * 0.6), y, t.isDark ? 0x66000000 : 0x55ffffff)
        this.hitBoxes.push({ r: { x, y, w: Math.max(2, w), h: barH }, row, seg: s })
        x += w
      }
    })
    if (this.budget === this.budget) {
      const bx = a.x + this.budget * k
      this.ticks.push(bx, a.y - 2, bx, a.y + this.rows.length * rowH + 2, statusColor(t, 'crit').toUint32())
    }
  }

  override hasGL() { return this.rows.length > 0 }
  override drawGL(r: GLRenderer) {
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    r.scissor(this.rect)
    this.bars.draw(r, maps, { radius: 2 })
    this.ticks.draw(r, maps, 1.4)
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily, a = this.area, c = this.content
    ctx.save()
    // Legend.
    ctx.font = `11px ${ff}`
    ctx.textBaseline = 'middle'
    let lx = c.x, ly = c.y + 7
    for (const it of this.legendItems) {
      const w = ctx.measureText(it.name).width + 26
      if (lx + w > c.x + c.w) { lx = c.x; ly += 16 }
      ctx.fillStyle = it.color.setA(255).toCSS()
      roundRect(ctx, lx, ly - 5, 10, 10, 2)
      ctx.fill()
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.fillText(it.name, lx + 14, ly)
      lx += w
    }
    if (!this.rows.length) {
      ctx.fillStyle = t.minorTickLabelColor.toCSS()
      ctx.textAlign = 'center'
      ctx.fillText(this.empty, c.x + c.w / 2, c.y + c.h / 2)
    }
    const rowH = Math.min(30, a.h / Math.max(1, this.rows.length))
    this.rows.forEach((row, i) => {
      const yc = a.y + i * rowH + rowH / 2
      const total = row.segs.reduce((s, x) => s + x.us, 0)
      ctx.textAlign = 'left'
      if (row.status) drawStatusGlyph(ctx, row.status, c.x + 5, yc, 4, statusColor(t, row.status).toCSS())
      ctx.font = `11px ${ff}`
      ctx.fillStyle = t.titleColor.toCSS()
      ctx.fillText(row.label, c.x + 14, row.sub && rowH > 24 ? yc - 6 : yc, this.labelW - 18)
      if (row.sub && rowH > 24) {
        ctx.font = `10px ${ff}`
        ctx.fillStyle = t.minorTickLabelColor.toCSS()
        ctx.fillText(row.sub, c.x + 14, yc + 7, this.labelW - 18)
      }
      const hb = this.hitBoxes.filter((h) => h.row === row && h.seg)
      const end = hb.length ? hb[hb.length - 1].r.x + hb[hb.length - 1].r.w : a.x
      ctx.font = `600 11px ${ff}`
      ctx.fillStyle = (row.status === 'crit' ? statusColor(t, 'crit') : t.tickLabelColor).toCSS()
      ctx.fillText(`${total.toFixed(0)} us`, end + 6, yc)
    })
    if (this.budget === this.budget && this.rows.length) {
      const max = this.scaleUs === this.scaleUs ? this.scaleUs : Math.max(...this.rows.map((r) => r.segs.reduce((s, x) => s + x.us, 0)), this.budget * 1.08) * 1.04
      const bx = a.x + (this.budget / max) * a.w
      ctx.font = `10px ${ff}`
      ctx.textAlign = 'center'
      ctx.fillStyle = statusColor(t, 'crit').toCSS()
      ctx.fillText(`deadline ${this.budget} us`, bx, a.y + this.rows.length * rowH + 10)
    }
    if (this.hover) {
      const h = this.hover
      const rows = h.seg ? [h.seg.name, `${h.seg.us.toFixed(1)} us`, h.row.label] : [h.row.label, h.row.sub ?? '', 'click: open in Trace'].filter(Boolean)
      ctx.font = `11px ${ff}`
      const w = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 16
      const hh = rows.length * 15 + 10
      let bx = h.x + 12, by = h.y + 12
      if (bx + w > this.rect.x + this.rect.w) bx = h.x - w - 12
      if (by + hh > this.rect.y + this.rect.h) by = h.y - hh - 8
      roundRect(ctx, bx, by, w, hh, 5)
      ctx.fillStyle = t.cursor.tableFill.toCSS()
      ctx.fill()
      ctx.strokeStyle = t.cursor.tableStroke.toCSS()
      ctx.stroke()
      ctx.fillStyle = t.cursor.textColor.toCSS()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      rows.forEach((r, i) => ctx.fillText(r, bx + 8, by + 6 + i * 15))
    }
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    if (e.type === 'leave') { this.hover = null; this.requestRender(); return false }
    const segHit = this.hitBoxes.find((h) => h.seg && rectContains(h.r, e.x, e.y))
    const rowHit = segHit ?? this.hitBoxes.find((h) => !h.seg && rectContains(h.r, e.x, e.y))
    if (e.type === 'move') {
      this.hover = rowHit ? { x: e.x, y: e.y, row: rowHit.row, seg: rowHit.seg } : null
      this.surface.setCursor(rowHit ? 'pointer' : 'default')
      this.requestRender()
      return false
    }
    if (e.type === 'click' && rowHit) { this.emit('rowclick', { id: rowHit.row.id }); return true }
    return false
  }

  override disposeGL(r: GLRenderer | null) { this.bars.dispose(r); this.ticks.dispose(r) }
}
