// SPDX-License-Identifier: Apache-2.0
import { Panel, type Color } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { PointerInfo, Surface } from 'sferic/render/Surface'
import type { GLRenderer } from 'sferic/render/GLRenderer'
import { RectBatch, SegmentBatch } from 'sferic/render/draw'
import { rectContains, roundRect, type Rect } from 'sferic/core/util'
import { drawStatusGlyph, statusColor, type Status } from './status'

/**
 * Live communication graph: ISRs, threads and kernel objects as nodes, the
 * calls between them as curved edges, and a GPU particle for each call as it
 * happens (thinned to what the eye can follow, with the true rate printed on
 * the edge). Nodes carry live state: queue fill, semaphore count, lock owner,
 * thread CPU and effective priority. Alarms pulse.
 */
export type FlowKind = 'irq' | 'thread' | 'object' | 'sink'
export interface FlowNode { id: string; label: string; kind: FlowKind; x: number; y: number; color: Color }
export interface FlowEdge { id: string; from: string; to: string; color: Color }
export interface FlowNodeState {
  /** 0..1 fill bar (queue depth, CPU share). */
  gauge?: number
  /** Second line under the label. */
  text?: string
  alarm?: Status | null
  /** Short tag in the corner (effective priority, waiters). */
  tag?: string
}

export interface FlowGraphOptions extends PanelOptions { surface?: Surface; [k: string]: unknown }

interface NodeGeo { r: Rect; cx: number; cy: number }
interface Particle { e: number; s: number; v: number }

const NODE_W = { irq: 92, thread: 104, object: 98, sink: 86 }
const NODE_H = 38
const MAX_PARTICLES = 600

export class FlowGraph extends Panel {
  private nodes: FlowNode[] = []
  private edges: FlowEdge[] = []
  private idx = new Map<string, number>()
  private geo: NodeGeo[] = []
  private curves: Float32Array[] = []
  private state = new Map<string, FlowNodeState>()
  private rates = new Map<string, number>()
  private edgeAlarm = new Map<string, Status>()
  private parts: Particle[] = []
  private lastSpawn = new Float64Array(0)
  private lastT = 0
  private now = 0
  private boxes = new RectBatch()
  private dots = new RectBatch()
  private lines = new SegmentBatch()
  private hot = new SegmentBatch()
  private hover = -1
  private mouse: { x: number; y: number } | null = null
  private geoKey = ''
  private info: ((id: string) => string[]) | null = null

  constructor(o: FlowGraphOptions) {
    super(o)
    this.padding = { left: 12, right: 12, top: 10, bottom: 8 }
  }

  setGraph(nodes: FlowNode[], edges: FlowEdge[]) {
    this.nodes = nodes
    this.edges = edges
    this.idx = new Map(nodes.map((n, i) => [n.id, i]))
    this.lastSpawn = new Float64Array(edges.length)
    this.geoKey = ''
    this.requestRender()
    return this
  }
  setNodeState(id: string, s: FlowNodeState) { this.state.set(id, s); return this }
  setEdgeRate(id: string, perS: number) { this.rates.set(id, perS); return this }
  setEdgeAlarm(id: string, s: Status | null) { if (s) this.edgeAlarm.set(id, s); else this.edgeAlarm.delete(id); return this }
  setInfo(fn: (id: string) => string[]) { this.info = fn; return this }

  /** One call travelled along `edgeId`; drawn if the edge is not already saturated. */
  pulse(edgeId: string, minGapMs = 45) {
    const e = this.edges.findIndex((x) => x.id === edgeId)
    if (e < 0 || this.parts.length >= MAX_PARTICLES) return
    const t = performance.now()
    if (t - this.lastSpawn[e] < minGapMs) return
    this.lastSpawn[e] = t
    this.parts.push({ e, s: 0, v: 1 / 0.85 })
    this.requestRender()
  }

  override tick(now: number): boolean {
    super.tick(now)
    this.now = now
    const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0
    this.lastT = now
    for (const p of this.parts) p.s += p.v * dt
    this.parts = this.parts.filter((p) => p.s < 1)
    return true
  }

