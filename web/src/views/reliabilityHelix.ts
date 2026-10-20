import { sferic, LUT, PalettedFill, PointStyle3D, SolidFill, SolidLine, regularColorSteps, type CellContent, type Color } from 'sferic'
import { SoakSim, DUTS, chamber, isFailure, type Phase, type SoakEvent } from '../sim/soak'
import { button, el, esc, glyph, segmented } from '../dom'
import type { View } from './common'

const CYCLE_H = 4
const PHASES: { phase: Phase; h0: number; h1: number }[] = [
  { phase: 'ambient', h0: 0, h1: 1 }, { phase: 'ramp up', h0: 1, h1: 1.5 }, { phase: 'hot dwell', h0: 1.5, h1: 2.5 },
  { phase: 'ramp down', h0: 2.5, h1: 3.25 }, { phase: 'cold dwell', h0: 3.25, h1: 3.75 }, { phase: 'recover', h0: 3.75, h1: 4 },
]
type Metric = 'none' | 'heap' | 'p99' | 'die'

/** One-sided binomial tail P(X >= k), X ~ Bin(n, p). */
function binomTail(n: number, k: number, p: number) {
  let s = 0
  for (let i = k; i <= n; i++) {
    let c = 1
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1)
    s += c * Math.pow(p, i) * Math.pow(1 - p, n - i)
  }
  return s
}

/**
 * Thermal helix: each DUT's soak as a helix with one turn per chamber cycle,
 * height = hours into the run, color = chamber temperature, radius nudged by a
 * chosen metric. From above, every cycle lines up by chamber phase, so faults
 * that depend on temperature stack up in one sector; from the side it is a
 * time series; a leak is a helix that flares out. The table tests the
 * clustering instead of leaving it to the eye.
 */
