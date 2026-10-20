import { Panel, type Color } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { RectBatch, SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'

/**
 * RAM floor plan: one bar per memory region in true address order. Sections
 * keep their address order and relative size, but long free runs are folded
 * to a fixed width with a break mark, so a 168 B control block stays visible
 * next to 1.8 MiB of free space. Each section shows live use as a fill, the
 * high-water mark as a tick, and MPU attribute windows as brackets above.
 * Disabled regions are drawn hatched with the reason.
 */
export interface MapBlock { name: string; start: number; size: number; color: Color; used?: number; peak?: number; note?: string; kind: string }
export interface MapWindow { start: number; size: number; label: string; color: Color }
export interface MapRegion { name: string; dt: string; base: number; size: number; attr: string; enabled: boolean; note: string; blocks: MapBlock[]; windows?: MapWindow[] }
export interface AddressMapOptions extends PanelOptions { surface?: Surface; [k: string]: unknown }

interface Seg { x: number; w: number; block: MapBlock | null; gap: number; gapStart: number }
interface Row { r: Rect; region: MapRegion; segs: Seg[] }

const LABEL_W = 210
const FOLD_W = 64
const MIN_W = 5

const fmtB = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(b % 1048576 ? 2 : 0)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(b % 1024 ? 1 : 0)} KiB` : `${b} B`)
const hex = (a: number) => `0x${a.toString(16).padStart(8, '0')}`

export class AddressMap extends Panel {
  private regions: MapRegion[] = []
  private rows: Row[] = []
  private fills = new RectBatch()
  private lines = new SegmentBatch()
  private hover: { x: number; y: number; seg: Seg; row: Row } | null = null

  constructor(o: AddressMapOptions) {
    super(o)
    this.padding = { left: 10, right: 12, top: 8, bottom: 6 }
  }
  setRegions(r: MapRegion[]) { this.regions = r; this.requestRender(); return this }

  override layout(_ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    const enabled = this.regions.filter((r) => r.enabled)
    const disabled = this.regions.filter((r) => !r.enabled)
    const rowH = Math.min(58, (c.h - (disabled.length ? 34 : 0)) / Math.max(1, enabled.length))
    const barX = c.x + LABEL_W, barW = Math.max(40, c.w - LABEL_W)
    // One bytes-to-px scale for every row, set by the row that needs the most room, so a
    // 1 KiB record in an 8 KiB region is drawn as small as 1 KiB anywhere else.
    const scale = Math.min(...enabled.map((g) => this.rowScale(g, barW)))
    this.rows = enabled.map((region, i) => {
      const segs = this.segments(region, barX, scale)
      const end = segs.length ? segs[segs.length - 1].x + segs[segs.length - 1].w : barX
      const r = { x: barX, y: c.y + i * rowH + 18, w: Math.min(barW, end - barX), h: Math.max(12, rowH - 30) }
      return { r, region, segs }
    })
    // Disabled regions share one strip at the bottom.
    if (disabled.length) {
      const y = c.y + c.h - 26, w = barW / disabled.length
      disabled.forEach((region, i) => this.rows.push({ r: { x: barX + i * w + 2, y, w: w - 4, h: 20 }, region, segs: [] }))
    }
    this.build()
  }

  private parts(region: MapRegion) {
    const blocks = [...region.blocks].sort((a, b) => a.start - b.start)
    const parts: { block: MapBlock | null; size: number; start: number }[] = []
    let a = region.base
    for (const b of blocks) {
      if (b.start > a) parts.push({ block: null, size: b.start - a, start: a })
      parts.push({ block: b, size: b.size, start: b.start })
      a = b.start + b.size
    }
    if (a < region.base + region.size) parts.push({ block: null, size: region.base + region.size - a, start: a })
    return parts
  }
  /** px per byte that fits this region's unfolded parts into W. */
  private rowScale(region: MapRegion, W: number) {
    const parts = this.parts(region)
    const folds = parts.filter((p) => !p.block && p.size > 4096).length
    const linear = parts.filter((p) => p.block || p.size <= 4096).reduce((s, p) => s + p.size, 0)
    const mins = parts.filter((p) => p.block || p.size <= 4096).length * MIN_W
    return Math.max(1e-9, (W - folds * FOLD_W - mins) / Math.max(1, linear))
  }

  /** Address-ordered segments at a common scale, long free runs folded. */
  private segments(region: MapRegion, x0: number, scale: number): Seg[] {
    const parts = this.parts(region)
    let x = x0
    return parts.map((p) => {
      const folded = !p.block && p.size > 4096
      const w = folded ? FOLD_W : MIN_W + p.size * scale
      const seg = { x, w, block: p.block, gap: p.block ? 0 : p.size, gapStart: p.start }
      x += w
      return seg
    })
  }

  private build() {
    const t = this.theme
    const f = this.fills, l = this.lines
    f.clear(); l.clear()
    const brk = t.tickLabelColor.toUint32()
    for (const row of this.rows) {
      const r = row.r
      if (!row.region.enabled) {
        f.push(r.x, r.y, r.x + r.w, r.y + r.h, t.gridMinorColor.toUint32())
        for (let hx = r.x + 4; hx < r.x + r.w; hx += 7) l.push(hx, r.y + r.h, Math.min(r.x + r.w, hx + r.h * 0.7), r.y, t.gridMajorColor.toUint32())
        continue
      }
      f.push(r.x, r.y, r.x + r.w, r.y + r.h, t.gridMinorColor.toUint32())
      for (const s of row.segs) {
        if (!s.block) {
          if (s.gap > 4096) {
            // Fold mark: two slanted strokes.
            const cx = s.x + s.w / 2
            l.push(cx - 6, r.y + r.h, cx - 1, r.y, brk)
            l.push(cx + 1, r.y + r.h, cx + 6, r.y, brk)
          }
          continue
        }
        const b = s.block
        f.push(s.x + 0.5, r.y, s.x + s.w - 0.5, r.y + r.h, b.color.setA(t.isDark ? 70 : 80).toUint32())
        if (b.used !== undefined && b.size > 0) {
          const u = Math.max(0, Math.min(1, b.used / b.size))
          f.push(s.x + 0.5, r.y + r.h * 0.3, s.x + 0.5 + (s.w - 1) * u, r.y + r.h, b.color.setA(230).toUint32())
        }
        if (b.peak !== undefined && b.size > 0) {
          const px = s.x + 0.5 + (s.w - 1) * Math.min(1, b.peak / b.size)
          l.push(px, r.y - 2, px, r.y + r.h + 2, t.titleColor.toUint32())
        }
      }
      for (const w of row.region.windows ?? []) {
        const xs = this.addrX(row, w.start), xe = this.addrX(row, w.start + w.size)
        const y = r.y - 6
        const c = w.color.toUint32()
        l.push(xs, y, xe, y, c)
        l.push(xs, y, xs, y + 4, c)
        l.push(xe, y, xe, y + 4, c)
      }
    }
  }

  /** Screen x of an address inside a row (interpolated within its segment). */
  private addrX(row: Row, a: number) {
    for (const s of row.segs) {
      const start = s.block ? s.block.start : s.gapStart
      const size = s.block ? s.block.size : s.gap
      if (a >= start && a <= start + size) return s.x + ((a - start) / Math.max(1, size)) * s.w
    }
    return row.r.x + row.r.w
  }

  override hasGL() { return this.rows.length > 0 }
  override drawGL(r: GLRenderer) {
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    r.scissor(this.rect)
    this.fills.draw(r, maps, { radius: 1.5 })
    this.lines.draw(r, maps, 1.3)
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily, c = this.content
    ctx.save()
    for (const row of this.rows) {
      const r = row.r, g = row.region
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      if (!g.enabled) {
        ctx.font = `10.5px ${ff}`
        ctx.fillStyle = t.minorTickLabelColor.toCSS()
        ctx.fillText(`${g.name} ${fmtB(g.size)}: disabled`, r.x + 6, r.y + r.h / 2, r.w - 10)
        continue
      }
      ctx.font = `600 12px ${ff}`
      ctx.fillStyle = t.titleColor.toCSS()
      ctx.fillText(g.name, c.x, r.y + 4, LABEL_W - 12)
      ctx.font = `10.5px ${ff}`
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.fillText(`${hex(g.base)} + ${fmtB(g.size)}`, c.x, r.y + 18, LABEL_W - 12)
      ctx.fillStyle = t.minorTickLabelColor.toCSS()
      ctx.fillText(g.attr, c.x, r.y + 31, LABEL_W - 12)
      // Section labels where they fit, folded gap sizes always.
      for (const s of row.segs) {
        if (!s.block) {
          if (s.gap > 4096) {
            ctx.font = `10px ${ff}`
            ctx.textAlign = 'center'
            ctx.fillStyle = t.tickLabelColor.toCSS()
            ctx.fillText(`${fmtB(s.gap)} free`, s.x + s.w / 2, r.y + r.h + 9, s.w + 30)
            ctx.textAlign = 'left'
          }
          continue
        }
        const b = s.block
        ctx.font = `10.5px ${ff}`
        const label = b.name
        if (ctx.measureText(label).width + 8 < s.w) {
          ctx.fillStyle = t.titleColor.toCSS()
          ctx.fillText(label, s.x + 4, r.y + r.h * 0.3, s.w - 6)
          if (r.h > 24 && ctx.measureText(fmtB(b.size)).width + 8 < s.w) {
            ctx.fillStyle = t.tickLabelColor.toCSS()
            ctx.fillText(b.used !== undefined ? `${fmtB(Math.round(b.used))} / ${fmtB(b.size)}` : fmtB(b.size), s.x + 4, r.y + r.h * 0.72, s.w - 6)
          }
        }
      }
      for (const w of g.windows ?? []) {
        const xs = this.addrX(row, w.start)
        ctx.font = `600 9.5px ${ff}`
        ctx.fillStyle = w.color.setA(255).toCSS()
        ctx.fillText(w.label, xs + 2, r.y - 12)
      }
    }
    if (this.hover) {
      const s = this.hover.seg, b = s.block
      const rows = b
        ? [b.name, `${hex(b.start)} .. ${hex(b.start + b.size - 1)}`, `${fmtB(b.size)}${b.used !== undefined ? `, used ${fmtB(Math.round(b.used))} (${((b.used / b.size) * 100).toFixed(0)}%)` : ''}${b.peak !== undefined ? `, peak ${fmtB(Math.round(b.peak))}` : ''}`, b.note ?? '']
        : [`free ${fmtB(s.gap)}`, `${hex(s.gapStart)} .. ${hex(s.gapStart + s.gap - 1)}`, s.gap > 4096 ? 'folded: not drawn to scale' : '']
      const lines = rows.filter(Boolean)
      ctx.font = `11px ${ff}`
      const w = Math.max(...lines.map((x) => ctx.measureText(x).width)) + 16
      const h = lines.length * 15 + 10
      let bx = this.hover.x + 12, by = this.hover.y + 14
      if (bx + w > this.rect.x + this.rect.w) bx = this.hover.x - w - 12
      if (by + h > this.rect.y + this.rect.h) by = this.hover.y - h - 8
      roundRect(ctx, bx, by, w, h, 5)
      ctx.fillStyle = t.cursor.tableFill.toCSS()
      ctx.fill()
      ctx.strokeStyle = t.cursor.tableStroke.toCSS()
      ctx.stroke()
      ctx.fillStyle = t.cursor.textColor.toCSS()
      ctx.textBaseline = 'top'
      lines.forEach((x, i) => ctx.fillText(x, bx + 8, by + 6 + i * 15))
    }
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    if (e.type === 'leave') { this.hover = null; this.requestRender(); return false }
    let hit: typeof this.hover = null
    for (const row of this.rows) {
      if (!rectContains({ x: row.r.x, y: row.r.y - 4, w: row.r.w, h: row.r.h + 8 }, e.x, e.y)) continue
      const s = row.segs.find((x) => e.x >= x.x && e.x < x.x + x.w)
      if (s) hit = { x: e.x, y: e.y, seg: s, row }
    }
    this.hover = hit
    this.requestRender()
    return false
  }

  override disposeGL(r: GLRenderer | null) { this.fills.dispose(r); this.lines.dispose(r) }
}
