// SPDX-License-Identifier: Apache-2.0
import { sferic, AxisTickStrategies, AxisScrollStrategies, ColorRGBA, type CellContent, type Theme } from 'sferic'
import { addIntervalSeries, type IntervalState } from '../charts/IntervalSeries'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { level } from '../thresholds'
import { durMs, rate } from '../format'
import { liveLink, CODE, type IntervalBatch, type LiveHello, type LiveStats, type LiveStatus } from '../live/link'
import { fill, irqColor, line, threadColor, type View } from './common'
import { dataTable } from '../charts/dataTable'
import { button, el, select } from '../dom'

const TIMELINE_MS = 200
const HISTORY_S = 60
/** Where the trigger sits in the window, from the left. */
const TRIG_AT = 0.1
/** Activity closer than this to the lane's last is contiguous: a preemption, not a release. */
const CONTIG_MS = 0.002

/** A window's width for its title: 23 ms, 4.2 ms, 590 us, 1.25 s. */
const span = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} us` : ms < 10 ? `${ms.toFixed(1)} ms`
  : ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`)

/** What the timeline keeps across rebuilds (a hello rebuilds the view). */
interface Prefs {
  /** Window width, ms (the timebase): TIMELINE_MS, or the span zoomed to before Live. */
  width: number
  /** The lane triggered on, by its label; '' runs free. */
  trig: string
}

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
  const prefs: Prefs = { width: TIMELINE_MS, trig: '' }
  const rebuild = (h: LiveHello) => {
    built?.dispose()
    note.hidden = true
    built = build(host, t, h, prefs, (fn) => link.replay(fn))
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

function build(host: HTMLElement, t: Theme, h: LiveHello, prefs: Prefs,
  replay: (fn: (b: IntervalBatch) => void) => void): Built {
  const [bad] = t.examples.badGoodColorPalette
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 4, numberOfRows: 4, splitterThickness: 4 })
  dash.setRowHeight(0, 0.62).setRowHeight(1, 2.0).setRowHeight(2, 1.35).setRowHeight(3, 1.0)
  // the CPU chart (column 0) gives width to the Threads table (1 and 2): its PMU figures
  dash.setColumnWidth(0, 0.75).setColumnWidth(1, 1.15).setColumnWidth(2, 1.15).setColumnWidth(3, 0.95)
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
    { name: 'blocked on a mutex another thread held', color: bad.setA(190), height: 0.42 },
    { name: 'waiting for an event (semaphore, queue, message, poll)', color: t.isDark ? ColorRGBA(120, 140, 180, 90) : ColorRGBA(110, 125, 160, 90), height: 0.14 },
  ]
  const READY_ST = L, DROP_ST = L + 1, BLOCKED_ST = L + 2, WAITING_ST = L + 3
  const tl = dash.createChartXY({ columnIndex: 0, rowIndex: 1, columnSpan: 4, legend: { visible: false } })
    .setTitleFont((f) => f.setSize(13))
  const laneNames = h.lanes.map((ln) => (ln.kind === 'irq' ? `ISR ${ln.name}` : `${ln.name}${ln.prio !== null ? ` ${ln.prio}` : ''}`))
  const gantt = addIntervalSeries(tl, { lanes: laneNames, states, retention: h.retain_ms, formatDuration: durMs })
  gantt.setupLaneAxis()
  tl.axisY.setThickness(132)

  // Following, holding and triggering. The axis follows the newest data, or, triggered,
  // the latest release of one lane, placed TRIG_AT into the window: that lane stands
  // still and the others stream against it (with no trigger seen yet it follows the
  // newest data, a scope's auto mode). A zoom or pan stops the axis (Sferic) and holds
  // the timeline: nothing more is fed to it, so nothing in view is evicted while you
  // look; Live or a double-click refills it from the link's retained window.
  let trig = prefs.trig ? laneNames.indexOf(prefs.trig) : -1
  let trigs: number[] = []        // release times of the trigger lane, ascending
  let lastAct = -Infinity         // end of the trigger lane's latest activity
  let curT: number | null = null  // the trigger the window is placed on
  let held = false
  const latest = (limit: number): number | null => {
    let lo = 0, hi = trigs.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (trigs[m] <= limit) lo = m + 1
      else hi = m
    }
    return lo > 0 ? trigs[lo - 1] : null
  }
  tl.axisX
    .setTickStrategy(AxisTickStrategies.Time)
    .setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => {
      const end = s.dataMax ?? 0, w = prefs.width
      curT = trig >= 0 ? latest(end - (1 - TRIG_AT) * w) : null
      return curT !== null
        ? { start: curT - TRIG_AT * w, end: curT + (1 - TRIG_AT) * w, stopAxisAfter: false }
        : { start: end - w, end, stopAxisAfter: false }
    })
  const marker = tl.axisX.addConstantLine(true).setVisible(false)

  const batch = (b: IntervalBatch) => {
    if (held) return
    for (let i = 0; i < b.n; i++) {
      const ln = b.lane[i], c = b.code[i]
      if (ln >= L) continue
      if (c === CODE.DROP) {
        gantt.mark(ln, b.t0[i], DROP_ST)
        continue
      }
      gantt.append(ln, b.t0[i], b.t1[i], c === CODE.READY ? READY_ST : c === CODE.BLOCKED ? BLOCKED_ST : c === CODE.WAITING ? WAITING_ST : ln)
      // A release: the lane becomes ready or runs (an interrupt: is entered) after a gap
      // in its activity; ready right after running is a preemption, not a release.
      if (ln === trig && c !== CODE.BLOCKED && c !== CODE.WAITING) {
        if (b.t0[i] > lastAct + CONTIG_MS) trigs.push(b.t0[i])
        if (b.t1[i] > lastAct) lastAct = b.t1[i]
      }
    }
    if (trigs.length > 20_000) trigs.splice(0, trigs.length - 20_000)
  }
  const refill = () => {
    held = false
    trigs = []
    lastAct = -Infinity
    curT = null
    gantt.clear()
    replay(batch)
    gantt.commit()
  }

  // ---------------------------------------------------------------- timeline controls
  const ctl = el('div', 'tl-ctl')
  const state = el('span', 'tl-state')
  const holdBtn = button('Hold', () => (held ? live() : hold()), 'btn tiny',
    'Hold the timeline to look at it (a zoom or pan holds it too)')
  const trigSel = select<string>([['', 'Free run'], ...laneNames.map((n): [string, string] => [n, n])],
    trig >= 0 ? laneNames[trig] : '', (v) => setTrigger(v))
  trigSel.title = 'Trigger: the lane whose releases stay still in the window'
  ctl.append(el('span', '', 'Trigger'), trigSel, holdBtn, state)
  host.appendChild(ctl)
  let linkNote = ''
  let shown = 0   // the span in view the title names while held
  const inView = () => Math.abs(tl.axisX.end - tl.axisX.start)
  const chrome = () => {
    const what = trig >= 0 ? `, triggered on ${laneNames[trig]}` : ''
    const src = `${h.source === 'replay' ? 'replay of ' : ''}${h.target}`
    shown = inView()
    tl.setTitle(`Scheduler timeline, ${held ? `held, ${span(shown)} in view` : `live ${span(prefs.width)} window`}${what}: ${src}${linkNote}`)
    holdBtn.textContent = held ? 'Live' : 'Hold'
    holdBtn.classList.toggle('on', held)
    holdBtn.title = held ? `Follow live again with this ${span(shown)} window (double-click: with the last one, ${span(prefs.width)})`
      : 'Hold the timeline to look at it (a zoom or pan holds it too)'
    state.textContent = held ? 'held' : trig >= 0 && curT === null ? 'waiting for a trigger' : ''
    for (let i = 0; i < L; i++) gantt.setLaneLabel(i, i === trig ? `▸ ${laneNames[i]}` : laneNames[i])
    marker.setVisible(trig >= 0 && curT !== null)
    if (trig >= 0) marker.setStrokeStyle(line(laneColor[trig].setA(230), 1))
  }
  const hold = () => {
    tl.axisX.stopped = true
    held = true
    chrome()
  }
  // Live: the span zoomed to becomes the window; the axis follows again and the
  // timeline is refilled with what came meanwhile.
  const live = () => {
    const span = Math.abs(tl.axisX.end - tl.axisX.start)
    if (span > 0.05) prefs.width = span
    refill()
    tl.axisX.fit(false)
    chrome()
  }
  const setTrigger = (name: string) => {
    prefs.trig = name
    trig = name ? laneNames.indexOf(name) : -1
    refill()   // the trigger lane's releases from the retained window; holding ends
    tl.axisX.fit(false)
    chrome()
  }
  chrome()

  // ---------------------------------------------------------------- CPU by thread
  const cpu = dash.createChartXY({ columnIndex: 0, rowIndex: 2, legend: { visible: true, position: 'right' } })
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
  // two columns wide: room for the PMU figures (IPC, refills, stalls) with --pmu-threads
  const tgrid = dataTable(dash, { columnIndex: 1, rowIndex: 2, columnSpan: 2 }).setTitle('Threads, last second').setTitleFont((f) => f.setSize(13))
  tgrid.setCellChangeHighlight(false)
  const igrid = dataTable(dash, { columnIndex: 3, rowIndex: 2 }).setTitle('Interrupts, last second').setTitleFont((f) => f.setSize(13))
  igrid.setCellChangeHighlight(false)
  // threads the target's fault handler ended while the rest ran on (zprof fault capture)
  const fgrid = dataTable(dash, { columnIndex: 3, rowIndex: 3 }).setTitle('Faults: threads ended, the board ran on').setTitleFont((f) => f.setSize(13))
  fgrid.setCellChangeHighlight(false)
  const ogrid = dataTable(dash, { columnIndex: 0, rowIndex: 3, columnSpan: 3 })
    .setTitle('Kernel objects, last second: contended mutexes first, then by time threads waited on them (k_timer: its expiry function; without: returned without the object)')
    .setTitleFont((f) => f.setSize(13))
  ogrid.setCellChangeHighlight(false)
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
    const ft = s.faults
    if (ft && ft.count > 0) {
      // a thread the fault handler ended: the board runs on without it
      const last = ft.rows[0]
      tiles.splice(5, 0, { id: 'faults', label: 'Faults', value: String(ft.count), sub: last ? `${last.thread}: ${last.reason}` : '', status: 'crit', source: 'fault handler' })
    }
    kpi.setTiles(tiles)

    // PMU figures per thread (IPC, misses per 1000 instructions, stall share) when the
    // bridge asked for a PMU record at every switch (serve --pmu-threads)
    const pcols = s.pmu_cols ?? []
    // with PMU figures the wake latencies share one column (mean / p99 / max) and net %
    // (CPU % less interrupts: the KPI strip has the interrupt share) goes, so the table
    // fits without scrolling sideways
    const pmuOn = pcols.length > 0
    const wakeHead = pmuOn ? ['Wake us (p99, max)'] : ['Wake us', 'p99', 'max']
    const head = ['Thread', 'Prio', 'CPU %', ...(pmuOn ? [] : ['net %']), 'In/s', ...wakeHead, ...pcols.map((c) => c[1])]
    const rows: CellContent[][] = s.threads.filter((r) => r.cpu_pct > 0 || r.switches_s > 0).map((r) => [
      r.sender ? `${r.name} (zprof)` : r.name, r.prio === null ? '' : String(r.prio),
      { value: r.cpu_pct, text: r.cpu_pct.toFixed(2), bar: r.cpu_pct, barMin: 0, barMax: 100, barColor: (colorByName.get(r.name) ?? t.uiText).setA(255) },
      ...(pmuOn ? [] : [r.net_pct.toFixed(2)]), r.switches_s.toFixed(0),
      ...(pcols.length
        ? [r.wake_mean_us === null ? '' : `${us(r.wake_mean_us)} (${us(r.wake_p99_us)}, ${us(r.wake_max_us)})`]
        : [us(r.wake_mean_us), us(r.wake_p99_us), us(r.wake_max_us)]),
      ...pcols.map(([k]) => {
        const v = r.pmu?.[k]
        return v === undefined ? '' : v.toFixed(k === 'ipc' ? 2 : 1)
      }),
    ])
    tgrid.setTableContent([head, ...rows])
    const ihead = ['Interrupt', '/s', 'CPU %', 'mean us', 'max us']
    igrid.setTableContent([ihead, ...s.irqs.map((r) => [r.name, r.per_s.toFixed(0), r.cpu_pct.toFixed(2), us(r.mean_us), us(r.max_us)])])
    const ohead = ['Object', 'Class', 'Calls', 'Calls/s', 'Blocks/s', 'Waiting %', 'Wait us', 'max', 'Without']
    const restC = t.isDark ? ColorRGBA(120, 140, 180, 160) : ColorRGBA(110, 125, 160, 160)
    ogrid.setTableContent([ohead, ...(s.objects ?? []).map((r): CellContent[] => [
      r.contended ? `${r.name} (contended)` : r.name, r.cls, r.calls, r.calls_s.toFixed(0), r.blocks_s.toFixed(1),
      r.timer ? '' : { value: r.wait_pct, text: r.wait_pct.toFixed(2), bar: r.wait_pct, barMin: 0, barMax: 100, barColor: r.contended ? bad.setA(220) : restC },
      us(r.wait_mean_us), us(r.wait_max_us), r.without ? String(r.without) : '',
    ])])

    const fl = s.faults ?? { count: 0, rows: [] }
    const up = (t: number) => (t < 60 ? `${t.toFixed(1)} s` : t < 3600 ? `${Math.floor(t / 60)}m ${Math.floor(t % 60)}s` : `${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m`)
    fgrid.setTableContent([['Up', 'Thread', 'Reason', 'In'], ...(fl.rows.length
      ? fl.rows.map((r): CellContent[] => [up(r.t_s), r.thread, r.reason, r.where])
      : [['', 'none since boot', '', '']]),
      ...(fl.count > fl.rows.length ? [[`${fl.count} since boot`, 'the last 4 above', '', '']] : [])])
  }

  // The bridge re-makes a broken link by itself; the timeline goes on after the gap.
  const status = (st: LiveStatus) => {
    linkNote = st.link === 'down'
      ? `: LINK DOWN (${st.why}), ${h.source === 'replay' ? 'replay ended' : 'reconnecting'}`
      : st.sessions > 1 ? ` (session ${st.sessions})` : ''
    chrome()
  }

  let waiting = false
  const frame = () => {
    const stopped = tl.axisX.stopped
    if (stopped && !held) {          // a zoom or pan: hold what is in view
      held = true
      chrome()
    } else if (!stopped && held) {   // a double-click: follow again, with what came meanwhile
      refill()
      chrome()
    }
    const w = trig >= 0 && !held && curT === null
    if (w !== waiting) { waiting = w; chrome() }
    if (held && Math.abs(inView() - shown) > shown * 0.005) chrome()   // zooming while held
    if (curT !== null) marker.setValue(curT).setVisible(trig >= 0)
    gantt.commit()
    const r = tl.rect
    ctl.style.left = `${r.x + r.w - ctl.offsetWidth - 10}px`
    ctl.style.top = `${r.y + 4}px`
  }

  return {
    batch,
    stats,
    status,
    frame,
    dispose: () => { ctl.remove(); dash.dispose() },
  }
}
