import { sferic, PointShape, DashedLine, StipplePatterns } from 'sferic'
import type { PointLineAreaSeries } from 'sferic/xy/series/PointLineAreaSeries'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { AnatomyChart } from '../charts/AnatomyChart'
import { PhaseFolder, PhaseEye, PeriodRaster, type FoldLane } from '../charts/PhaseFold'
import { targetSim, AP, IRQS, LANES, ST_IRQ0, ST_MISS, ST_READY, THREADS, TH, CTRL_BUDGET_US, IDLE, type Cause, type Job } from '../sim/target'
import { intervalsIn } from '../sim/query'
import { quantile } from '../sim/rng'
import { level } from '../thresholds'
import { anatomyRow } from './anatomy'
import { go } from '../nav'
import { button, el, segmented } from '../dom'
import { fill, irqColor, threadColor, type View } from './common'

const CAUSES: { id: Cause; label: string; shape: (typeof PointShape)[keyof typeof PointShape] }[] = [
  { id: 'clean', label: 'no significant delay', shape: PointShape.Circle },
  { id: 'preempt', label: 'preempted by a higher-priority thread', shape: PointShape.Circle },
  { id: 'isr', label: 'ISR time', shape: PointShape.Diamond },
  { id: 'coop', label: 'cooperative work item', shape: PointShape.Triangle },
  { id: 'blocked', label: 'lock wait, holder running', shape: PointShape.Square },
  { id: 'inversion', label: 'priority inversion', shape: PointShape.Square },
]
const BINS = 250

/**
 * Timing: is the schedule stable, and when it is not, why. Phase folding shows
 * the shape of a period at a glance; the constellation separates jobs by
 * start latency and response, colored by what delayed them; the anatomy list
 * takes the worst ones apart. Every mark leads to the Trace at that moment.
 */
