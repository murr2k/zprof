import { Panel, LUT, type Color } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { HeatmapTexture, RectBatch, SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'
import { CHUNK, type HeapSim } from '../sim/heap'

/**
 * Heap X-ray: every 8-byte chunk of the heap laid out along a Hilbert curve,
 * so neighbouring addresses stay neighbours on screen and a contiguous run is
 * a compact blob, not a line wrapped across rows. Colored by owner thread or by
 * allocation age; fragmentation reads as texture, a leak as old blocks that
 * never go away. The largest free run is traced along the curve.
 */
export interface XRayOwner { name: string; color: Color }
export interface HeapXRayOptions extends PanelOptions { surface?: Surface; [k: string]: unknown }

const N = 64

function d2xy(d: number): [number, number] {
  let x = 0, y = 0, t = d
  for (let s = 1; s < N; s *= 2) {
    const rx = 1 & (t >> 1)
    const ry = 1 & (t ^ rx)
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y }
      const tmp = x; x = y; y = tmp
    }
    x += s * rx
    y += s * ry
    t >>= 2
  }
  return [x, y]
}
const XY: Int16Array = new Int16Array(N * N * 2)
const D_OF: Int32Array = new Int32Array(N * N)
for (let d = 0; d < N * N; d++) {
  const [x, y] = d2xy(d)
  XY[d * 2] = x
  XY[d * 2 + 1] = y
  D_OF[y * N + x] = d
}

export class HeapXRay extends Panel {
  private heap: HeapSim | null = null
  private base = 0
  private owners: XRayOwner[] = []
  private mode: 'owner' | 'age' = 'owner'
  private tex = new HeatmapTexture(N, N)
  private lutOwner: LUT | null = null
  private lutAge: LUT | null = null
  private path = new SegmentBatch()
  private frame = new RectBatch()
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private ver = -1
  private builtMode = ''
  private nowMs = 0
  private mouse: { x: number; y: number } | null = null

  constructor(o: HeapXRayOptions) {
    super(o)
    this.padding = { left: 10, right: 10, top: 8, bottom: 8 }
  }

  setHeap(h: HeapSim, baseAddr: number, owners: XRayOwner[]) {
    this.heap = h
    this.base = baseAddr
    this.owners = owners
    const t = this.theme
    // Free and header cells are tints of the panel background, so they read as "empty" in either theme.
    const bgc = t.chartBackgroundFill.getPrimaryColor().setA(255)
    const free = bgc.mix(t.titleColor, 0.14)
    const hdr = bgc.mix(t.titleColor, 0.42)
    this.lutOwner = new LUT({
      interpolate: false,
      steps: [{ value: -1, color: free.setA(0) }, { value: 0, color: free }, { value: 1, color: hdr }, ...owners.map((o, i) => ({ value: 2 + i, color: o.color.setA(255) })), { value: 2 + owners.length, color: hdr }],
    })
    const pal = t.examples.coldHotColorPalette
    const n = pal.length
    this.lutAge = new LUT({
      interpolate: true,
      steps: [
        { value: -1, color: free.setA(0) }, { value: -0.6, color: free.setA(0) }, { value: -0.59, color: free }, { value: -0.01, color: free },
        ...pal.map((c, i) => ({ value: (i / (n - 1)) * 7, color: c })),
      ],
    })
    this.ver = -1
    this.requestRender()
    return this
  }
  setMode(m: 'owner' | 'age') { this.mode = m; this.ver = -1; this.requestRender(); return this }
  /** Current target time, for ages. */
  setNow(ms: number) { this.nowMs = ms; return this }

  override layout(_ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    const side = Math.max(40, Math.min(c.h - 4, c.w - 190))
    this.area = { x: c.x, y: c.y + (c.h - side) / 2, w: side, h: side }
    const h = this.heap
    if (h && (h.version !== this.ver || this.builtMode !== this.mode || this.mode === 'age')) {
      this.ver = h.version
      this.builtMode = this.mode
      this.fill()
    }
    this.buildPath()
  }

  private fill() {
    const h = this.heap!, vals = this.tex.data
    const units = h.units
    for (let d = 0; d < N * N; d++) {
      const x = XY[d * 2], y = XY[d * 2 + 1]
      let v = -0.5
      if (d < units) {
        const c = h.cell[d]
        if (this.mode === 'owner') v = c === 0 ? 0.5 : c === 1 ? 1.5 : c + 0.5
        else v = c === 0 ? -0.3 : 0
      }
      vals[y * N + x] = v
    }
    if (this.mode === 'age') {
      h.forEachBlock((b) => {
        const age = Math.max(1, this.nowMs - b.t)
        const v = Math.min(7, Math.log10(age))
        for (let u = b.start; u < b.start + b.units; u++) vals[XY[u * 2 + 1] * N + XY[u * 2]] = v
      })
    }
    this.tex.setRowMajor(vals)
  }

  /** Outline of the heap and the largest free run traced along the curve. */
  private buildPath() {
    const h = this.heap
    this.path.clear()
    this.frame.clear()
    if (!h) return
    const a = this.area, cell = a.w / N
    const px = (d: number) => a.x + (XY[d * 2] + 0.5) * cell
    const py = (d: number) => a.y + a.h - (XY[d * 2 + 1] + 0.5) * cell
    // Largest free run.
    let best = 0, bestS = -1, run = 0, runS = 0
    for (let u = 0; u < h.units; u++) {
      if (h.cell[u] === 0) { if (!run) runS = u; run++; if (run > best) { best = run; bestS = runS } } else run = 0
    }
    const col = this.theme.examples.highlightColor.toUint32()
    if (bestS >= 0) for (let d = bestS; d < bestS + best - 1; d++) this.path.push(px(d), py(d), px(d + 1), py(d + 1), col)
    this.frame.push(a.x - 1, a.y - 1, a.x + a.w + 1, a.y + a.h + 1, this.theme.gridMinorColor.toUint32())
  }

