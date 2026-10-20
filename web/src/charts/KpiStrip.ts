import { Panel } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'
import { drawStatusGlyph, statusColor, type Status } from './status'

export interface KpiTile {
  id: string
  label: string
  value: string
  unit?: string
  /** Second line: context such as the worst thread or a delta. */
  sub?: string
  status?: Status
  /** Recent values, drawn as a GPU sparkline with glow. */
  spark?: number[]
  /** 0..1 progress bar (run elapsed, budget used). */
  progress?: number
  /** Provenance tag shown on hover: stats, trace, derived, build, external. */
  source?: string
}

export interface KpiStripOptions extends PanelOptions {
  surface?: Surface
  /** Narrowest tile before the strip wraps to another row (CSS px). */
  tileMinWidth?: number
  [k: string]: unknown
}

/**
 * Row of KPI tiles: label, value with unit, context line, status (color plus
 * shape glyph), optional sparkline and progress bar. Sparklines go through the
 * shared GL pass (SegmentBatch in CSS px, like DataGrid sparklines); text and
 * tile chrome are 2D overlay.
 */
export class KpiStrip extends Panel {
  private tiles: KpiTile[] = []
  private boxes: Rect[] = []
  private sparks = new SegmentBatch()
  private sparksDirty = true
  private lastRect = ''
  private hover = -1
  private minW: number

  constructor(o: KpiStripOptions) {
    super(o)
    this.minW = o.tileMinWidth ?? 128
    this.padding = { left: 6, right: 6, top: 6, bottom: 6 }
  }

  setTiles(tiles: KpiTile[]) {
    this.tiles = tiles.map((t) => ({ ...t }))
    this.sparksDirty = true
    this.requestRender()
    return this
  }
  updateTile(id: string, patch: Partial<KpiTile>) {
    const t = this.tiles.find((x) => x.id === id)
    if (!t) return this
    Object.assign(t, patch)
    if (patch.spark || patch.status) this.sparksDirty = true
    this.requestRender()
    return this
  }
  getTile(id: string) { return this.tiles.find((x) => x.id === id) }

  override layout(_ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    const n = this.tiles.length
    if (!n) return
    const gap = 6
    const rows = Math.max(1, Math.min(n, Math.ceil((n * this.minW) / Math.max(1, c.w))))
    const cols = Math.ceil(n / rows)
    const w = (c.w - gap * (cols - 1)) / cols
    const h = (c.h - gap * (rows - 1)) / rows
    this.boxes = this.tiles.map((_, i) => ({ x: c.x + (i % cols) * (w + gap), y: c.y + Math.floor(i / cols) * (h + gap), w, h }))
    const key = `${c.x},${c.y},${c.w},${c.h}`
    if (key !== this.lastRect) {
      this.lastRect = key
      this.sparksDirty = true
    }
    if (this.sparksDirty) this.buildSparks()
  }

  private sparkArea(b: Rect): Rect {
    const w = Math.min(b.w * 0.42, 96)
    return { x: b.x + b.w - w - 8, y: b.y + b.h * 0.42, w, h: b.h * 0.42 }
  }

  private buildSparks() {
    this.sparksDirty = false
    const sb = this.sparks
    sb.clear()
    this.tiles.forEach((t, i) => {
      const s = t.spark
      const b = this.boxes[i]
      if (!s || s.length < 2 || !b || b.h < 40) return
      const a = this.sparkArea(b)
      let lo = Infinity, hi = -Infinity
      for (const v of s) { if (v < lo) lo = v; if (v > hi) hi = v }
      if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
      const col = (t.status && t.status !== 'ok' ? statusColor(this.theme, t.status) : this.theme.seriesColors[0]).toUint32()
      const px = (k: number) => a.x + (k / (s.length - 1)) * a.w
      const py = (v: number) => a.y + a.h - ((v - lo) / (hi - lo)) * a.h
      for (let k = 1; k < s.length; k++) sb.push(px(k - 1), py(s[k - 1]), px(k), py(s[k]), col)
    })
  }