export const engineeringTiming: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const [bad, mid] = t.examples.badGoodColorPalette
  const root = el('div', 'vstack')
  const bar = el('div', 'toolbar')
  const host = el('div', 'fill')
  root.append(bar, host)
  container.appendChild(root)

  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 2, numberOfRows: 3, splitterThickness: 4 })
  dash.setRowHeight(0, 0.5).setRowHeight(1, 1.45).setRowHeight(2, 1.3)
  dash.setColumnWidth(0, 1.1).setColumnWidth(1, 1)
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 2 })
  const eye = dash.createPanel(PhaseEye, { columnIndex: 0, rowIndex: 1 }).setTitleFont((f) => f.setSize(13))
  const raster = dash.createPanel(PeriodRaster, { columnIndex: 1, rowIndex: 1, columns: 600 }).setTitleFont((f) => f.setSize(13))
  const cons = dash.createChartXY({ columnIndex: 0, rowIndex: 2, legend: { visible: true, position: 'right' } })
    .setTitle('ctrl_loop jobs: start latency vs response, by cause of delay (last 4000)')
    .setTitleFont((f) => f.setSize(13))
  const anat = dash.createPanel(AnatomyChart, { columnIndex: 1, rowIndex: 2 })
    .setTitle('Worst ctrl_loop jobs, last 10 s (click one to open it in Trace)')
    .setTitleFont((f) => f.setSize(13))
  anat.setBudget(CTRL_BUDGET_US)

  // ---------------------------------------------------------------- folding
  const foldLanes: FoldLane[] = [
    ...IRQS.map((n, k) => ({ name: `ISR ${n}`, color: irqColor(t, k) })),
    ...THREADS.slice(0, IDLE).map((d, i) => ({ name: d.name, color: threadColor(t, i).setA(255) })),
  ]
  const lastExpiry = () => {
    const E = sim.events
    for (let id = E.total - 1; id >= E.oldest && id > E.total - 20000; id--) {
      const k = id & (E.cap - 1)
      if (E.api[k] === AP.EXPIRY) return E.t[k] * 1000
    }
    return sim.now
  }
  type FoldMode = 'ctrl' | 'spi' | 'two'
  let mode: FoldMode = 'ctrl'
  const periodOf = (m: FoldMode) => (m === 'ctrl' ? sim.period : m === 'spi' ? 500 : 2000)
  const folder = new PhaseFolder(foldLanes.length, BINS, periodOf(mode), lastExpiry())
  let awaitEpoch = false
  const feed = (lane: number, a: number, b: number, st: number) => {
    if (awaitEpoch || a === b) return
    if ((st < ST_READY && st !== IDLE) || (st >= ST_IRQ0 && st < ST_MISS)) folder.add(lane, a * 1000, b * 1000)
  }
  eye.setFolder(folder, foldLanes)
  raster.setFolder(folder, foldLanes)
  const prime = () => {
    const now = sim.now / 1000
    intervalsIn(sim.ilog, now - 2500, now, feed)
  }
  prime()
  const offInt = sim.onInterval(feed)
  const offEv = sim.onEvent((E, id) => {
    const k = id & (E.cap - 1)
    if (awaitEpoch && E.api[k] === AP.EXPIRY) {
      awaitEpoch = false
      folder.reset(periodOf(mode), E.t[k] * 1000)
      raster.clear()
    }
  })
  const refold = () => {
    folder.reset(periodOf(mode), lastExpiry())
    raster.clear()
    prime()
    setMarkers()
    titles()
  }
  const offParam = sim.onParam((q) => {
    if (q.id === 'ctrl.period_us' && q.state === 'applied' && mode === 'ctrl') {
      folder.reset(periodOf(mode), NaN)
      awaitEpoch = true
      setMarkers()
      titles()
    }
  })
  const titles = () => {
    const p = periodOf(mode)
    eye.setTitle(`Scheduling eye: share of ${p} us periods each lane ran at each phase${folder.baseline ? ' (ghost line: baseline)' : ''}`)
    raster.setTitle(`Period raster: one column per period, phase down, colored by the lane that ran`)
  }
  let p99Phase = NaN
  const setMarkers = () => {
    const ms = [{ phase: 0.5, label: 'release', color: t.examples.highlightColor }]
    if (mode === 'ctrl' && sim.period >= CTRL_BUDGET_US) ms.push({ phase: CTRL_BUDGET_US, label: 'deadline', color: bad })
    if (mode === 'ctrl' && p99Phase === p99Phase) ms.push({ phase: p99Phase, label: 'ctrl_loop p99 done', color: mid })
    eye.setMarkers(ms)
    raster.setMarkers(ms)
  }
  setMarkers()
  titles()
  raster.addEventListener('periodclick', (e: { tUs: number }) => go('trace', { t: e.tUs / 1000, label: 'from the period raster' }))

  // ---------------------------------------------------------------- constellation
  cons.axisX.setTitle('Start latency (release to first run)').setUnits('us').setDefaultInterval({ start: 0, end: 700 })
  cons.axisY.setTitle('Response').setUnits('us').setDefaultInterval({ start: 0, end: 900 })
  cons.axisY.addConstantLine(true).setValue(CTRL_BUDGET_US).setStrokeStyle(new DashedLine({ thickness: 1.5, fillStyle: fill(bad), pattern: StipplePatterns.Dashed }))
  const causeColor = (c: Cause) => {
    // Own colors per cause (shapes repeat the distinction for color-blind readers).
    const sc = t.seriesColors
    switch (c) {
      case 'clean': return t.tickLabelColor.setA(110)
      case 'preempt': return sc[0]
      case 'isr': return sc[5 % sc.length]
      case 'coop': return sc[7 % sc.length]
      case 'blocked': return mid
      case 'inversion': return bad
    }
  }
  const series = new Map<Cause, PointLineAreaSeries>()
  for (const c of CAUSES) {
    const s = cons.addPointSeries({ pointShape: c.shape }).setName(c.label).setMaxSampleCount(4000)
    s.setPointFillStyle(fill(causeColor(c.id))).setPointSize(c.id === 'clean' ? 3 : 6)
    series.set(c.id, s)
  }
  let pending: Job[] = []
  const pushJobs = (js: Job[]) => {
    const by = new Map<Cause, { x: number[]; y: number[] }>()
    for (const j of js) {
      if (j.thread !== TH.CTRL) continue
      let b = by.get(j.cause)
      if (!b) by.set(j.cause, (b = { x: [], y: [] }))
      b.x.push(j.lat)
      b.y.push(j.resp)
    }
    for (const [c, b] of by) series.get(c)!.appendSamples({ xValues: b.x, yValues: b.y })
  }
  pushJobs(sim.jobs.filter((j) => j.thread === TH.CTRL).slice(-4000))
  const offJob = sim.onJob((j) => { if (j.thread === TH.CTRL) pending.push(j) })

  // ---------------------------------------------------------------- worst jobs + KPIs
  let worst: Job[] = []
  const refreshSlow = () => {
    const now = sim.now / 1000
    const recent: Job[] = []
    for (let i = sim.jobs.length - 1; i >= 0; i--) {
      const j = sim.jobs[i]
      if (j.end < now - 10_000) break
      if (j.thread === TH.CTRL) recent.push(j)
    }
    worst = [...recent].sort((a, b) => b.resp - a.resp).slice(0, 10)
    anat.setRows(worst.map((j) => anatomyRow(t, j)))
    const resp = recent.map((j) => j.resp).sort((a, b) => a - b)
    const lat = recent.map((j) => j.lat).sort((a, b) => a - b)
    const misses = recent.filter((j) => j.miss).length
    const inv = recent.filter((j) => j.inv > 0)
    const worstInv = Math.max(0, ...inv.map((j) => j.inv))
    const worstBlock = Math.max(0, ...recent.map((j) => j.holderRan + j.inv))
    const coop = Math.max(0, ...recent.map((j) => j.pre[TH.SYSWQ]))
    p99Phase = quantile(resp, 0.99)
    setMarkers()
    const p99 = quantile(resp, 0.99)
    const tiles: KpiTile[] = [
      { id: 'per', label: 'Control period', value: String(sim.period), unit: 'us', sub: `${recent.length} jobs in 10 s`, status: 'info', source: 'param ctrl.period_us' },
      { id: 'lat', label: 'Start latency p99', value: quantile(lat, 0.99).toFixed(0), unit: 'us', sub: `max ${lat[lat.length - 1]?.toFixed(0) ?? '-'} us`, status: 'ok', source: 'jobs' },
      { id: 'p50', label: 'Response p50', value: quantile(resp, 0.5).toFixed(0), unit: 'us', sub: `deadline ${CTRL_BUDGET_US} us`, status: 'ok', source: 'jobs' },
      { id: 'p99', label: 'Response p99', value: p99.toFixed(0), unit: 'us', sub: `max ${resp[resp.length - 1]?.toFixed(0) ?? '-'} us`, status: level('span.ctrl_loop.p99_pct', (p99 / CTRL_BUDGET_US) * 100), source: 'jobs' },
      { id: 'miss', label: 'Misses, 10 s', value: String(misses), sub: `${((misses / Math.max(1, recent.length)) * 100).toFixed(2)}% of jobs`, status: level('span.ctrl_loop.miss', misses), source: 'jobs' },
      { id: 'inv', label: 'Inversions, 10 s', value: String(inv.length), sub: `worst ${worstInv.toFixed(0)} us`, status: level('sched.ctrl_loop.inversion_us', worstInv), source: 'trace + jobs' },
      { id: 'blk', label: 'Worst lock wait', value: worstBlock.toFixed(0), unit: 'us', sub: sim.busIsMutex ? 'bus_mtx (k_mutex)' : 'bus_lock (k_sem)', status: level('sched.ctrl_loop.blocked_us', worstBlock), source: 'trace' },
      { id: 'coop', label: 'Coop work delay', value: coop.toFixed(0), unit: 'us', sub: 'sysworkq ahead of ctrl_loop', status: level('wq.sysworkq.item_us', coop), source: 'trace' },
    ]
    kpi.setTiles(tiles)
  }
  anat.addEventListener('rowclick', (e: { id: number }) => {
    const j = worst.find((x) => x.id === e.id)
    if (j) go('trace', { t: j.release, job: j.id, label: 'from Timing' })
  })
  kpi.addEventListener('tileclick', (e: { id: string }) => { if (e.id === 'inv' || e.id === 'miss') go('trace') })
  refreshSlow()

  let raf = 0, n = 0
  const frame = () => {
    if (pending.length) { pushJobs(pending); pending = [] }
    eye.refresh()
    raster.requestRender()
    if (++n % 30 === 0) refreshSlow()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  // ---------------------------------------------------------------- toolbar
  const foldSeg = segmented<FoldMode>([['ctrl', 'ctrl period'], ['spi', 'SPI DMA 500 us'], ['two', '2 ms']], mode, (m) => { mode = m; refold() })
  const decim = segmented<'1' | '10'>([['1', 'every period'], ['10', '1 in 10']], '1', (v) => { raster.setDecimation(Number(v)); raster.clear() })
  const baseBtn = button('Set baseline', () => { folder.setBaseline(); titles(); baseNote.innerHTML = 'baseline <b>set</b>: change something in Watch &amp; Tune and compare' })
  const baseNote = el('span', 'note', 'baseline: none')
  bar.append(
    el('span', 'note', 'Fold on'), foldSeg.el, el('span', 'sep'),
    baseBtn, button('Clear', () => { folder.clearBaseline(); titles(); baseNote.textContent = 'baseline: none' }), baseNote, el('span', 'sep'),
    el('span', 'note', 'Raster'), decim.el,
    el('span', 'grow'),
    el('span', 'note', `lanes: ${LANES.length - 1} (idle omitted) &middot; ${BINS} phase bins &middot; click the raster or a job to open the Trace`),
  )

  return () => {
    cancelAnimationFrame(raf)
    offInt(); offEv(); offParam(); offJob()
    dash.dispose()
  }
}