  override hasGL() { return !!this.heap }
  override drawGL(r: GLRenderer) {
    const lut = this.mode === 'owner' ? this.lutOwner : this.lutAge
    if (!lut) return
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    const a = this.area
    r.scissor(this.rect)
    this.frame.draw(r, maps)
    // Row 0 of the texture is y = 0 of the curve: draw it at the bottom.
    this.tex.draw(r, maps, { x0: a.x, y0: a.y + a.h, x1: a.x + a.w, y1: a.y }, lut)
    r.glow = 1
    this.path.draw(r, maps, 1.6)
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily, a = this.area, h = this.heap
    ctx.save()
    if (h) {
      const lx = a.x + a.w + 16
      let ly = a.y + 6
      ctx.font = `600 11px ${ff}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillStyle = t.titleColor.toCSS()
      ctx.fillText(this.mode === 'owner' ? 'Owner (allocating thread)' : 'Allocation age', lx, ly)
      ly += 18
      ctx.font = `11px ${ff}`
      const sw = (c: Color, label: string) => {
        ctx.fillStyle = c.setA(255).toCSS()
        roundRect(ctx, lx, ly - 5, 10, 10, 2)
        ctx.fill()
        ctx.fillStyle = t.tickLabelColor.toCSS()
        ctx.fillText(label, lx + 16, ly)
        ly += 16
      }
      if (this.mode === 'owner') {
        const live = h.liveByOwner(this.owners.length)
        this.owners.forEach((o, i) => { if (live[i] > 0) sw(o.color, `${o.name}  ${(live[i] / 1024).toFixed(1)} KiB`) })
        sw(t.chartBackgroundFill.getPrimaryColor().setA(255).mix(t.titleColor, 0.42), 'chunk headers')
      } else {
        const pal = t.examples.coldHotColorPalette
        sw(pal[0], 'under 10 ms')
        sw(pal[Math.floor(pal.length / 2)], 'about 1 s')
        sw(pal[pal.length - 1], 'hours (boot time)')
      }
      sw(t.chartBackgroundFill.getPrimaryColor().setA(255).mix(t.titleColor, 0.14), 'free')
      ctx.strokeStyle = t.examples.highlightColor.toCSS()
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(lx, ly)
      ctx.lineTo(lx + 10, ly)
      ctx.stroke()
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.fillText(`largest free run ${(h.largestFree / 1024).toFixed(1)} KiB`, lx + 16, ly)
      ly += 24
      ctx.fillStyle = t.titleColor.toCSS()
      const stats = [
        `${(h.used / 1024).toFixed(1)} of ${(h.bytes / 1024).toFixed(0)} KiB used, peak ${(h.peak / 1024).toFixed(1)}`,
        `${h.blockCount} blocks, ${h.freeRuns} free runs`,
        `fragmentation ${(h.fragmentation * 100).toFixed(0)}%`,
        `${h.failures} failed allocations`,
        'one cell = 8 B chunk; Hilbert order',
        'bottom-left = heap start',
      ]
      stats.forEach((s, i) => { ctx.fillStyle = (i < 4 ? t.titleColor : t.minorTickLabelColor).toCSS(); ctx.fillText(s, lx, ly); ly += 16 })
      if (this.mouse && rectContains(a, this.mouse.x, this.mouse.y)) {
        const cx = Math.floor(((this.mouse.x - a.x) / a.w) * N), cy = Math.floor(((a.y + a.h - this.mouse.y) / a.h) * N)
        const d = D_OF[cy * N + cx]
        const rows: string[] = []
        if (d >= h.units) rows.push('beyond the heap end')
        else {
          const b = h.blockAt(d)
          rows.push(`0x${(this.base + d * CHUNK).toString(16).padStart(8, '0')}`)
          if (b) {
            rows.push(`${this.owners[b.owner]?.name ?? '?'}: ${b.bytes} B at 0x${(this.base + b.start * CHUNK).toString(16)}`)
            const age = this.nowMs - b.t
            rows.push(`age ${age < 1000 ? `${age.toFixed(0)} ms` : age < 3.6e6 ? `${(age / 1000).toFixed(1)} s` : `${(age / 3.6e6).toFixed(1)} h`}`)
          } else rows.push('free')
        }
        ctx.font = `11px ${ff}`
        const w = Math.max(...rows.map((s) => ctx.measureText(s).width)) + 16
        const hh = rows.length * 15 + 10
        let bx = this.mouse.x + 12, by = this.mouse.y + 12
        if (bx + w > this.rect.x + this.rect.w) bx = this.mouse.x - w - 12
        if (by + hh > this.rect.y + this.rect.h) by = this.mouse.y - hh - 8
        roundRect(ctx, bx, by, w, hh, 5)
        ctx.fillStyle = t.cursor.tableFill.toCSS()
        ctx.fill()
        ctx.strokeStyle = t.cursor.tableStroke.toCSS()
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = t.cursor.textColor.toCSS()
        ctx.textBaseline = 'top'
        rows.forEach((s, i) => ctx.fillText(s, bx + 8, by + 6 + i * 15))
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
  override disposeGL(r: GLRenderer | null) { this.tex.dispose(r); this.path.dispose(r); this.frame.dispose(r) }
}