  private sideAnchor(a: NodeGeo, b: NodeGeo): [number, number, number, number] {
    // Leave from the side facing the target; enter on the side facing the source.
    const dx = b.cx - a.cx, dy = b.cy - a.cy
    if (Math.abs(dx) >= Math.abs(dy) * 0.6) {
      const sx = dx >= 0 ? a.r.x + a.r.w : a.r.x
      const ex = dx >= 0 ? b.r.x : b.r.x + b.r.w
      return [sx, a.cy, ex, b.cy]
    }
    const sy = dy >= 0 ? a.r.y + a.r.h : a.r.y
    const ey = dy >= 0 ? b.r.y : b.r.y + b.r.h
    return [a.cx, sy, b.cx, ey]
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const c = this.layoutBase()
    const key = `${c.x},${c.y},${c.w},${c.h},${this.nodes.length}`
    if (key !== this.geoKey) {
      this.geoKey = key
      this.geo = this.nodes.map((n) => {
        const w = NODE_W[n.kind], h = NODE_H
        const cx = c.x + w / 2 + n.x * (c.w - w), cy = c.y + h / 2 + n.y * (c.h - h)
        return { r: { x: cx - w / 2, y: cy - h / 2, w, h }, cx, cy }
      })
      this.curves = this.edges.map((e) => {
        const a = this.geo[this.idx.get(e.from)!], b = this.geo[this.idx.get(e.to)!]
        const [x0, y0, x3, y3] = this.sideAnchor(a, b)
        const horiz = Math.abs(x3 - x0) >= Math.abs(y3 - y0) * 0.6
        const k = horiz ? (x3 - x0) * 0.45 : (y3 - y0) * 0.45
        const x1 = horiz ? x0 + k : x0, y1 = horiz ? y0 : y0 + k
        const x2 = horiz ? x3 - k : x3, y2 = horiz ? y3 : y3 - k
        const N = 24, pts = new Float32Array((N + 1) * 2)
        for (let i = 0; i <= N; i++) {
          const s = i / N, u = 1 - s
          pts[i * 2] = u * u * u * x0 + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3
          pts[i * 2 + 1] = u * u * u * y0 + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3
        }
        return pts
      })
    }
    this.build()
  }

  private at(e: number, s: number): [number, number] {
    const pts = this.curves[e], N = pts.length / 2 - 1
    const f = Math.min(N - 1e-6, s * N), i = Math.floor(f), u = f - i
    return [pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * u, pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * u]
  }

