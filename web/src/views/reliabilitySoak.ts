import {
  sferic, AxisTickStrategies, ColorRGBA, DashedLine, StipplePatterns, LUT, PalettedFill, PieChartTypes, synchronizeAxisIntervals,
  type Axis, type CellContent, type ChartXY, type Color,
} from 'sferic'
import { addIntervalSeries } from '../charts/IntervalSeries'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { statusColor, type Status } from '../charts/status'
import { SoakSim, DUTS, RUN_HOURS, STEP_H, HEAP_SIZE, PHASE_SEGMENTS, chamber, isFailure, type SoakEvent } from '../sim/soak'
import { breaches, criterion, limitText, ruleStatus, thresholds, type Criterion } from '../thresholds'
import { hours } from '../format'
import { fill, line, type View } from './common'
import { dataTable } from '../charts/dataTable'

/** Real seconds per simulated minute: the run advances while you watch. */
const TICK_MS = 1000
const PHASES = ['ambient', 'ramp up', 'hot dwell', 'ramp down', 'cold dwell', 'recover'] as const

/** What the bridge measured for one criterion's metric over the run so far. */
interface Measure { v: number; lo?: number; text: string; where: string }

/** Criterion status; slope criteria judged on the interval FAIL only when the whole CI breaches. */
function judge(c: Criterion, m: Measure | undefined): Status {
  if (!m || !Number.isFinite(m.v)) return 'idle'
  if (c.agg === 'slope' && c.judge === 'interval' && c.crit !== undefined) {
    if (m.lo !== undefined && breaches(c.op, m.lo, c.crit)) return 'crit'
    if (breaches(c.op, m.v, c.crit)) return 'warn'
    return c.warn !== undefined && breaches(c.op, m.v, c.warn) ? 'warn' : 'ok'
  }
  return ruleStatus(c, m.v)
}

