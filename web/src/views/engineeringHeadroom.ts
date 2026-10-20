import { sferic, AxisTickStrategies, ColorShadingStyles, LUT, PalettedFill, SolidFill, type CellContent } from 'sferic'
import { EmptyTickStrategy, type Tick, type TickContext } from 'sferic/xy/ticks'
import type { SurfaceGridSeries3D } from 'sferic/chart3d/surface3d'
import { statusColor, type Status } from '../charts/status'
import { targetSim, LINK_BUDGET_BPS, CTRL_BUDGET_US, THREADS, TH, type Heartbeat } from '../sim/target'
import { liveRule, ruleStatus, type Rule } from '../thresholds'
import { button, el, glyph } from '../dom'
import type { View } from './common'

/** One tick per lane, labelled with the lane's name (the numeric strategy would skip some). */
class LaneTicks extends EmptyTickStrategy {
  names: string[] = []
  override generate(ctx?: TickContext): Tick[] {
    const out: Tick[] = []
    if (!ctx) return out
    for (let i = Math.ceil(ctx.lo); i <= Math.floor(ctx.hi); i++) if (this.names[i]) out.push({ value: i, label: this.names[i], level: 0 })
    return out
  }
}

interface Res { label: string; rule: string; unit: string; value: (h: Heartbeat) => number }
const stackRes = (i: number): Res => ({ label: `stack ${THREADS[i].name}`, rule: `stack.${THREADS[i].name}.margin`, unit: '% margin', value: (h) => (1 - h.threads[i].stackUsed / h.threads[i].stackSize) * 100 })
const RES: Res[] = [
  { label: 'CPU load', rule: 'cpu.load', unit: '%', value: (h) => h.cpuPct },
  { label: 'ctrl_loop p99', rule: 'span.ctrl_loop.p99_pct', unit: '% of budget', value: (h) => (h.ctrl.p99 / CTRL_BUDGET_US) * 100 },
  stackRes(TH.CTRL), stackRes(TH.NET), stackRes(TH.ZPROF), stackRes(TH.STORAGE),
  { label: 'heap in use', rule: 'heap._system_heap.peak_pct', unit: '%', value: (h) => (h.heap.alloc / h.heap.size) * 100 },
  { label: 'heap fragmentation', rule: 'heap._system_heap.frag_pct', unit: '%', value: (h) => h.heap.frag * 100 },
  { label: 'net_buf pool', rule: 'slab.net_buf_rx.peak_pct', unit: '%', value: (h) => (h.slab.used / h.slab.blocks) * 100 },
  { label: 'rx_fifo', rule: 'fifo.rx_fifo.peak_pct', unit: '%', value: (h) => (h.msgq.peak / h.msgq.max) * 100 },
  { label: 'sample_q', rule: 'msgq.sample_q.peak_pct', unit: '%', value: (h) => (h.sampleQ.used / h.sampleQ.max) * 100 },
  { label: 'log buffer', rule: 'log.buf.peak_pct', unit: '%', value: (h) => (h.logBuf.used / h.logBuf.size) * 100 },
  { label: 'RTT up 1', rule: 'trace.buf.peak_pct', unit: '%', value: (h) => (h.rttUp.used / h.rttUp.size) * 100 },
  { label: 'telemetry link', rule: 'link.util', unit: '%', value: (h) => (h.linkBps / LINK_BUDGET_BPS) * 100 },
  { label: 'eth0 IRQ rate', rule: 'irq.eth0.per_s', unit: '/s', value: (h) => h.irqs[2].perS },
  { label: 'agent self-cost', rule: 'agent.self', unit: '%', value: (h) => h.selfPct },
]

/**
 * Threshold units: 0..1 is below warn, 1..2 warn to crit, 2..3 past crit, so
 * every resource shares the same two planes whatever its own limits are.
 * Margin rules (lower is worse) are measured as the share used.
 */
export function thresholdUnits(r: Rule, v: number) {
  const lower = r.op === '<' || r.op === '<='
  let x = v, w = r.warn, c = r.crit
  if (lower) { x = 100 - v; w = w === undefined ? undefined : 100 - w; c = c === undefined ? undefined : 100 - c }
  if (w === undefined && c !== undefined) w = c * 0.75
  if (c === undefined && w !== undefined) c = w * 1.33
  if (w === undefined || c === undefined || !Number.isFinite(x)) return NaN
  if (w <= 0) return x > c ? 2 + Math.min(1, (x - c) / Math.max(1e-9, Math.abs(c) || 1)) : x > w ? 1.5 : 0
  if (x <= w) return Math.max(0, x / w)
  if (x <= c) return 1 + (x - w) / Math.max(1e-9, c - w)
  return 2 + Math.min(1, (x - c) / Math.max(1e-9, c - w))
}