  override hasGL() { return this.sparks.n > 0 || this.sparksDirty }

  override drawGL(r: GLRenderer) {
    if (!this.sparks.n) return
    const id = { a0: 0, start: 0, k: 1, log: 0 }
    r.scissor(this.rect)
    r.glow = 1
    this.sparks.draw(r, { mx: id, my: id }, 1.5)
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const ff = t.fontFamily
    this.tiles.forEach((tile, i) => {
      const b = this.boxes[i]
      if (!b || b.w < 20 || b.h < 20) return
      const st = tile.status ?? 'idle'
      const sc = statusColor(t, st).toCSS()
      ctx.save()
      roundRect(ctx, b.x, b.y, b.w, b.h, 6)
      ctx.fillStyle = t.uiFill.toCSS()
      ctx.fill()
      ctx.strokeStyle = i === this.hover ? t.examples.highlightColor.toCSS() : t.uiStroke.toCSS()
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.beginPath()
      ctx.rect(b.x, b.y, b.w, b.h)
      ctx.clip()
      // Status accent along the left edge.
      ctx.fillStyle = sc
      ctx.fillRect(b.x, b.y + 4, 3, b.h - 8)
      const compact = b.h < 58
      const lx = b.x + 12
      // Label row with status glyph.
      ctx.font = `600 10.5px ${ff}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillStyle = t.minorTickLabelColor.toCSS()
      const ly = b.y + (compact ? 11 : 13)
      drawStatusGlyph(ctx, st, lx + 4, ly, 4, sc)
      ctx.fillText(tile.label.toUpperCase(), lx + 13, ly, b.w - 30)
      // Value + unit.
      const vSize = compact ? 17 : Math.min(26, Math.max(17, b.h * 0.3))
      const vy = compact ? b.y + b.h * 0.62 : b.y + b.h * 0.52
      ctx.font = `600 ${vSize}px ${ff}`
      ctx.fillStyle = t.titleColor.toCSS()
      ctx.fillText(tile.value, lx, vy)
      if (tile.unit) {
        const vw = ctx.measureText(tile.value).width
        ctx.font = `${Math.round(vSize * 0.55)}px ${ff}`
        ctx.fillStyle = t.tickLabelColor.toCSS()
        ctx.fillText(tile.unit, lx + vw + 4, vy + vSize * 0.12)
      }
      // Context line.
      if (tile.sub && !compact) {
        ctx.font = `11px ${ff}`
        ctx.fillStyle = t.tickLabelColor.toCSS()
        ctx.fillText(tile.sub, lx, b.y + b.h - 13, b.w - 20)
      }
      // Progress bar along the bottom.
      if (tile.progress !== undefined) {
        const p = Math.max(0, Math.min(1, tile.progress))
        ctx.fillStyle = t.gridMajorColor.toCSS()
        ctx.fillRect(b.x + 12, b.y + b.h - 4, b.w - 24, 2)
        ctx.fillStyle = sc
        ctx.fillRect(b.x + 12, b.y + b.h - 4, (b.w - 24) * p, 2)
      }
      if (i === this.hover && tile.source) {
        ctx.font = `10px ${ff}`
        ctx.textAlign = 'right'
        ctx.fillStyle = t.examples.highlightColor.toCSS()
        ctx.fillText(tile.source, b.x + b.w - 8, ly)
      }
      ctx.restore()
    })
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const i = e.type === 'leave' ? -1 : this.boxes.findIndex((b) => rectContains(b, e.x, e.y))
    if (i !== this.hover) {
      this.hover = i
      this.requestRender()
    }
    if (e.type === 'click' && i >= 0) {
      this.emit('tileclick', { id: this.tiles[i].id })
      return true
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) { this.sparks.dispose(r) }
}