export const reliabilitySoak: View = ({ container, theme: t }) => {
  const sim = new SoakSim()
  const [bad, mid, good] = t.examples.badGoodColorPalette
  const dutColor = (d: number) => t.seriesColors[d % t.seriesColors.length]
  // Criteria the layout itself depends on (chart limits, fit windows, MTBF target).
  const cLeak = criterion('heap-leak'), cP99 = criterion('ctrl-p99'), cMtbf = criterion('mtbf')
  const leakLimit = cLeak.crit ?? 50, p99Limit = cP99.crit ?? 500
  const conf = cMtbf.confidence ?? 0.9, mtbfTarget = cMtbf.crit ?? 1000

  const dash = sferic().Dashboard({ container, theme: t, numberOfColumns: 4, numberOfRows: 4, splitterThickness: 4 })
  dash.setRowHeight(0, 0.62).setRowHeight(1, 1.45).setRowHeight(2, 1.2).setRowHeight(3, 1.3)
  dash.setColumnWidth(0, 1).setColumnWidth(1, 1).setColumnWidth(2, 1).setColumnWidth(3, 1.15)

  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 4 })

  // ---------------------------------------------------------------- event timeline: chamber phases + DUT uptime ribbons + events
  const ev = dash
    .createChartXY({ columnIndex: 0, rowIndex: 1, columnSpan: 3, legend: { visible: false } })
    .setTitle('Run timeline: chamber profile, DUT uptime, resets and faults (hover for detail)')
    .setTitleFont((f) => f.setSize(13))
  const cold = t.seriesColors[0], hot = t.seriesColors[8]
  const evStates = [
    { name: 'ambient', color: t.isDark ? ColorRGBA(120, 132, 156, 90) : ColorRGBA(150, 158, 175, 90) },
    { name: 'ramp up', color: hot.setA(90) },
    { name: 'hot dwell 70 C', color: hot.setA(200) },
    { name: 'ramp down', color: cold.setA(90) },
    { name: 'cold dwell -20 C', color: cold.setA(210) },
    { name: 'recover', color: cold.setA(60) },
    { name: 'up', color: good.setA(110), height: 0.32 },
    { name: 'telemetry gap', color: t.tickColor.setA(220), height: 0.7 },
    { name: 'hang (heartbeat silent)', color: bad.setA(200), height: 0.7 },
    { name: 'task watchdog reset', color: bad },
    { name: 'hardware watchdog reset', color: bad },
    { name: 'brownout reset', color: mid },
    { name: 'fatal error / assert', color: t.seriesColors[5] },
  ]
  const ST = { up: 6, gap: 7, hang: 8, wdt: 9, hwwdt: 10, brownout: 11, fatal: 12 } as const
  const evSeries = addIntervalSeries(ev, {
    lanes: ['Chamber', ...DUTS],
    states: evStates,
    formatTime: (h) => `${h.toFixed(2)} h`,
    formatDuration: (h) => hours(h),
    tooltip: (hit) => {
      const rows: (string | { text: string; color?: Color })[][] = [[{ text: hit.laneName, color: hit.state.color.setA(255) }], ['State:', hit.label ?? hit.state.name]]
      rows.push([hit.t1 === hit.t0 ? 'At:' : 'From:', `${hit.t0.toFixed(2)} h`])
      if (hit.t1 > hit.t0) rows.push(['Duration:', hours(hit.t1 - hit.t0)])
      if (hit.lane > 0) rows.push(['Chamber:', `${chamber(hit.t0).c.toFixed(0)} C, ${chamber(hit.t0).phase}`])
      return rows
    },
  })
  evSeries.setupLaneAxis(false)
  ev.axisY.setThickness(64)

  const evShown = new Set<SoakEvent>()
  const rebuildTimeline = () => {
    evSeries.clear()
    for (const s of PHASE_SEGMENTS) if (s.h0 < sim.elapsed) evSeries.append(0, s.h0, Math.min(s.h1, sim.elapsed), PHASES.indexOf(s.phase), `${s.phase}`)
    evShown.clear()
    const evs = sim.eventsSoFar().sort((a, b) => a.h - b.h)
    // Uptime ribbons break at resets; gaps and hangs are drawn as their own spans.
    DUTS.forEach((_, d) => {
      let from = 0
      for (const e of evs.filter((x) => x.dut === d)) {
        if (e.kind === 'linkgap' || e.kind === 'hang') {
          evSeries.append(d + 1, from, e.h, ST.up)
          evSeries.append(d + 1, e.h, Math.min(e.h + (e.dur ?? 0), sim.elapsed), e.kind === 'hang' ? ST.hang : ST.gap, e.detail)
          from = e.h + (e.dur ?? 0)
        } else {
          evSeries.append(d + 1, from, e.h, ST.up)
          evSeries.mark(d + 1, e.h, ST[e.kind], e.detail)
          from = e.h + 0.01
        }
        evShown.add(e)
      }
      if (from < sim.elapsed) evSeries.append(d + 1, from, sim.elapsed, ST.up)
    })
    evSeries.commit()
  }

  // ---------------------------------------------------------------- criteria (from config/zprof.thresholds.json)
  const crit = dataTable(dash, { columnIndex: 3, rowIndex: 1 }).setTitle(`Pass criteria (${thresholds.name ?? 'thresholds file'})`).setTitleFont((f) => f.setSize(13))
  crit.setCellChangeHighlight(false)

  // ---------------------------------------------------------------- trend charts (X synchronized with the timeline)
  const trend = (col: number, title: string, yTitle: string, units: string): ChartXY => {
    const c = dash.createChartXY({ columnIndex: col, rowIndex: 2, columnSpan: col === 0 ? 2 : 1, legend: { visible: false } })
      .setTitle(title).setTitleFont((f) => f.setSize(13)).setCursorMode('show-nearest')
    c.axisX.setTitle('Run time').setUnits('h')
    c.axisY.setTitle(yTitle).setUnits(units)
    return c
  }
  const heap = trend(0, `Heap allocated per DUT since last reset; dashed = leak fit (limit ${leakLimit} B/h)`, 'Heap', 'KiB')
  const env = trend(2, 'Chamber and die temperature', 'Temperature', 'C')
  const lat = trend(3, `ctrl_loop p99 per DUT (limit ${p99Limit} us)`, 'p99', 'us')
  heap.axisY.setDefaultInterval({ start: 8, end: HEAP_SIZE / 1024 })
  heap.axisY.addConstantLine(true).setValue(HEAP_SIZE / 1024 * 0.9).setStrokeStyle(line(bad, 1.5))
  lat.axisY.addConstantLine(true).setValue(p99Limit).setStrokeStyle(line(bad, 1.5))
  if (cP99.warn !== undefined) lat.axisY.addConstantLine(true).setValue(cP99.warn).setStrokeStyle(new DashedLine({ thickness: 1, fillStyle: fill(mid), pattern: StipplePatterns.Dashed }))
  lat.axisY.setDefaultInterval({ start: 250, end: p99Limit * 1.04 })
  const heapS = DUTS.map((n, d) => heap.addLineSeries({ automaticColorIndex: d }).setName(n).setStrokeStyle(line(dutColor(d), d === 4 ? 2 : 1)))
  const latS = DUTS.map((n, d) => lat.addLineSeries({ automaticColorIndex: d }).setName(n).setStrokeStyle(line(dutColor(d).setA(200), 1)))
  const chamberS = env.addLineSeries({ automaticColorIndex: 0 }).setName('Chamber').setStrokeStyle(line(t.titleColor, 2))
  const dieS = DUTS.map((n, d) => env.addLineSeries({ automaticColorIndex: d }).setName(`${n} die`).setStrokeStyle(line(dutColor(d).setA(150), 1)))
  const leakFit = heap.addLineSeries().setName('leak fit').setStrokeStyle(new DashedLine({ thickness: 2, fillStyle: fill(bad), pattern: StipplePatterns.Dashed }))
  const leakBand = heap.addAreaRangeSeries().setName('fit 95% band').setAreaFillStyle(fill(bad.setA(40))).setStrokeStyle(line(bad.setA(0), 0))

  // The whole run on every time axis; zooming one zooms all (linked correlation of events, chamber and trends).
  const axes: Axis[] = [ev.axisX, heap.axisX, env.axisX, lat.axisX]
  for (const a of axes) a.setInterval({ start: 0, end: RUN_HOURS, stopAxisAfter: true })
  synchronizeAxisIntervals(...axes)
  const nowLines = axes.map((a) => a.addConstantLine(true).setStrokeStyle(line(t.examples.highlightColor, 1.5)))
  ev.axisX.setTickStrategy(AxisTickStrategies.Numeric)

  // ---------------------------------------------------------------- fleet grid
  const fleet = dataTable(dash, { columnIndex: 0, rowIndex: 3, columnSpan: 2 }).setTitle('DUT fleet').setTitleFont((f) => f.setSize(13))
  const fleetHead = ['DUT', 'Status', 'Uptime', 'Unplanned resets', 'Heap slope', 'Min stack', 'CPU p95', 'p99', 'Die max', 'Link loss']
  fleet.setCellChangeHighlight(false).setColumnWidth(0, { min: 64 })
  const tint = (lo: number, w: number, c: number, hi: number) => new PalettedFill({
    lut: new LUT({ interpolate: true, steps: [
      { value: lo, color: good.setA(34) }, { value: w, color: good.setA(34) }, { value: w + (c - w) * 0.01, color: mid.setA(170) }, { value: c, color: bad.setA(210) }, { value: hi, color: bad.setA(210) },
    ] }),
  })

  // ---------------------------------------------------------------- reset causes donut
  const donut = dash.createPieChart({ columnIndex: 2, rowIndex: 3, type: PieChartTypes.LabelsInsideSlices })
    .setTitle('Unplanned resets by cause').setTitleFont((f) => f.setSize(13))
    .setInnerRadius(52)
    .setLabelFormatter((s, rel) => (rel > 0.08 ? `${s.getName()}\n${s.getValue()}` : ''))
  donut.legend.setPosition('bottom')
  const causes = [
    { name: 'Task watchdog', kinds: ['wdt'], color: bad },
    { name: 'HW watchdog', kinds: ['hwwdt'], color: bad.mix(ColorRGBA(255, 255, 255, 255), 0.35) },
    { name: 'Brownout', kinds: ['brownout'], color: mid },
    { name: 'Fatal / assert', kinds: ['fatal'], color: t.seriesColors[5] },
  ]
  const slices = causes.map((c) => donut.addSlice(c.name, 0).setFillStyle(fill(c.color)))

  // ---------------------------------------------------------------- fault signatures
  const faults = dataTable(dash, { columnIndex: 3, rowIndex: 3 }).setTitle('Fault signatures (grouped)').setTitleFont((f) => f.setSize(13))
  faults.setCellChangeHighlight(false)

  // ---------------------------------------------------------------- update
  let drawnTo = 0
  const update = () => {
    const now = sim.elapsed
    // Append new samples since the last update.
    DUTS.forEach((_, d) => {
      const s = sim.series[d]
      let i = s.h.length
      while (i > 0 && s.h[i - 1] > drawnTo) i--
      if (i >= s.h.length) return
      const xs = s.h.slice(i)
      heapS[d].appendSamples({ xValues: xs, yValues: s.heap.slice(i) })
      latS[d].appendSamples({ xValues: xs, yValues: s.p99.slice(i) })
      dieS[d].appendSamples({ xValues: xs, yValues: s.die.slice(i) })
    })
    const chX: number[] = [], chY: number[] = []
    for (let h = Math.ceil(drawnTo / STEP_H) * STEP_H; h <= now; h += STEP_H * 5) { chX.push(h); chY.push(chamber(h).c) }
    if (chX.length) chamberS.appendSamples({ xValues: chX, yValues: chY })
    drawnTo = now
    for (const l of nowLines) l.setValue(now)

    // Leak fit for the worst evaluable DUT, with the window rules from the criterion.
    const leaks = DUTS.map((_, d) => sim.leak(d, cLeak.warmupHours ?? 1, cLeak.minWindowHours ?? 8))
    const worst = leaks.reduce((b, l, d) => (l.ok && (!leaks[b].ok || l.slope > leaks[b].slope) ? d : b), 0)
    const L = leaks[worst]
    const notEval = leaks.filter((l) => !l.ok).length
    const x0 = L.from, x1 = Math.min(RUN_HOURS, now + (L.tte < Infinity ? Math.min(L.tte, RUN_HOURS) : 0))
    const fx = [x0, x1], fy = fx.map((x) => (L.a + L.slope * x) / 1024)
    leakFit.setName(`${DUTS[worst]} leak fit`).clear().appendSamples({ xValues: fx, yValues: fy })
    const span = (x: number) => (L.ci * (x - x0)) / 1024
    leakBand.clear().appendSamples({ xValues: fx, yValues: fy.map((y, k) => y + span(fx[k])), lowValues: fy.map((y, k) => y - span(fx[k])) })

    if (sim.eventsSoFar().some((e) => !evShown.has(e)) || Math.floor(now * 10) % 5 === 0) rebuildTimeline()

    const rel = sim.reliability(conf, mtbfTarget)
    const evs = sim.eventsSoFar()
    const fails = rel.fails
    const dutsOf = (es: SoakEvent[]) => [...new Set(es.map((e) => DUTS[e.dut]))].join(' ')
    const minMargin = Math.min(...sim.series.map((s) => Math.min(...s.marginNet)))
    const minMarginDut = sim.series.findIndex((s) => Math.min(...s.marginNet) === minMargin)
    const p99Worst = Math.max(...sim.series.map((s) => Math.max(...s.p99)))
    const p99Dut = sim.series.findIndex((s) => Math.max(...s.p99) === p99Worst)
    const cpuWorst = Math.max(...sim.series.map((s) => Math.max(...s.cpu95)))
    const gaps = evs.filter((e) => e.kind === 'linkgap')
    const lossPct = (gaps.reduce((a, e) => a + (e.dur ?? 0), 0) / (DUTS.length * now)) * 100
    const hangs = evs.filter((e) => e.kind === 'hang')
    const fatal = evs.filter((e) => e.kind === 'fatal')
    const ch = chamber(now)

    // What the bridge can measure, keyed by catalog metric. Criteria naming anything else show as n/a.
    const measures: Record<string, Measure> = {
      'reset.unplanned': { v: fails.length, text: String(fails.length), where: dutsOf(fails) },
      'hang': { v: hangs.length, text: String(hangs.length), where: dutsOf(hangs) },
      'fault.fatal': { v: fatal.length, text: String(fatal.length), where: dutsOf(fatal) },
      'heap.*.alloc': { v: L.ok ? L.slope : NaN, lo: L.slope - L.ci, text: L.ok ? `${L.slope.toFixed(0)} +/- ${L.ci.toFixed(0)}` : 'n/a', where: `${DUTS[worst]}${notEval ? ` (${notEval} < ${cLeak.minWindowHours ?? 8} h)` : ''}` },
      'stack.*.margin': { v: minMargin, text: `${minMargin.toFixed(1)}%`, where: `${DUTS[minMarginDut]} net_rx` },
      'span.ctrl_loop.p99': { v: p99Worst, text: `${p99Worst.toFixed(0)} us`, where: DUTS[p99Dut] },
      'cpu.load.p95': { v: cpuWorst, text: `${cpuWorst.toFixed(1)}%`, where: '' },
      'link.lost_pct': { v: lossPct, text: `${lossPct.toFixed(3)}%`, where: dutsOf(gaps) },
      'run.mtbf_lower': { v: rel.lower, text: `${rel.lower.toFixed(0)} h`, where: `${rel.hours.toFixed(0)} device-h` },
    }
    const results = thresholds.criteria.map((c) => ({ c, m: measures[c.metric], s: judge(c, measures[c.metric]) }))
    const stText: Record<Status, string> = { ok: 'PASS', warn: 'WARN', crit: 'FAIL', info: 'INFO', idle: 'n/a' }
    crit.setTableContent([
      ['Criterion', 'Result', 'Worst', 'Limit', 'Where'],
      ...results.map(({ c, m, s }) => [
        c.title,
        { text: stText[s], fill: statusColor(t, s).setA(s === 'ok' ? 60 : s === 'idle' ? 40 : 200), textColor: t.titleColor },
        m?.text ?? 'n/a', limitText(c), m?.where ?? 'not measured',
      ] as CellContent[]),
    ])
    crit.setColumnWidth(0, { min: 150 })
    const nFail = results.filter((r) => r.s === 'crit').length, nWarn = results.filter((r) => r.s === 'warn').length
    // Spec 7.2: PASS needs every criterion evaluated. Precedence FAIL > INCOMPLETE > WARN > PASS.
    const nNa = results.filter((r) => r.s === 'idle').length
    const verdict = nFail ? 'FAIL' : nNa ? 'INCOMPLETE' : nWarn ? 'WARN' : 'PASS'
    const statusOf = (id: string) => results.find((r) => r.c.id === id)?.s ?? 'idle'

    // Fleet.
    fleet.setTableContent([fleetHead, ...DUTS.map((name, d) => {
      const s = sim.series[d]
      const lastReset = Math.max(0, ...evs.filter((e) => e.dut === d && isFailure(e)).map((e) => e.h))
      const n = evs.filter((e) => e.dut === d && isFailure(e)).length
      const status: Status = n ? 'crit' : leaks[d].ok && leaks[d].slope > leakLimit ? 'warn' : 'ok'
      const gap = evs.filter((e) => e.dut === d && e.kind === 'linkgap').reduce((a, e) => a + (e.dur ?? 0), 0)
      return [
        { text: name, textColor: dutColor(d).setA(255) },
        { text: status === 'crit' ? 'FAILED' : status === 'warn' ? 'LEAK' : 'OK', fill: statusColor(t, status).setA(status === 'ok' ? 50 : 190), textColor: t.titleColor },
        hours(now - lastReset),
        { value: n, text: String(n) },
        leaks[d].ok ? { value: leaks[d].slope, text: `${leaks[d].slope.toFixed(0)} B/h` } : { text: `n/a (< ${cLeak.minWindowHours ?? 8} h)` },
        { value: Math.min(...s.marginNet), text: `${Math.min(...s.marginNet).toFixed(1)}%` },
        `${Math.max(...s.cpu95).toFixed(1)}%`,
        { value: Math.max(...s.p99), text: `${Math.max(...s.p99).toFixed(0)} us` },
        `${Math.max(...s.die).toFixed(1)} C`,
        `${((gap / now) * 100).toFixed(2)}%`,
      ] as CellContent[]
    })])
    fleet.setColumnBackgroundFillStyle(3, tint(0, 0.5, 1, 10))
    fleet.setColumnBackgroundFillStyle(4, tint(-100, leakLimit * 0.6, leakLimit, 1000))
    fleet.setColumnBackgroundFillStyle(7, tint(0, cP99.warn ?? p99Limit * 0.85, p99Limit, 2000))

    // Donut.
    causes.forEach((c, i) => slices[i].setValue(fails.filter((e) => c.kinds.includes(e.kind)).length))

    // Fault signatures.
    const sig = new Map<string, { kind: string; n: number; duts: Set<string>; first: number; last: number; detail: string }>()
    for (const e of evs.filter((x) => x.kind !== 'linkgap')) {
      const key = e.kind === 'wdt' ? 'task_wdt storage' : e.kind === 'hang' ? 'hang: flash_lock' : e.kind === 'hwwdt' ? 'HW WDT after hang' : e.kind === 'brownout' ? 'RESET_BROWNOUT' : 'assert proto.c:212'
      const g = sig.get(key) ?? { kind: e.kind, n: 0, duts: new Set<string>(), first: e.h, last: e.h, detail: e.detail }
      g.n++; g.duts.add(DUTS[e.dut]); g.last = e.h
      sig.set(key, g)
    }
    faults.setTableContent([
      ['Signature', 'Count', 'DUTs', 'First', 'Last', 'Context'],
      ...[...sig.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => [
        { text: k, textColor: (g.kind === 'brownout' ? mid : g.kind === 'fatal' ? t.seriesColors[5] : bad).setA(255) },
        String(g.n), [...g.duts].join(' '), `${g.first.toFixed(1)} h`, `${g.last.toFixed(1)} h`,
        `${g.detail}${g.kind === 'wdt' ? ', all in cold dwell' : ''}`,
      ] as CellContent[]),
    ])
    faults.setColumnWidth(0, { min: 120 })

    // KPI strip: statuses come from the same criteria as the table.
    const tiles: KpiTile[] = [
      { id: 'verdict', label: 'Verdict', value: verdict, sub: `${nFail} failed, ${nWarn} warn${nNa ? `, ${nNa} n/a` : ''} of ${results.length} criteria`, status: nFail ? 'crit' : nNa || nWarn ? 'warn' : 'ok', source: 'thresholds file' },
      { id: 'elapsed', label: 'Elapsed', value: now.toFixed(1), unit: `/ ${RUN_HOURS} h`, sub: `cycle ${Math.floor(now / 4) + 1} of ${RUN_HOURS / 4}, ${ch.phase}`, status: 'info', progress: now / RUN_HOURS, source: 'run' },
      { id: 'duts', label: 'DUTs', value: `${DUTS.length}`, unit: 'running', sub: `${(DUTS.length * now).toFixed(0)} device-hours`, status: 'ok' },
      { id: 'resets', label: 'Unplanned resets', value: String(fails.length), sub: causes.map((c) => `${c.kinds[0]} ${fails.filter((e) => c.kinds.includes(e.kind)).length}`).join('  '), status: statusOf('unplanned-resets'), source: 'hwinfo + fault record' },
      { id: 'mtbf', label: `MTBF ${Math.round(conf * 100)}% lower`, value: rel.lower.toFixed(0), unit: 'h', sub: `point ${rel.point === Infinity ? 'n/a' : rel.point.toFixed(0) + ' h'}, target ${mtbfTarget} h`, status: statusOf('mtbf'), source: 'derived, chi-square' },
      { id: 'leak', label: 'Worst heap trend', value: L.ok ? `+${L.slope.toFixed(0)}` : 'n/a', unit: 'B/h', sub: `${DUTS[worst]}, exhausts in ${L.tte === Infinity ? 'never' : hours(L.tte)}`, status: statusOf('heap-leak'), source: 'derived, OLS' },
      { id: 'stack', label: 'Min stack margin', value: minMargin.toFixed(1), unit: '%', sub: `${DUTS[minMarginDut]} net_rx`, status: statusOf('stack-margin'), source: 'stats (watermark)' },
      { id: 'p99', label: 'Worst ctrl_loop p99', value: p99Worst.toFixed(0), unit: 'us', sub: `${DUTS[p99Dut]}, limit ${p99Limit} us`, status: statusOf('ctrl-p99'), source: 'span' },
      { id: 'loss', label: 'Telemetry loss', value: lossPct.toFixed(3), unit: '%', sub: 'DUT-02 link gaps, not DUT failures', status: statusOf('telemetry-loss'), source: 'bridge' },
      { id: 'chamber', label: 'Chamber', value: ch.c.toFixed(1), unit: 'C', sub: ch.phase, status: ch.phase === 'cold dwell' ? 'warn' : 'info', source: 'chamber controller' },
    ]
    kpi.setTiles(tiles)
  }

  rebuildTimeline()
  update()
  const timer = setInterval(() => { sim.advanceTo(sim.elapsed + STEP_H); update() }, TICK_MS)
  return () => {
    clearInterval(timer)
    dash.dispose()
  }
}