  private build() {
    const t = this.theme
    const boxes = this.boxes, dots = this.dots, lines = this.lines, hot = this.hot
    boxes.clear(); dots.clear(); lines.clear(); hot.clear()
    const pulse = 0.5 + 0.5 * Math.sin(this.now / 160)
    this.edges.forEach((e, i) => {
      const pts = this.curves[i]
      if (!pts) return
      const alarm = this.edgeAlarm.get(e.id)
      const col = alarm ? statusColor(t, alarm).setA(140 + 100 * pulse) : e.color.setA(t.isDark ? 90 : 120)
      const tgt = alarm ? hot : lines
      for (let k = 0; k + 3 < pts.length; k += 2) tgt.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], col.toUint32())
      // Arrowhead at the target end.
      const n = pts.length
      const ex = pts[n - 2], ey = pts[n - 1], px = pts[n - 4], py = pts[n - 3]
      const ang = Math.atan2(ey - py, ex - px)
      for (const sgn of [-0.5, 0.5]) tgt.push(ex, ey, ex - 7 * Math.cos(ang + sgn), ey - 7 * Math.sin(ang + sgn), col.toUint32())
    })
    for (const p of this.parts) {
      const [x, y] = this.at(p.e, p.s)
      const c = this.edges[p.e].color
      dots.push(x - 3, y - 3, x + 3, y + 3, c.setA(255).toUint32())
    }
    this.nodes.forEach((n, i) => {
      const g = this.geo[i]
      if (!g) return
      const st = this.state.get(n.id)
      const alarm = st?.alarm
      const ring = alarm && alarm !== 'ok' ? statusColor(t, alarm).setA(alarm === 'crit' ? 150 + 105 * pulse : 220) : n.color.setA(i === this.hover ? 255 : 200)
      const r = g.r
      boxes.push(r.x - 1.5, r.y - 1.5, r.x + r.w + 1.5, r.y + r.h + 1.5, ring.toUint32())
      boxes.push(r.x, r.y, r.x + r.w, r.y + r.h, t.uiFill.toUint32())
      if (st?.gauge !== undefined) {
        const gw = (r.w - 12) * Math.max(0, Math.min(1, st.gauge))
        boxes.push(r.x + 6, r.y + r.h - 6, r.x + r.w - 6, r.y + r.h - 3, t.gridMajorColor.toUint32())
        if (gw > 0.5) boxes.push(r.x + 6, r.y + r.h - 6, r.x + 6 + gw, r.y + r.h - 3, n.color.setA(255).toUint32())
      }
    })
  }

  override hasGL() { return true }
  override drawGL(r: GLRenderer) {
    const id = { a0: 0, start: 0, k: 1, log: 0 }, maps = { mx: id, my: id }
    r.scissor(this.rect)
    this.lines.draw(r, maps, 1.4)
    r.glow = 1
    this.hot.draw(r, maps, 2.2)
    this.dots.draw(r, maps, { radius: 3 })
    r.glow = 0
    this.boxes.draw(r, maps, { radius: 6 })
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme, ff = t.fontFamily
    ctx.save()
    // Edge rates at the curve middles.
    ctx.font = `10px ${ff}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    this.edges.forEach((e, i) => {
      const rate = this.rates.get(e.id)
      if (!rate || !this.curves[i]) return
      const [x, y] = this.at(i, 0.5)
      const s = rate >= 1000 ? `${(rate / 1000).toFixed(1)}k/s` : rate >= 10 ? `${rate.toFixed(0)}/s` : `${rate.toFixed(1)}/s`
      const w = ctx.measureText(s).width + 8
      ctx.fillStyle = t.chartBackgroundFill.getPrimaryColor().setA(210).toCSS()
      ctx.fillRect(x - w / 2, y - 7, w, 14)
      ctx.fillStyle = (this.edgeAlarm.has(e.id) ? statusColor(t, this.edgeAlarm.get(e.id)!) : t.tickLabelColor).toCSS()
      ctx.fillText(s, x, y)
    })
    this.nodes.forEach((n, i) => {
      const g = this.geo[i]
      if (!g) return
      const st = this.state.get(n.id)
      const r = g.r
      ctx.textAlign = 'left'
      ctx.font = `600 11.5px ${ff}`
      ctx.fillStyle = (n.kind === 'object' ? t.titleColor : n.color.setA(255)).toCSS()
      const lx = r.x + (st?.alarm && st.alarm !== 'ok' ? 18 : 8)
      if (st?.alarm && st.alarm !== 'ok') drawStatusGlyph(ctx, st.alarm, r.x + 10, r.y + 12, 3.6, statusColor(t, st.alarm).toCSS())
      ctx.fillText(n.label, lx, r.y + 12, r.w - (lx - r.x) - 4)
      const lw = ctx.measureText(n.label).width
      if (st?.text) {
        ctx.font = `10.5px ${ff}`
        ctx.fillStyle = t.tickLabelColor.toCSS()
        ctx.fillText(st.text, r.x + 8, r.y + 25, r.w - 12)
      }
      if (st?.tag) {
        ctx.font = `600 9.5px ${ff}`
        // The tag yields to the label when the node is too narrow for both.
        if (lx + lw + 8 < r.x + r.w - 6 - ctx.measureText(st.tag).width) {
          ctx.textAlign = 'right'
          ctx.fillStyle = t.minorTickLabelColor.toCSS()
          ctx.fillText(st.tag, r.x + r.w - 6, r.y + 12)
        }
      }
      if (n.kind !== 'thread' && n.kind !== 'irq') {
        ctx.font = `9px ${ff}`
        ctx.textAlign = 'right'
        ctx.fillStyle = t.minorTickLabelColor.toCSS()
        ctx.fillText(n.kind === 'sink' ? 'host' : '', r.x + r.w - 6, r.y + 25)
      }
    })
    if (this.mouse && this.hover >= 0 && this.info) {
      const rows = this.info(this.nodes[this.hover].id)
      if (rows.length) {
        ctx.font = `11px ${ff}`
        const w = Math.max(...rows.map((s) => ctx.measureText(s).width)) + 16
        const h = rows.length * 15 + 10
        let bx = this.mouse.x + 14, by = this.mouse.y + 14
        if (bx + w > this.rect.x + this.rect.w) bx = this.mouse.x - w - 14
        if (by + h > this.rect.y + this.rect.h) by = this.mouse.y - h - 10
        roundRect(ctx, bx, by, w, h, 5)
        ctx.fillStyle = t.cursor.tableFill.toCSS()
        ctx.fill()
        ctx.strokeStyle = t.cursor.tableStroke.toCSS()
        ctx.stroke()
        ctx.fillStyle = t.cursor.textColor.toCSS()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        rows.forEach((s, k) => ctx.fillText(s, bx + 8, by + 6 + k * 15))
      }
    }
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    if (e.type === 'leave') { this.hover = -1; this.mouse = null; return false }
    const i = this.geo.findIndex((g) => rectContains(g.r, e.x, e.y))
    this.mouse = { x: e.x, y: e.y }
    if (i !== this.hover) this.hover = i
    if (e.type === 'move') this.surface.setCursor(i >= 0 ? 'pointer' : 'default')
    if (e.type === 'click' && i >= 0) { this.emit('nodeclick', { id: this.nodes[i].id }); return true }
    return false
  }

  override disposeGL(r: GLRenderer | null) { this.boxes.dispose(r); this.dots.dispose(r); this.lines.dispose(r); this.hot.dispose(r) }
}
