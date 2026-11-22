import { sferic, AxisTickStrategies, AxisScrollStrategies, ColorRGBA, type CellContent, type Theme } from 'sferic'
import { addIntervalSeries, type IntervalState } from '../charts/IntervalSeries'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { level } from '../thresholds'
import { durMs, rate } from '../format'
import { liveLink, CODE, type IntervalBatch, type LiveHello, type LiveStats, type LiveStatus } from '../live/link'
import { fill, irqColor, line, threadColor, type View } from './common'

const TIMELINE_MS = 200
const HISTORY_S = 60

/**
 * Live target: the real board through the zprof bridge. KPI strip, scheduler
 * timeline (interrupts, then threads by priority; thin bars are a thread
 * ready and waiting for the CPU, red marks are records the target dropped),
 * CPU by thread per second, and the thread and interrupt tables. Rebuilt on
 * every hello: a thread or interrupt that appears adds a lane.
 */
export const liveTarget: View = ({ container, theme: t }) => {
  const link = liveLink()
  const note = document.createElement('div')
  note.className = 'live-note'
  note.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'text-align:center;padding:24px;font:14px/1.6 system-ui,sans-serif;opacity:.85;white-space:pre-line'
  container.appendChild(note)
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;inset:0'
  container.appendChild(host)

  let built: Built | null = null
  const rebuild = (h: LiveHello) => {
    built?.dispose()
    note.hidden = true
    built = build(host, t, h)
    link.replay((b) => built!.batch(b))
    for (const s of link.stats.slice(-HISTORY_S)) built.stats(s, true)
    const last = link.stats[link.stats.length - 1]
    if (last) built.stats(last)
    if (link.status) built.status(link.status)
  }
  const showState = () => {
    if (link.state === 'open' && link.hello) return
    built?.dispose()
    built = null
    note.hidden = false
    note.textContent = link.state === 'waiting'
      ? 'The bridge is up and waiting for the target.'
      : `No zprof bridge at ${link.url} (${link.state}).\n\nStart one on this machine:\n` +
        'cd host\\bridge\n..\\..\\.venv\\Scripts\\python.exe -m zprof_bridge serve --host <board> --elf <build>\\zephyr\\zephyr.elf\n' +
        'or replay a recording: ... serve --replay ..\\..\\captures\\x.zpr --loop'
  }
  if (link.hello && link.state === 'open') rebuild(link.hello)
  else showState()

  const offs = [
    link.onHello(rebuild),
    link.onState(showState),
    link.onBatch((b) => built?.batch(b)),
    link.onStats((s) => built?.stats(s)),
    link.onStatus((s) => built?.status(s)),
  ]
  let raf = 0
  const frame = () => { built?.frame(); raf = requestAnimationFrame(frame) }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    for (const off of offs) off()
    built?.dispose()
  }
}

interface Built {
  batch(b: IntervalBatch): void
  stats(s: LiveStats, backfill?: boolean): void
  status(s: LiveStatus): void
  frame(): void
  dispose(): void
}

