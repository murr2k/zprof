// SPDX-License-Identifier: Apache-2.0
import { Panel } from 'sferic'
import type { PanelOptions } from 'sferic/core/Panel'
import type { Surface } from 'sferic/render/Surface'

/** One thread on the map: its priority against its period (or its shortest interval). */
export interface MapPoint {
  name: string
  prio: number
  /** The period of a periodic thread, the shortest interval seen of another; us. */
  t: number
  periodic: boolean
  /** The deadline used for its order (declared, else its period), us; none: not ordered. */
  d: number | null
  /** Its deadline is in the verdict. */
  judged: boolean
}

export interface PriorityMapOptions extends PanelOptions {
  surface?: Surface
  [k: string]: unknown
}

/**
 * Priority against period, Zephyr's way up: the highest priority (most negative)
 * on top, cooperative threads in a shaded band. Under deadline monotonic order a
 * shorter deadline never sits below a longer one; every pair that does is joined
 * by a line (the higher end is the one that should be lower). Filled: periodic;
 * hollow: no period (placed at its shortest interval). Canvas2D only.
 */
export class PriorityMap extends Panel {
  private pts: MapPoint[] = []

  constructor(o: PriorityMapOptions) {
    super(o)
    this.padding = { left: 12, right: 16, top: 10, bottom: 8 }
  }

  private box = { x: 0, y: 0, w: 0, h: 0 }

  setPoints(p: MapPoint[]) { this.pts = p.filter((x) => x.t > 0); this.requestRender(); return this }

  override layout(_ctx: CanvasRenderingContext2D) { this.box = this.layoutBase() }

  /** Pairs out of deadline monotonic order: [the shorter deadline, the longer one above it]. */
  static inversions(p: MapPoint[]): [MapPoint, MapPoint][] {
    const d = p.filter((x) => x.d !== null)
    const out: [MapPoint, MapPoint][] = []
    for (const a of d) for (const b of d) if (a.d! < b.d! && a.prio > b.prio) out.push([a, b])
    return out
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const c = this.box
    const P = this.pts
    ctx.save()
    if (!P.length) {
      ctx.font = `12px ${t.fontFamily}`
      ctx.fillStyle = t.legend.disabledColor.toCSS()
      ctx.textAlign = 'center'
      ctx.fillText('No threads with jobs yet', c.x + c.w / 2, c.y + c.h / 2)
      ctx.restore()
      this.drawTitle(ctx)
      this.drawUI(ctx)
      return
    }
    const axisW = 44, axisH = 22, labelW = 120
    const plot = { x: c.x + axisW, y: c.y + 6, w: Math.max(20, c.w - axisW - labelW), h: Math.max(20, c.h - axisH - 10) }
    const lt = P.map((x) => Math.log10(x.t))
    let lo = Math.floor(Math.min(...lt)), hi = Math.ceil(Math.max(...lt))
    if (hi === lo) hi = lo + 1
    const prios = P.map((x) => x.prio)
    const pLo = Math.min(...prios) - 1, pHi = Math.max(...prios) + 1
    const X = (us: number) => plot.x + ((Math.log10(us) - lo) / (hi - lo)) * plot.w
    const Y = (p: number) => plot.y + ((p - pLo) / (pHi - pLo)) * plot.h
    // the cooperative band
    if (pLo < 0) {
      ctx.fillStyle = t.isDark ? 'rgba(143,180,255,0.07)' : 'rgba(60,90,160,0.06)'
      const y0 = Y(pLo), y1 = Y(Math.min(-0.5, pHi))
      ctx.fillRect(plot.x, y0, plot.w, y1 - y0)
      ctx.font = `10.5px ${t.fontFamily}`
      ctx.fillStyle = t.axisTitleColor.toCSS()
      ctx.textAlign = 'right'
      ctx.textBaseline = 'top'
      ctx.fillText('cooperative', plot.x + plot.w - 4, y0 + 3)
    }
    // axes: decades of period, priorities
    ctx.strokeStyle = t.gridMajorColor.toCSS()
    ctx.fillStyle = t.tickLabelColor.toCSS()
    ctx.font = `10.5px ${t.fontFamily}`
    ctx.lineWidth = 1
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const dec = (k: number) => (k < 3 ? `${10 ** k} us` : k < 6 ? `${10 ** (k - 3)} ms` : `${10 ** (k - 6)} s`)
    for (let k = lo; k <= hi; k++) {
      const x = Math.round(X(10 ** k)) + 0.5
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke()
      ctx.fillText(dec(k), x, plot.y + plot.h + 4)
    }
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const step = Math.max(1, Math.ceil((pHi - pLo) / 8))
    for (let p = Math.ceil(pLo); p <= pHi; p += step) ctx.fillText(String(p), plot.x - 6, Y(p))
    ctx.save()
    ctx.translate(c.x + 8, plot.y + plot.h / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillStyle = t.axisTitleColor.toCSS()
    ctx.fillText('priority (higher on top)', 0, 0)
    ctx.restore()
    // deadline monotonic inversions
    const [bad] = t.examples.badGoodColorPalette
    ctx.strokeStyle = bad.setA(170).toCSS()
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    for (const [a, b] of PriorityMap.inversions(P)) {
      ctx.beginPath(); ctx.moveTo(X(a.t), Y(a.prio)); ctx.lineTo(X(b.t), Y(b.prio)); ctx.stroke()
    }
    ctx.setLineDash([])
    // the threads
    const acc = t.seriesColors[0].toCSS()
    ctx.textAlign = 'left'
    ctx.font = `11px ${t.fontFamily}`
    for (const p of P) {
      const x = X(p.t), y = Y(p.prio)
      ctx.beginPath()
      ctx.arc(x, y, p.judged ? 5 : 3.5, 0, Math.PI * 2)
      if (p.periodic) { ctx.fillStyle = p.judged ? acc : t.tickLabelColor.toCSS(); ctx.fill() }
      else { ctx.strokeStyle = t.tickLabelColor.toCSS(); ctx.lineWidth = 1.3; ctx.stroke() }
      ctx.fillStyle = p.judged ? t.titleColor.toCSS() : t.tickLabelColor.toCSS()
      ctx.fillText(p.name, x + 8, y, labelW - 10)
    }
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }
}
