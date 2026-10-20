import {
  sferic, AxisTickStrategies, AxisScrollStrategies, ColorRGBA, DashedLine, StipplePatterns, LUT, PalettedFill, UIOrigins,
  type CellContent,
} from 'sferic'
import { addIntervalSeries } from '../charts/IntervalSeries'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { BulletChart, type BulletRow } from '../charts/BulletChart'
import { level, liveRule, usedLimits } from '../thresholds'
import { targetSim, THREADS, IRQS, LANES, IDLE, CTRL_BUDGET_US, LINK_BUDGET_BPS, type Heartbeat } from '../sim/target'
import { quantile } from '../sim/rng'
import { bytesRate, durMs, hms, kib, rate } from '../format'
import { fill, irqColor, line, threadColor, type View } from './common'

const TIMELINE_MS = 200
const HISTORY_MS = 30_000
/** Stacking order for the CPU chart, bottom to top: ISR first, then threads by load. */
const STACK = [3, 2, 4, 5, 0, 1, 6, 7]

export const engineeringLive: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const dash = sferic().Dashboard({ container, theme: t, numberOfColumns: 4, numberOfRows: 4, splitterThickness: 4 })
  dash.setRowHeight(0, 0.62).setRowHeight(1, 1.75).setRowHeight(2, 1.15).setRowHeight(3, 1.3)
  dash.setColumnWidth(0, 1).setColumnWidth(1, 1).setColumnWidth(2, 1.05).setColumnWidth(3, 1.05)

  // ---------------------------------------------------------------- KPI strip
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 4 })

  // ---------------------------------------------------------------- scheduler timeline (new IntervalSeries)
  // State order must match the ST_* ids in sim/target.ts: running per thread, ready, ISR per IRQ, miss, overrun, blocked.
  const baseTitle = `Scheduler timeline: threads and ISRs, live ${TIMELINE_MS} ms window`
  const tl = dash
    .createChartXY({ columnIndex: 0, rowIndex: 1, columnSpan: 4, legend: { visible: false } })
    .setTitle(baseTitle)
    .setTitleFont((f) => f.setSize(13))
  tl.axisX
    .setTickStrategy(AxisTickStrategies.Time)
    .setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - TIMELINE_MS, stopAxisAfter: false }))
  const [bad, mid] = t.examples.badGoodColorPalette
  const states = [
    ...THREADS.map((th, i) => ({ name: i === IDLE ? 'idle' : 'running', color: threadColor(t, i) })),
    { name: 'ready (waiting for CPU)', color: t.isDark ? ColorRGBA(170, 185, 215, 150) : ColorRGBA(90, 100, 125, 150), height: 0.26 },
    ...IRQS.map((n, k) => ({ name: `ISR ${n}`, color: irqColor(t, k) })),
    { name: `deadline miss (> ${CTRL_BUDGET_US} us)`, color: bad },
    { name: 'activation overrun', color: mid },
    { name: 'blocked on a lock', color: bad.setA(120), height: 0.5 },
  ]
  const gantt = addIntervalSeries(tl, { lanes: LANES, states, retention: 12_000, formatDuration: durMs })
  gantt.setupLaneAxis()
  tl.axisY.setThickness(92)
  // While paused nothing enters the series, so nothing scrolls or gets evicted; the target's
  // retained log (and later the bridge recording) is the catch-up source on resume.
  let paused = false
  const append = (lane: number, a: number, b: number, st: number) => { if (!paused) gantt.append(lane, a, b, st) }
  sim.replay(append)
  const offInterval = sim.onInterval(append)

  // ---------------------------------------------------------------- CPU by thread, stacked areas
  const cpu = dash
    .createChartXY({ columnIndex: 0, rowIndex: 2, columnSpan: 2, legend: { visible: true, position: 'right' } })
    .setTitle('CPU by thread (heartbeat, ISR time from trace)')
    .setTitleFont((f) => f.setSize(13))
  cpu.axisX
    .setTickStrategy(AxisTickStrategies.Time)
    .setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - HISTORY_MS, stopAxisAfter: false }))
  cpu.axisY.setTitle('CPU').setUnits('%').setDefaultInterval({ start: 0, end: 70 })
  cpu.axisY.addConstantLine(true).setValue(liveRule('cpu.load')?.warn ?? 70).setStrokeStyle(new DashedLine({ thickness: 1, fillStyle: fill(mid), pattern: StipplePatterns.Dashed }))
  const isrBand = cpu.addAreaRangeSeries().setName('ISR').setMaxSampleCount(800)
  isrBand.setAreaFillStyle(fill(bad.setA(150))).setStrokeStyle(line(bad, 1))
  const bands = STACK.map((ti) => {
    const c = threadColor(t, ti)
    return cpu.addAreaRangeSeries().setName(THREADS[ti].name).setMaxSampleCount(800)
      .setAreaFillStyle(fill(c.setA(120))).setStrokeStyle(line(c, 1))
  })

  // ---------------------------------------------------------------- scheduler activity rates
  const act = dash
    .createChartXY({ columnIndex: 2, rowIndex: 2, legend: { visible: true, position: 'bottom' } })
    .setTitle('Scheduler activity and link')
    .setTitleFont((f) => f.setSize(13))
  act.axisX
    .setTickStrategy(AxisTickStrategies.Time)
    .setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - HISTORY_MS, stopAxisAfter: false }))
  act.axisY.setTitle('Events').setUnits('/s')
  const linkAxis = act.addAxisY({ opposite: true }).setTitle('Link').setUnits('% of RTT')
  const swS = act.addLineSeries({ automaticColorIndex: 2 }).setName('Context switches/s').setMaxSampleCount(800)
  const irqS = act.addLineSeries({ automaticColorIndex: 9 }).setName('IRQs/s').setMaxSampleCount(800)
  const linkS = act.addLineSeries({ axisY: linkAxis, automaticColorIndex: 6 }).setName('Link util').setMaxSampleCount(800)
  linkAxis.setDefaultInterval({ start: 0, end: 100 })

  // ---------------------------------------------------------------- ctrl_loop response histogram (span)
  const hist = dash
    .createChartXY({ columnIndex: 3, rowIndex: 2, legend: { visible: false } })
    .setTitle('ctrl_loop response, last 10 s (span)')
    .setTitleFont((f) => f.setSize(13))
  hist.axisX.setTitle('Activation to completion').setUnits('us').setDefaultInterval({ start: 0, end: 700 })
  hist.axisY.setTitle('Count')
  const bars = hist.addRectangleSeries({ automaticColorIndex: 2 }).setName('ctrl_loop')
  bars.setStrokeStyle(line(t.isDark ? ColorRGBA(0, 0, 0, 160) : ColorRGBA(255, 255, 255, 200), 1))
  hist.axisX.addConstantLine(true).setValue(CTRL_BUDGET_US).setStrokeStyle(line(bad, 2))
  const p99Line = hist.axisX.addConstantLine(true).setValue(0).setStrokeStyle(new DashedLine({ thickness: 1.5, fillStyle: fill(mid), pattern: StipplePatterns.Dashed }))
  const BIN = 20
  const refreshHist = () => {
    const v = sim.respHistory
    const counts = new Array(Math.ceil(700 / BIN)).fill(0)
    for (const x of v) counts[Math.min(counts.length - 1, Math.floor(x / BIN))]++
    bars.clear()
    counts.forEach((c, i) => {
      if (!c) return
      const f = bars.add({ x1: i * BIN, y1: 0, x2: (i + 1) * BIN, y2: c })
      if ((i + 1) * BIN > CTRL_BUDGET_US) f.setFillStyle(fill(bad))
    })
    const s = [...v].sort((a, b) => a - b)
    p99Line.setValue(quantile(s, 0.99) || 0)
  }

  // ---------------------------------------------------------------- thread table
  const grid = dash.createDataGrid({ columnIndex: 0, rowIndex: 3, columnSpan: 2 }).setTitle('Threads').setTitleFont((f) => f.setSize(13))
  const head = ['Thread', 'Prio', 'State', 'CPU %', 'Run avg / peak', 'Wake p99', 'Switches/s', 'Stack used / size', 'Watermark']
  // Watermark column colors follow the stack margin rule (margin 25% -> 75% used).
  const okTint = t.isDark ? ColorRGBA(60, 170, 100, 40) : ColorRGBA(40, 160, 90, 30)
  const wm = usedLimits('stack.x.margin', 100)
  const marginLut = new LUT({
    interpolate: true,
    steps: [
      { value: 0, color: okTint },
      { value: (wm.warn ?? 75) - 0.5, color: okTint },
      { value: wm.warn ?? 75, color: mid.setA(170) },
      { value: wm.crit ?? 90, color: bad.setA(210) },
      { value: 100, color: bad.setA(210) },
    ],
  })
  grid.setTableContent([head, ...THREADS.map((th) => [th.name, String(th.prio), '', '', '', '', '', '', ''])])
  grid.setColumnBackgroundFillStyle(8, new PalettedFill({ lut: marginLut }))
  grid.setColumnWidth(0, { min: 86 }).setCellChangeHighlight(false)
  THREADS.forEach((_, i) => grid.setCellTextFillStyle(0, i + 1, threadColor(t, i).setA(255)))

  // ---------------------------------------------------------------- stack headroom (new BulletChart)
  const stacks = dash.createPanel(BulletChart, { columnIndex: 2, rowIndex: 3 }).setTitle('Stack headroom (bar = now, tick = watermark)').setTitleFont((f) => f.setSize(13))
  // ---------------------------------------------------------------- memory and queues
  const mem = dash.createPanel(BulletChart, { columnIndex: 3, rowIndex: 3 }).setTitle('Memory, queues and link buffers').setTitleFont((f) => f.setSize(13))

  // ---------------------------------------------------------------- feed
  const cpuHist: number[] = [], p99Hist: number[] = [], linkHist: number[] = []
  let n = 0
  let lastSeq = -1, lastT = 0, pauseNote = ''
  const onHb = (h: Heartbeat, backfill = false) => {
    if (paused && !backfill) {
      tl.setTitle(`${baseTitle}: PAUSED${pauseNote} at ${hms(lastT)}, live is ${((h.t - lastT) / 1000).toFixed(1)} s ahead, recording continues`)
      return
    }
    lastSeq = h.seq
    lastT = h.t
    const x = [h.t]
    // Stacked bands: each band spans [sum of those below, that + own share].
    let acc = h.isrPct
    isrBand.appendSamples({ xValues: x, yValues: [acc], lowValues: [0] })
    STACK.forEach((ti, k) => {
      const lo = acc
      acc += h.threads[ti].cpuPct
      bands[k].appendSamples({ xValues: x, yValues: [acc], lowValues: [lo] })
    })
    swS.appendSamples({ xValues: x, yValues: [h.ctxPerS] })
    irqS.appendSamples({ xValues: x, yValues: [h.irqPerS] })
    const util = (h.linkBps / LINK_BUDGET_BPS) * 100
    linkS.appendSamples({ xValues: x, yValues: [util] })
    cpuHist.push(h.cpuPct); p99Hist.push(h.ctrl.p99); linkHist.push(util)
    for (const a of [cpuHist, p99Hist, linkHist]) if (a.length > 120) a.shift()
    if (backfill) return
    if (n++ % 2) return
    // Slower panels at 5 Hz.
    updateKpi(h, util)
    updateTables(h)
    if (n % 5 === 1) refreshHist()
  }

  const updateKpi = (h: Heartbeat, util: number) => {
    const worst = h.threads.filter((_, i) => i !== IDLE).map((s) => ({ name: s.name, m: (1 - s.stackHwm / s.stackSize) * 100 })).sort((a, b) => a.m - b.m)[0]
    const lostPct = h.framesTotal ? (h.framesLost / h.framesTotal) * 100 : 0
    const worse = (a: KpiTile['status'], b: KpiTile['status']) => (a === 'crit' || b === 'crit' ? 'crit' : a === 'warn' || b === 'warn' ? 'warn' : a)
    const tiles: KpiTile[] = [
      { id: 'cpu', label: 'CPU load', value: h.cpuPct.toFixed(1), unit: '%', sub: `ISR ${h.isrPct.toFixed(1)}%  idle ${(100 - h.cpuPct).toFixed(1)}%`, status: level('cpu.load', h.cpuPct), spark: [...cpuHist], source: 'stats + trace' },
      { id: 'isr', label: 'Interrupts', value: rate(h.irqPerS), unit: '/s', sub: `${h.isrPct.toFixed(2)}% CPU in ISRs`, status: 'ok', source: 'trace' },
      { id: 'ctx', label: 'Context switches', value: rate(h.ctxPerS), unit: '/s', sub: 'all CPUs', status: 'ok', source: 'trace' },
      { id: 'p99', label: 'ctrl_loop p99', value: h.ctrl.p99.toFixed(0), unit: 'us', sub: `budget ${CTRL_BUDGET_US} us  max ${h.ctrl.max.toFixed(0)}`, status: level('span.ctrl_loop.p99_pct', (h.ctrl.p99 / CTRL_BUDGET_US) * 100), spark: [...p99Hist], source: 'span' },
      { id: 'miss', label: 'Deadline misses', value: String(h.ctrl.misses), sub: `${h.ctrl.overruns} activation overruns`, status: worse(level('span.ctrl_loop.miss', h.ctrl.misses), level('span.ctrl_loop.overrun', h.ctrl.overruns)), source: 'span' },
      { id: 'stack', label: 'Min stack margin', value: worst.m.toFixed(0), unit: '%', sub: worst.name, status: level(`stack.${worst.name}.margin`, worst.m), source: 'stats (watermark)' },
      { id: 'heap', label: 'Heap', value: kib(h.heap.alloc), unit: `/ ${kib(h.heap.size, 0)} KiB`, sub: `peak ${kib(h.heap.maxAlloc)} KiB`, status: level('heap._system_heap.peak_pct', h.heap.maxAlloc / h.heap.size * 100), source: 'stats' },
      { id: 'link', label: 'Telemetry link', value: bytesRate(h.linkBps), sub: `${util.toFixed(0)}% of RTT  lost ${h.framesLost}`, status: worse(level('link.util', util), level('link.lost_pct', lostPct)), spark: [...linkHist], source: 'bridge' },
      { id: 'self', label: 'Agent self-cost', value: h.selfPct.toFixed(2), unit: '%', sub: 'zprof heartbeat at 10 Hz', status: level('agent.self', h.selfPct), source: 'stats' },
      { id: 'up', label: 'Uptime', value: hms(h.uptimeMs), sub: `boot #${h.bootCount}  reset: SOFTWARE`, status: 'info', source: 'hello + hwinfo' },
    ]
    kpi.setTiles(tiles)
  }

  const updateTables = (h: Heartbeat) => {
    h.threads.forEach((s, i) => {
      const row = i + 1
      const used = s.stackHwm / s.stackSize * 100
      const cells: CellContent[] = [
        s.name, String(s.prio), s.state,
        { value: s.cpuPct, text: s.cpuPct.toFixed(1), bar: s.cpuPct, barMin: 0, barMax: i === IDLE ? 100 : 30, barColor: threadColor(t, i).setA(255) },
        i === IDLE ? '' : `${s.runAvgUs.toFixed(0)} / ${s.runPeakUs.toFixed(0)} us`,
        i === IDLE || !s.wakeP99Us ? '' : `${s.wakeP99Us.toFixed(0)} us`,
        s.switchesPerS.toFixed(0),
        `${s.stackUsed} / ${s.stackSize}`,
        { value: used, text: `${used.toFixed(0)}%` },
      ]
      cells.forEach((c, col) => { if (col > 0) grid.setCellContent(col, row, c) })
    })
    // Bullet zones come from the thresholds file, converted to "used" units.
    const rows: BulletRow[] = h.threads.filter((_, i) => i !== IDLE).map((s) => ({
      name: s.name, value: s.stackUsed, peak: s.stackHwm, max: s.stackSize, ...usedLimits(`stack.${s.name}.margin`, s.stackSize),
    }))
    rows.push({ name: 'ISR stack', value: 910, peak: 1104, max: 2048, ...usedLimits('stack.isr0.margin', 2048) })
    stacks.setRows(rows)
    mem.setRows([
      { group: 'Heaps and slabs', name: '_system_heap', value: h.heap.alloc, peak: h.heap.maxAlloc, max: h.heap.size, ...usedLimits('heap._system_heap.peak_pct', h.heap.size) },
      { name: 'net_buf_rx (blocks)', value: h.slab.used, peak: h.slab.maxUsed, max: h.slab.blocks, ...usedLimits('slab.net_buf_rx.peak_pct', h.slab.blocks), text: `${h.slab.maxUsed} / ${h.slab.blocks}` },
      { group: 'Queues', name: 'rx_fifo (k_fifo)', value: h.msgq.used, peak: h.msgq.peak, max: h.msgq.max, ...usedLimits('fifo.rx_fifo.peak_pct', h.msgq.max), text: `${h.msgq.peak} / ${h.msgq.max}` },
      { name: 'sample_q (k_msgq)', value: h.sampleQ.used, peak: h.sampleQ.peak, max: h.sampleQ.max, ...usedLimits('msgq.sample_q.peak_pct', h.sampleQ.max), text: `${h.sampleQ.peak} / ${h.sampleQ.max}` },
      { name: 'log buffer', value: h.logBuf.used, peak: h.logBuf.peak, max: h.logBuf.size, ...usedLimits('log.buf.peak_pct', h.logBuf.size) },
      { group: 'Telemetry', name: 'RTT up-buffer 1', value: h.rttUp.used, peak: h.rttUp.peak, max: h.rttUp.size, ...usedLimits('trace.buf.peak_pct', h.rttUp.size) },
    ])
  }

  // Backfill history so the charts are populated on first paint.
  for (const h of sim.heartbeats) onHb(h, true)
  const last = sim.heartbeats[sim.heartbeats.length - 1]
  if (last) { updateKpi(last, (last.linkBps / LINK_BUDGET_BPS) * 100); updateTables(last); refreshHist() }
  const offHb = sim.onHeartbeat((h) => onHb(h))

  // ---------------------------------------------------------------- pause / resume (spec section 6)
  // Pause freezes every live panel; the target keeps running. Zoom or pan on any live chart
  // also pauses. The button, Space, or a double-click on a chart resumes and catches up.
  const liveAxes = [tl.axisX, cpu.axisX, act.axisX]
  const btn = tl.addUIElement('button').setText('Pause  (Space)').setPosition({ x: 99.7, y: 99 }).setOrigin(UIOrigins.RightTop)
  const pause = (byInteraction: boolean) => {
    if (paused) return
    paused = true
    pauseNote = byInteraction ? ' by zoom/pan' : ''
    // Hold every live X axis at its current interval (the zoomed one is already stopped).
    for (const a of liveAxes) if (!a.stopped) { const { start, end } = a.getInterval(); a.setInterval({ start, end, stopAxisAfter: true }) }
    btn.setText('Resume  (Space)')
      .setBackground((b) => b.setFillStyle(fill(mid.setA(230))))
      .setTextFillStyle(fill(ColorRGBA(12, 14, 22, 255)))
    tl.setTitle(`${baseTitle}: PAUSED${pauseNote} at ${hms(lastT)}, recording continues`)
  }
  const resume = () => {
    if (!paused) return
    paused = false
    // Catch up from the retained log and the heartbeats that arrived while paused.
    gantt.clear()
    sim.replay(append)
    gantt.commit()
    for (const h of sim.heartbeats) if (h.seq > lastSeq) onHb(h, true)
    for (const a of liveAxes) a.setScrollStrategy(AxisScrollStrategies.scrolling)
    tl.axisY.setInterval({ start: 0, end: gantt.laneCount, stopAxisAfter: true })
    btn.setText('Pause  (Space)').setBackground((b) => b.setFillStyle(fill(t.uiFill))).setTextFillStyle(fill(t.uiText))
    tl.setTitle(baseTitle)
    const h = sim.heartbeats[sim.heartbeats.length - 1]
    if (h) { updateKpi(h, (h.linkBps / LINK_BUDGET_BPS) * 100); updateTables(h); refreshHist() }
  }
  btn.onMouseClick(() => (paused ? resume() : pause(false)))
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null
    if (e.code !== 'Space' || e.repeat || (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable))) return
    e.preventDefault()
    if (paused) resume()
    else pause(false)
  }
  window.addEventListener('keydown', onKey)

  // One render request per animation frame for the streaming timeline; also watches for
  // zoom/pan (an axis stopped by the user) and double-click (an axis released by fit()).
  let raf = 0
  const frame = () => {
    if (!paused && liveAxes.some((a) => a.stopped)) pause(true)
    else if (paused && liveAxes.some((a) => !a.stopped)) resume()
    if (!paused) gantt.commit()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('keydown', onKey)
    offInterval()
    offHb()
    dash.dispose()
  }
}