function build(host: HTMLElement, t: Theme, h: LiveHello): Built {
  const [bad] = t.examples.badGoodColorPalette
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 4, numberOfRows: 3, splitterThickness: 4 })
  dash.setRowHeight(0, 0.62).setRowHeight(1, 2.0).setRowHeight(2, 1.5)
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 4 })

  // ---------------------------------------------------------------- timeline
  const L = h.lanes.length
  // The distinct colors go to the threads that use the CPU most (the bridge's share over
  // its retained window); the rest share a dim one, idle included.
  const ranked = h.lanes.map((ln, i) => ({ ln, i })).filter((x) => x.ln.kind === 'thread' && !x.ln.idle)
    .sort((a, b) => (b.ln.cpu_pct ?? 0) - (a.ln.cpu_pct ?? 0))
  const rankOf = new Map(ranked.map((x, r) => [x.i, r]))
  let ii = 0
  const laneColor = h.lanes.map((ln, i) => (ln.kind === 'irq' ? irqColor(t, ii++ % 3) : threadColor(t, ln.idle ? 99 : rankOf.get(i) ?? 99)))
  const states: IntervalState[] = [
    ...h.lanes.map((ln, i) => ({ name: ln.kind === 'irq' ? 'in the interrupt' : ln.idle ? 'idle' : 'running', color: laneColor[i] })),
    { name: 'ready, waiting for the CPU', color: t.isDark ? ColorRGBA(170, 185, 215, 150) : ColorRGBA(90, 100, 125, 150), height: 0.26 },
    { name: 'records dropped by the target', color: bad },
  ]
  const READY_ST = L, DROP_ST = L + 1
  const title = `Scheduler timeline, live ${TIMELINE_MS} ms window: ${h.source === 'replay' ? 'replay of ' : ''}${h.target}`
  const tl = dash.createChartXY({ columnIndex: 0, rowIndex: 1, columnSpan: 4, legend: { visible: false } })
    .setTitle(title).setTitleFont((f) => f.setSize(13))
  tl.axisX
    .setTickStrategy(AxisTickStrategies.Time)
    .setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - TIMELINE_MS, stopAxisAfter: false }))
  const laneNames = h.lanes.map((ln) => (ln.kind === 'irq' ? `ISR ${ln.name}` : `${ln.name}${ln.prio !== null ? ` ${ln.prio}` : ''}`))
  const gantt = addIntervalSeries(tl, { lanes: laneNames, states, retention: h.retain_ms, formatDuration: durMs })
  gantt.setupLaneAxis()
  tl.axisY.setThickness(132)

  const batch = (b: IntervalBatch) => {
    for (let i = 0; i < b.n; i++) {
      const ln = b.lane[i], c = b.code[i]
      if (ln >= L) continue
      if (c === CODE.DROP) gantt.mark(ln, b.t0[i], DROP_ST)
      else gantt.append(ln, b.t0[i], b.t1[i], c === CODE.READY ? READY_ST : ln)
    }
  }

  // ---------------------------------------------------------------- CPU by thread
  const cpu = dash.createChartXY({ columnIndex: 0, rowIndex: 2, columnSpan: 2, legend: { visible: true, position: 'right' } })
    .setTitle('CPU by thread, per second (interrupts at the bottom)').setTitleFont((f) => f.setSize(13))
  cpu.axisX.setTickStrategy(AxisTickStrategies.Time).setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - HISTORY_S * 1000, stopAxisAfter: false }))
  cpu.axisY.setTitle('CPU').setUnits('%').setDefaultInterval({ start: 0, end: 100 })
  const isrBand = cpu.addAreaRangeSeries().setName('interrupts').setMaxSampleCount(600)
  isrBand.setAreaFillStyle(fill(bad.setA(150))).setStrokeStyle(line(bad, 1))
  // One band for each of the 8 threads with the most CPU, one for all the others.
  const TOP = 8
  const bandOf = new Map<number, ReturnType<typeof cpu.addAreaRangeSeries>>()
  const threadLanes = ranked.slice(0, TOP)
  for (const { ln, i } of threadLanes) {
    const c = laneColor[i]
    bandOf.set(i, cpu.addAreaRangeSeries().setName(ln.name).setMaxSampleCount(600)
      .setAreaFillStyle(fill(c.setA(120))).setStrokeStyle(line(c, 1)))
  }
  const otherC = threadColor(t, 99)
  const otherBand = cpu.addAreaRangeSeries().setName('other threads').setMaxSampleCount(600)
    .setAreaFillStyle(fill(otherC.setA(90))).setStrokeStyle(line(otherC, 1))
  const topNames = new Set(threadLanes.map((x) => x.ln.name))
  const colorByName = new Map(h.lanes.map((ln, i) => [ln.name, laneColor[i]]))

  // ---------------------------------------------------------------- tables
  const tgrid = dash.createDataGrid({ columnIndex: 2, rowIndex: 2 }).setTitle('Threads, last second').setTitleFont((f) => f.setSize(13))
  tgrid.setCellChangeHighlight(false)
  const igrid = dash.createDataGrid({ columnIndex: 3, rowIndex: 2 }).setTitle('Interrupts, last second').setTitleFont((f) => f.setSize(13))
  igrid.setCellChangeHighlight(false)
  const us = (x: number | null) => (x === null ? '' : x < 10 ? x.toFixed(1) : x.toFixed(0))

  // ---------------------------------------------------------------- statistics
  const busyHist: number[] = [], evHist: number[] = []
  const stats = (s: LiveStats, backfill = false) => {
    const x = [s.t_ms]
    let acc = s.isr_pct
    isrBand.appendSamples({ xValues: x, yValues: [acc], lowValues: [0] })
    // By name, not lane: a statistics record made before the last hello numbers the lanes
    // the way they were then (a thread that appears renumbers them).
    const byName = new Map(s.threads.map((r) => [r.name, r]))
    for (const { ln, i } of threadLanes) {
      const r = byName.get(ln.name)
      const lo = acc
      acc += r ? Math.max(0, r.net_pct) : 0
      bandOf.get(i)!.appendSamples({ xValues: x, yValues: [acc], lowValues: [lo] })
    }
    const rest = s.threads.filter((r) => r.name !== 'idle' && !topNames.has(r.name))
      .reduce((a, r) => a + Math.max(0, r.net_pct), 0)
    otherBand.appendSamples({ xValues: x, yValues: [acc + rest], lowValues: [acc] })
    busyHist.push(s.busy_pct); evHist.push(s.events_s)
    for (const a of [busyHist, evHist]) if (a.length > 120) a.shift()
    if (backfill) return

    const sw = s.threads.reduce((a, r) => a + r.switches_s, 0)
    const irqs = s.irqs.reduce((a, r) => a + r.per_s, 0)
    const lostPct = s.dropped ? (100 * s.dropped) / (s.dropped + s.events_s * s.secs) : 0
    const tiles: KpiTile[] = [
      { id: 'busy', label: 'CPU busy', value: s.busy_pct.toFixed(1), unit: '%', sub: `ISR ${s.isr_pct.toFixed(2)}%  in WFI ${s.wfi_pct.toFixed(1)}%`, status: level('cpu.load', s.busy_pct), spark: [...busyHist], source: 'trace' },
      { id: 'ctx', label: 'Context switches', value: rate(sw), unit: '/s', status: 'ok', source: 'trace' },
      { id: 'irq', label: 'Interrupts', value: rate(irqs), unit: '/s', sub: `${s.isr_pct.toFixed(2)}% CPU in ISRs`, status: 'ok', source: 'trace' },
      { id: 'ev', label: 'Trace events', value: rate(s.events_s), unit: '/s', sub: `${s.kbytes_s.toFixed(0)} KB/s on the wire`, status: 'ok', spark: [...evHist], source: 'bridge' },
      { id: 'lost', label: 'Records dropped', value: String(s.dropped), sub: `${s.dropped_total} this session`, status: level('link.lost_pct', lostPct), source: 'trace (OVERFLOW)' },
      { id: 'self', label: 'zprof own cost', value: s.self_pct.toFixed(2), unit: '%', sub: `hooks ${s.hooks_pct.toFixed(2)}% at ${h.hook_ns} ns`, status: level('agent.self', s.self_pct), source: 'trace + hello' },
      { id: 'tgt', label: 'Target', value: `Zephyr ${h.kernel}`, sub: `${h.ts_hz / 1e6} MHz DWT, ring ${h.ring_kb} KB${h.elf ? `, ${h.elf}${h.elf_ok === false ? ' (OTHER BUILD)' : ''}` : ', no ELF'}`, status: h.elf_ok === false ? 'warn' : 'info', source: 'hello' },
    ]
    kpi.setTiles(tiles)

    const head = ['Thread', 'Prio', 'CPU %', 'net %', 'In/s', 'Wake us', 'p99', 'max']
    const rows: CellContent[][] = s.threads.filter((r) => r.cpu_pct > 0 || r.switches_s > 0).map((r) => [
      r.sender ? `${r.name} (zprof)` : r.name, r.prio === null ? '' : String(r.prio),
      { value: r.cpu_pct, text: r.cpu_pct.toFixed(2), bar: r.cpu_pct, barMin: 0, barMax: 100, barColor: (colorByName.get(r.name) ?? t.uiText).setA(255) },
      r.net_pct.toFixed(2), r.switches_s.toFixed(0), us(r.wake_mean_us), us(r.wake_p99_us), us(r.wake_max_us),
    ])
    tgrid.setTableContent([head, ...rows])
    const ihead = ['Interrupt', '/s', 'CPU %', 'mean us', 'max us']
    igrid.setTableContent([ihead, ...s.irqs.map((r) => [r.name, r.per_s.toFixed(0), r.cpu_pct.toFixed(2), us(r.mean_us), us(r.max_us)])])
  }

  // The bridge re-makes a broken link by itself; the timeline goes on after the gap.
  const status = (st: LiveStatus) => {
    tl.setTitle(st.link === 'down'
      ? `${title}: LINK DOWN (${st.why}), ${h.source === 'replay' ? 'replay ended' : 'reconnecting'}`
      : st.sessions > 1 ? `${title} (session ${st.sessions})` : title)
  }

  return {
    batch,
    stats,
    status,
    frame: () => { gantt.commit() },
    dispose: () => dash.dispose(),
  }
}