const COLS = 300
type Cam = 'iso' | 'front' | 'top' | 'side'
const CAMS: Record<Cam, { yaw: number; pitch: number; label: string; note: string }> = {
  iso: { yaw: 38, pitch: 26, label: 'Landscape', note: 'every resource over the last 60 s; peaks through the planes are breaches' },
  front: { yaw: 0, pitch: 0, label: 'Front: overlay', note: 'ribbons edge-on: all resources overlaid on one threshold scale' },
  top: { yaw: 0, pitch: 89, label: 'Top: heat strip', note: 'resource x time, colored by threshold units: a status strip chart' },
  side: { yaw: 90, pitch: 0, label: 'Side: envelope', note: 'looking down the time axis: each resource\'s worst moment, ranked by height' },
}

/**
 * Headroom landscape: every budgeted resource as a ribbon over time, height
 * in threshold units, planes at warn and crit. Rotating the one chart turns
 * it into an overlay, a heat strip or an envelope.
 */
export const engineeringHeadroom: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const [bad, mid, good] = t.examples.badGoodColorPalette
  const root = el('div', 'vstack')
  const bar = el('div', 'toolbar')
  const host = el('div', 'fill')
  root.append(bar, host)
  container.appendChild(root)
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 2, numberOfRows: 1, splitterThickness: 4 })
  dash.setColumnWidth(0, 2.3).setColumnWidth(1, 1)
  const chart = dash.createChart3D({ columnIndex: 0, rowIndex: 0, legend: { visible: false } })
    .setTitle('Headroom landscape: resources x time, height in threshold units (1 = warn, 2 = crit)')
    .setTitleFont((f) => f.setSize(13))
  const grid = dash.createDataGrid({ columnIndex: 1, rowIndex: 0 }).setTitle('Closest to the edge, now').setTitleFont((f) => f.setSize(13))
  grid.setCellChangeHighlight(false)

  chart.setBoundingBox({ x: 1.7, y: 0.62, z: 1.25 })
  chart.setPadding({ left: 90, right: 20 })
  chart.getDefaultAxisX().setTitle('Seconds ago').setInterval({ start: -60, end: 0, stopAxisAfter: true })
  chart.getDefaultAxisY().setTitle('Threshold units').setInterval({ start: 0, end: 3, stopAxisAfter: true })
    .setTickStrategy(AxisTickStrategies.Numeric, (s) => s.setFormattingFunction((v) => (Math.abs(v - 1) < 1e-6 ? 'warn' : Math.abs(v - 2) < 1e-6 ? 'crit' : Math.abs(v) < 1e-6 ? '0' : '')))
  const lanes = new LaneTicks()
  lanes.names = RES.map((r) => r.label)
  chart.getDefaultAxisZ().setTitle('').setInterval({ start: -0.6, end: RES.length - 0.4, stopAxisAfter: true }).setTickStrategy(lanes)

  const lut = new LUT({ interpolate: true, steps: [{ value: 0, color: good.setA(255) }, { value: 0.85, color: good.setA(255) }, { value: 1, color: mid }, { value: 1.85, color: mid }, { value: 2, color: bad }, { value: 3, color: bad }] })
  const ribbons: SurfaceGridSeries3D[] = RES.map((r, i) => chart
    .addSurfaceGridSeries({ columns: COLS, rows: 2, start: { x: -60, z: i - 0.32 }, end: { x: 0, z: i + 0.32 } })
    .setName(r.label)
    .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' }))
    .setColorShadingStyle(new ColorShadingStyles.Phong({ specularReflection: 0.2 })))
  const plane = (y: number, c: typeof mid, name: string) => {
    const s = chart.addSurfaceGridSeries({ columns: 2, rows: 2, start: { x: -60, z: -0.6 }, end: { x: 0, z: RES.length - 0.4 } }).setName(name)
    s.setFillStyle(new SolidFill({ color: c.setA(t.isDark ? 46 : 60) })).invalidateHeightMap(new Float32Array([y, y, y, y]))
    s.setCursorEnabled(false)
    return s
  }
  plane(1, mid, 'warn plane')
  plane(2, bad, 'crit plane')
  chart.setCursorFormatting((_c, hit) => {
    const s = hit.series
    const i = ribbons.indexOf(s as SurfaceGridSeries3D)
    if (i < 0) return []
    const tu = hit.y
    const r = RES[i]
    return [[{ text: r.label, color: (tu >= 2 ? bad : tu >= 1 ? mid : good).setA(255) }], ['At:', `${(-hit.x).toFixed(1)} s ago`], ['Threshold units:', tu.toFixed(2)], ['Rule:', `${r.rule}`]]
  })

  // ---------------------------------------------------------------- data
  const rules = RES.map((r) => liveRule(r.rule))
  const vals = RES.map(() => new Float32Array(COLS * 2))
  const refresh = () => {
    const hb = sim.heartbeats
    if (!hb.length) return
    const tNow = hb[hb.length - 1].t
    // One column per 200 ms over the last 60 s (nearest earlier heartbeat).
    let j = hb.length - 1
    for (let c = COLS - 1; c >= 0; c--) {
      const tc = tNow - (COLS - 1 - c) * 200
      while (j > 0 && hb[j].t > tc) j--
      const h = hb[j]
      RES.forEach((r, i) => {
        const rule = rules[i]
        const u = rule ? thresholdUnits(rule, r.value(h)) : NaN
        const v = Number.isFinite(u) ? Math.min(3, u) : 0
        vals[i][c * 2] = v
        vals[i][c * 2 + 1] = v
      })
    }
    ribbons.forEach((s, i) => s.invalidateHeightMap(vals[i]))
    const h = hb[hb.length - 1]
    const rows = RES.map((r, i) => {
      const rule = rules[i]
      const v = r.value(h)
      const u = rule ? thresholdUnits(rule, v) : NaN
      const st: Status = rule ? ruleStatus(rule, v) : 'idle'
      return { r, v, u, st }
    }).sort((a, b) => (b.u || 0) - (a.u || 0))
    const head = ['Resource', 'Now', 'Units', 'Status']
    grid.setTableContent([head, ...rows.map((x): CellContent[] => [
      x.r.label, `${x.v.toFixed(x.v < 10 ? 2 : 0)} ${x.r.unit}`, { value: x.u, text: Number.isFinite(x.u) ? x.u.toFixed(2) : '-', bar: Math.min(3, x.u || 0), barMin: 0, barMax: 3, barColor: statusColor(t, x.st) },
      x.st === 'ok' ? 'ok' : x.st === 'warn' ? 'WARN' : x.st === 'crit' ? 'CRIT' : '',
    ])])
    rows.forEach((x, i) => grid.setCellTextFillStyle(3, i + 1, statusColor(t, x.st)))
  }
  refresh()
  const timer = setInterval(refresh, 400)

  // ---------------------------------------------------------------- camera presets
  let anim = 0
  let orbit = false
  const DEG = Math.PI / 180
  const camNote = el('span', 'note')
  const dist = () => { const p = chart.getCameraLocation(); return Math.hypot(p.x, p.y, p.z) || 4 }
  const angles = () => { const p = chart.getCameraLocation(); const d = Math.hypot(p.x, p.y, p.z) || 1; return { yaw: Math.atan2(p.x, p.z) / DEG, pitch: Math.asin(p.y / d) / DEG } }
  const setCam = (yaw: number, pitch: number, d: number) => chart.setCameraLocation({ x: d * Math.sin(yaw * DEG) * Math.cos(pitch * DEG), y: d * Math.sin(pitch * DEG), z: d * Math.cos(yaw * DEG) * Math.cos(pitch * DEG) })
  const fly = (to: Cam) => {
    cancelAnimationFrame(anim)
    orbit = false
    orbitBtn.classList.remove('on')
    const a = angles(), b = CAMS[to], d = dist()
    let dy = b.yaw - a.yaw
    while (dy > 180) dy -= 360
    while (dy < -180) dy += 360
    const t0 = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 750)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      setCam(a.yaw + dy * e, a.pitch + (b.pitch - a.pitch) * e, d)
      if (k < 1) anim = requestAnimationFrame(step)
    }
    anim = requestAnimationFrame(step)
    for (const [k, btn] of camBtns) btn.classList.toggle('on', k === to)
    camNote.innerHTML = `${glyph('info')} ${CAMS[to].note}`
  }
  const camBtns = (Object.keys(CAMS) as Cam[]).map((k) => [k, button(CAMS[k].label, () => fly(k))] as const)
  const orbitBtn = button('Orbit', () => {
    orbit = !orbit
    orbitBtn.classList.toggle('on', orbit)
    if (!orbit) return
    cancelAnimationFrame(anim)
    const d = dist()
    const spin = () => { if (!orbit) return; const a = angles(); setCam(a.yaw + 0.25, a.pitch, d); anim = requestAnimationFrame(spin) }
    anim = requestAnimationFrame(spin)
  })
  const seg = el('div', 'seg')
  for (const [, b] of camBtns) seg.appendChild(b)
  bar.append(el('span', 'note', 'View'), seg, orbitBtn, el('span', 'sep'), camNote, el('span', 'grow'), el('span', 'note', 'drag to rotate &middot; wheel to zoom &middot; limits from the thresholds file'))
  setTimeout(() => fly('iso'), 50)

  return () => {
    orbit = false
    cancelAnimationFrame(anim)
    clearInterval(timer)
    dash.dispose()
  }
}
