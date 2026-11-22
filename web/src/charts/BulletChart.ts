// SPDX-License-Identifier: Apache-2.0
import { Panel } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { RectBatch } from 'sferic/render/draw'
import { rectContains, type Rect } from 'sferic/core/util'
import { classify, drawStatusGlyph, statusColor } from './status'

/**
 * One resource row: current use, high-water mark and capacity, with warn and
 * crit thresholds in the same units (higher is worse).
 */
export interface BulletRow {
  name: string
  value: number
  /** High-water mark (stack watermark, heap max allocated, queue peak). */
  peak?: number
  max: number
  warn?: number
  crit?: number
  /** Right-hand text; default "peak / max (pct %)". */
  text?: string
  /** Group heading drawn above this row. */
  group?: string
}

export interface BulletChartOptions extends PanelOptions {
  surface?: Surface
  /** Formats values for the default right-hand text. */
  format?: (v: number) => string
  [k: string]: unknown
}

/**
 * Bullet chart for headroom: one bar per resource with shaded warn/crit
 * zones, the current value, and a tick at the high-water mark. Status (color
 * plus glyph) follows the high-water mark, since that is what overflows.
 * Bars go through the shared GL pass as a RectBatch in CSS px; text is overlay.
 */
export class BulletChart extends Panel {
  private rows: BulletRow[] = []
  private rowRects: Rect[] = []
  private track: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private nameW = 0
  private textW = 0
  private batch = new RectBatch()
  private hover = -1
  private fmt: (v: number) => string

  constructor(o: BulletChartOptions) {
    super(o)
    this.fmt = o.format ?? ((v) => (Math.abs(v) >= 1024 ? `${(v / 1024).toFixed(1)} Ki` : `${Math.round(v)}`))
    this.padding = { left: 10, right: 10, top: 8, bottom: 8 }
  }

  setRows(rows: BulletRow[]) { this.rows = rows.map((r) => ({ ...r })); this.requestRender(); return this }
  updateRow(name: string, patch: Partial<BulletRow>) {
    const r = this.rows.find((x) => x.name === name)
    if (r) { Object.assign(r, patch); this.requestRender() }
    return this
  }

  private rowText(r: BulletRow) {
    if (r.text) return r.text
    const hw = r.peak ?? r.value
    return `${this.fmt(hw)} / ${this.fmt(r.max)} (${Math.round((hw / r.max) * 100)}%)`
  }

  override layout(ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    const n = this.rows.length
    if (!n) return
    const groups = this.rows.filter((r) => r.group).length
    ctx.font = `12px ${this.theme.fontFamily}`
    this.nameW = Math.min(c.w * 0.32, Math.max(...this.rows.map((r) => ctx.measureText(r.name).width)) + 22)
    ctx.font = `11px ${this.theme.fontFamily}`
    this.textW = Math.min(c.w * 0.34, Math.max(...this.rows.map((r) => ctx.measureText(this.rowText(r)).width)) + 10)
    const units = n + groups * 0.8
    const rh = Math.min(30, c.h / units)
    let y = c.y + Math.max(0, (c.h - rh * units) / 2)
    this.rowRects = this.rows.map((r) => {
      if (r.group) y += rh * 0.8
      const rr = { x: c.x, y, w: c.w, h: rh }
      y += rh
      return rr
    })
    this.track = { x: c.x + this.nameW, y: c.y, w: Math.max(10, c.w - this.nameW - this.textW), h: c.h }
  }

  override hasGL() { return this.rows.length > 0 }

  override drawGL(r: GLRenderer) {
    const t = this.theme
    const b = this.batch
    b.clear()
    b.setOrigin(0, 0)
    const [bad, mid] = t.examples.badGoodColorPalette
    const trackCol = t.gridMajorColor.toUint32()
    const warnZone = mid.setA(46).toUint32()
    const critZone = bad.setA(64).toUint32()
    const peakCol = t.titleColor.toUint32()
    this.rows.forEach((row, i) => {
      const rr = this.rowRects[i]
      if (!rr) return
      const x0 = this.track.x, w = this.track.w
      const h = Math.max(4, rr.h * 0.5)
      const y0 = rr.y + (rr.h - h) / 2
      const X = (v: number) => x0 + Math.max(0, Math.min(1, v / row.max)) * w
      b.push(x0, y0, x0 + w, y0 + h, trackCol)
      if (row.warn !== undefined) b.push(X(row.warn), y0, X(row.crit ?? row.max), y0 + h, warnZone)
      if (row.crit !== undefined) b.push(X(row.crit), y0, x0 + w, y0 + h, critZone)
      const st = classify(row.peak ?? row.value, row.warn, row.crit)
      const vh = h * 0.56
      b.push(x0, y0 + (h - vh) / 2, X(row.value), y0 + (h + vh) / 2, statusColor(t, st).setA(235).toUint32())
      if (row.peak !== undefined) b.push(X(row.peak) - 1, y0 - 2, X(row.peak) + 1, y0 + h + 2, peakCol)
    })
    const id = { a0: 0, start: 0, k: 1, log: 0 }
    r.scissor(this.rect)
    r.glow = 0
    b.draw(r, { mx: id, my: id }, { radius: 2 })
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    ctx.save()
    ctx.textBaseline = 'middle'
    this.rows.forEach((row, i) => {
      const rr = this.rowRects[i]
      if (!rr) return
      const yc = rr.y + rr.h / 2
      if (row.group) {
        ctx.font = `600 10.5px ${t.fontFamily}`
        ctx.textAlign = 'left'
        ctx.fillStyle = t.axisTitleColor.toCSS()
        ctx.fillText(row.group.toUpperCase(), rr.x, rr.y - rr.h * 0.35)
      }
      const st = classify(row.peak ?? row.value, row.warn, row.crit)
      const sc = statusColor(t, st).toCSS()
      drawStatusGlyph(ctx, st, rr.x + 5, yc, 3.5, sc)
      ctx.font = `12px ${t.fontFamily}`
      ctx.textAlign = 'left'
      ctx.fillStyle = i === this.hover ? t.examples.highlightColor.toCSS() : t.tickLabelColor.toCSS()
      ctx.fillText(row.name, rr.x + 14, yc, this.nameW - 18)
      ctx.font = `11px ${t.fontFamily}`
      ctx.textAlign = 'right'
      ctx.fillStyle = st === 'ok' ? t.minorTickLabelColor.toCSS() : sc
      ctx.fillText(this.rowText(row), rr.x + rr.w, yc)
    })
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const i = e.type === 'leave' ? -1 : this.rowRects.findIndex((r) => rectContains(r, e.x, e.y))
    if (i !== this.hover) {
      this.hover = i
      this.requestRender()
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) { this.batch.dispose(r) }
}