export const reliabilityHelix: View = ({ container, theme: t }) => {
  const soak = new SoakSim()
  const [bad, mid] = t.examples.badGoodColorPalette
  const root = el('div', 'vstack')
  const bar = el('div', 'toolbar')
  const host = el('div', 'fill')
  root.append(bar, host)
  container.appendChild(root)
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 2, numberOfRows: 2, splitterThickness: 4 })
  dash.setColumnWidth(0, 1.75).setColumnWidth(1, 1).setRowHeight(0, 1).setRowHeight(1, 1.15)
  const chart = dash.createChart3D({ columnIndex: 0, rowIndex: 0, rowSpan: 2, legend: { visible: true, position: 'right', addEntriesAutomatically: false } })
    .setTitle('Thermal helix: one turn per 4 h chamber cycle, height = hours, color = chamber temperature')
    .setTitleFont((f) => f.setSize(13))
  const phaseGrid = dash.createDataGrid({ columnIndex: 1, rowIndex: 0 }).setTitle('Failures by chamber phase').setTitleFont((f) => f.setSize(13))
  const evGrid = dash.createDataGrid({ columnIndex: 1, rowIndex: 1 }).setTitle('Events, ordered by chamber phase').setTitleFont((f) => f.setSize(13))
  phaseGrid.setCellChangeHighlight(false)
  evGrid.setCellChangeHighlight(false)

  chart.setBoundingBox({ x: 1.25, y: 1.35, z: 1.25 })
  chart.getDefaultAxisX().setTitle('').setTickLabelsVisible(false)
  chart.getDefaultAxisZ().setTitle('').setTickLabelsVisible(false)
  chart.getDefaultAxisY().setTitle('Hours into run')
  const pal = t.examples.coldHotColorPalette
  const lut = new LUT({ interpolate: true, steps: regularColorSteps(-20, 70, pal), units: 'C' })

  const R0 = 1, DR = 0.42
  const angle = (h: number) => (((h % CYCLE_H) + CYCLE_H) % CYCLE_H) / CYCLE_H * Math.PI * 2
  let metric: Metric = 'heap'
  const lines = DUTS.map((name) => chart.addLineSeries().setName(name)
    .setLineStyle(new SolidLine({ thickness: 1.6, fillStyle: new PalettedFill({ lut, lookUpProperty: 'value' }) })))
  const mkPts = (name: string, color: Color, size: number) => {
    const s = chart.addPointSeries().setName(name)
    s.setPointStyle(new PointStyle3D.Triangulated({ shape: 'sphere', size, fillStyle: new SolidFill({ color }) }))
    return s
  }
  const fails = mkPts('failure (reset, fatal)', bad, 13)
  const hangs = mkPts('hang', mid, 11)
  const gaps = mkPts('telemetry gap (not a DUT failure)', t.minorTickLabelColor, 7)
  chart.legend.add(lut, { name: 'chamber' })
  for (const s of [fails, hangs, gaps]) chart.legend.add(s)
  // Phase boundaries on the floor and the roof: a dial to read the top view against.
  const spokes = PHASES.map((p) => {
    const s = chart.addLineSeries().setName(p.phase)
    s.setLineStyle(new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: t.tickColor.setA(150) }) }))
    s.setCursorEnabled(false)
    return { p, s }
  })

  const norm = (d: number, i: number) => {
    const s = soak.series[d]
    switch (metric) {
      case 'heap': return (s.heap[i] - 9.6) / 6
      case 'p99': return (s.p99[i] - 340) / 120
      case 'die': return (s.die[i] - 38) / 120
      default: return 0
    }
  }
  const pos = (d: number, h: number, i: number) => {
    const r = R0 + d * DR + Math.max(-0.3, Math.min(0.9, norm(d, i) * 0.6))
    const a = angle(h)
    return { x: r * Math.cos(a), z: r * Math.sin(a), y: h }
  }
  const nearest = (d: number, h: number) => {
    const hs = soak.series[d].h
    let lo = 0, hi = hs.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (hs[m] < h) lo = m + 1; else hi = m }
    return lo
  }
  const rebuild = () => {
    DUTS.forEach((_, d) => {
      const s = soak.series[d]
      const pts = []
      for (let i = 0; i < s.h.length; i += 2) {
        const p = pos(d, s.h[i], i)
        pts.push({ ...p, value: chamber(s.h[i]).c })
      }
      lines[d].clear().add(pts)
    })
    const evs = soak.eventsSoFar()
    const at = (e: SoakEvent) => { const i = nearest(e.dut, e.h); return pos(e.dut, e.h, i) }
    fails.clear().add(evs.filter((e) => isFailure(e)).map(at))
    hangs.clear().add(evs.filter((e) => e.kind === 'hang').map(at))
    gaps.clear().add(evs.filter((e) => e.kind === 'linkgap').map(at))
    const rMax = R0 + DUTS.length * DR + 0.6
    for (const { p, s } of spokes) {
      const a = (p.h0 / CYCLE_H) * Math.PI * 2
      s.clear().add([
        { x: 0, y: 0, z: 0 }, { x: rMax * Math.cos(a), y: 0, z: rMax * Math.sin(a) },
        { x: rMax * Math.cos(a), y: soak.elapsed, z: rMax * Math.sin(a) }, { x: 0, y: soak.elapsed, z: 0 },
      ])
    }
  }
  rebuild()

  // ---------------------------------------------------------------- phase clustering
  const phaseOf = (h: number) => { const p = ((h % CYCLE_H) + CYCLE_H) % CYCLE_H; return PHASES.find((x) => p >= x.h0 && p < x.h1)!.phase }
  const evs = soak.eventsSoFar()
  const failsAll = evs.filter(isFailure)
  const n = failsAll.length
  const rows = PHASES.map((p) => {
    const k = failsAll.filter((e) => phaseOf(e.h) === p.phase).length
    const share = (p.h1 - p.h0) / CYCLE_H
    const pv = k ? binomTail(n, k, share) : 1
    return { p, k, share, exp: n * share, pv }
  })
  const head = ['Phase', 'Chamber', 'Share', 'Failures', 'Expected', 'p (one-sided)']
  phaseGrid.setTableContent([head, ...rows.map((r): CellContent[] => [
    r.p.phase, `${chamber(r.p.h0 + 0.01).c.toFixed(0)} to ${chamber(r.p.h1 - 0.01).c.toFixed(0)} C`, `${(r.share * 100).toFixed(1)}%`,
    { value: r.k, text: String(r.k), bar: r.k, barMin: 0, barMax: Math.max(1, n), barColor: r.pv < 0.05 ? bad : t.seriesColors[0] },
    r.exp.toFixed(2), r.k ? (r.pv < 0.001 ? r.pv.toExponential(1) : r.pv.toFixed(3)) : '',
  ])])
  rows.forEach((r, i) => { if (r.pv < 0.05) phaseGrid.setRowTextFillStyle(i + 1, bad.setA(255)) })
  const top = [...rows].sort((a, b) => a.pv - b.pv)[0]
  const sameDut = new Set(failsAll.filter((e) => phaseOf(e.h) === top.p.phase).map((e) => e.dut)).size
  const evRows = [...evs].sort((a, b) => ((a.h % CYCLE_H) - (b.h % CYCLE_H)))
  evGrid.setTableContent([['Phase', 'DUT', 'At', 'Chamber', 'Kind', 'Detail'], ...evRows.map((e): CellContent[] => [
    phaseOf(e.h), DUTS[e.dut], `${e.h.toFixed(2)} h`, `${chamber(e.h).c.toFixed(0)} C`, e.kind, e.detail,
  ])])
  evRows.forEach((e, i) => { if (isFailure(e)) evGrid.setCellTextFillStyle(4, i + 1, bad.setA(255)) })
  evGrid.setColumnWidth(5, { min: 360 })

  // ---------------------------------------------------------------- camera
  const DEG = Math.PI / 180
  let anim = 0, orbit = false
  const dist = () => { const p = chart.getCameraLocation(); return Math.hypot(p.x, p.y, p.z) || 5 }
  const angles = () => { const p = chart.getCameraLocation(); const d = Math.hypot(p.x, p.y, p.z) || 1; return { yaw: Math.atan2(p.x, p.z) / DEG, pitch: Math.asin(p.y / d) / DEG } }
  const setCam = (yaw: number, pitch: number, d: number) => chart.setCameraLocation({ x: d * Math.sin(yaw * DEG) * Math.cos(pitch * DEG), y: d * Math.sin(pitch * DEG), z: d * Math.cos(yaw * DEG) * Math.cos(pitch * DEG) })
  const VIEWS = { iso: { yaw: 35, pitch: 24, label: 'Helix' }, top: { yaw: 0, pitch: 89, label: 'Top: phase dial' }, side: { yaw: 0, pitch: 0, label: 'Side: time' } } as const
  type V = keyof typeof VIEWS
  const fly = (to: V) => {
    cancelAnimationFrame(anim)
    orbit = false
    orbitBtn.classList.remove('on')
    const a = angles(), b = VIEWS[to], d = dist()
    let dy = b.yaw - a.yaw
    while (dy > 180) dy -= 360
    while (dy < -180) dy += 360
    const t0 = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 800)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      setCam(a.yaw + dy * e, a.pitch + (b.pitch - a.pitch) * e, d)
      if (k < 1) anim = requestAnimationFrame(step)
    }
    anim = requestAnimationFrame(step)
    view.set(to)
  }
  const view = segmented<V>((Object.keys(VIEWS) as V[]).map((k) => [k, VIEWS[k].label]), 'iso', fly)
  const orbitBtn = button('Orbit', () => {
    orbit = !orbit
    orbitBtn.classList.toggle('on', orbit)
    if (!orbit) return
    const d = dist()
    const spin = () => { if (!orbit) return; const a = angles(); setCam(a.yaw + 0.3, a.pitch, d); anim = requestAnimationFrame(spin) }
    anim = requestAnimationFrame(spin)
  })
  const metricSeg = segmented<Metric>([['none', 'none'], ['heap', 'heap'], ['p99', 'ctrl p99'], ['die', 'die temp']], metric, (m) => { metric = m; rebuild() })
  const verdict = el('span', 'note')
  verdict.innerHTML = `${glyph(top.pv < 0.05 ? 'crit' : 'ok')} <b>${top.k} of ${n}</b> failures in <b>${esc(top.p.phase)}</b>, ${(top.share * 100).toFixed(1)}% of the cycle: p = ${top.pv < 0.001 ? top.pv.toExponential(1) : top.pv.toFixed(4)}${sameDut < top.k ? ` (only ${sameDut} distinct DUTs: events are not independent)` : ''}`
  bar.append(el('span', 'note', 'View'), view.el, orbitBtn, el('span', 'sep'), el('span', 'note', 'Radius'), metricSeg.el, el('span', 'sep'), verdict)
  setTimeout(() => fly('iso'), 50)

  return () => {
    orbit = false
    cancelAnimationFrame(anim)
    dash.dispose()
  }
}

