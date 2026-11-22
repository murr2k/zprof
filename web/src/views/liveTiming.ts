// SPDX-License-Identifier: Apache-2.0
import { sferic, AxisTickStrategies, AxisScrollStrategies, type CellContent, type Theme } from 'sferic'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { dataTable } from '../charts/dataTable'
import { el } from '../dom'
import { liveLink, type LiveTiming, type TimingSeries } from '../live/link'
import type { View } from './common'

const WINDOW_MS = 60_000

function quantile(sorted: number[], q: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN
}
const f1 = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)) : '')

/**
 * Timing (live): what the application tells the trace and the heartbeat. Marked
 * jobs (zprof.h ZPROF_MARK_START/STOP: one point per job, its duration) and their
 * spread; plots (ZPROF_PLOT, e.g. the frame's margin at each hand-over); the
 * metrics of every heartbeat (the application's ZPROF_METRIC_DEFINEs and the
 * built-ins), one shown as a chart; stack watermarks; prints (ZPROF_PRINT).
 */
export const liveTiming: View = ({ container, theme: t }) => {
  const link = liveLink()
  const note = el('div', 'live-note')
  note.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'text-align:center;padding:24px;font:14px/1.6 system-ui,sans-serif;opacity:.85;white-space:pre-line'
  container.appendChild(note)
  const host = el('div')
  host.style.cssText = 'position:absolute;inset:0'
  container.appendChild(host)
  let built: ReturnType<typeof build> | null = null
  const render = () => {
    const tm = link.timing
    const any = Object.keys(tm.metrics).length + Object.keys(tm.plots).length + Object.keys(tm.spans).length
    if (!any) {
      note.hidden = false
      note.textContent = link.state === 'open'
        ? 'Waiting for the first heartbeat (every 100 ms by default).'
        : `No zprof bridge at ${link.url} (${link.state}).`
      return
    }
    note.hidden = true
    built ??= build(host, t)
    built.render(tm)
  }
  const off = link.onTiming(render)
  const offS = link.onState(render)
  render()
  return () => { off(); offS(); built?.dispose() }
}

function build(host: HTMLElement, t: Theme) {
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 3, numberOfRows: 4, splitterThickness: 4 })
  dash.setRowHeight(0, 0.5).setRowHeight(1, 1.25).setRowHeight(2, 1.15).setRowHeight(3, 1.1)
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 3 })
  const timeChart = (col: number, row: number, span: number, title: string, yTitle: string) => {
    const c = dash.createChartXY({ columnIndex: col, rowIndex: row, columnSpan: span, legend: { visible: true, position: 'right' } })
      .setTitle(title).setTitleFont((f) => f.setSize(13))
    c.axisX.setTickStrategy(AxisTickStrategies.Time).setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - WINDOW_MS, stopAxisAfter: false }))
    c.axisY.setTitle(yTitle)
    return c
  }
  const jobs = timeChart(0, 1, 2, 'Marked jobs (ZPROF_MARK_START / STOP): each job\'s duration, last 60 s', 'ms')
  const hist = dash.createChartXY({ columnIndex: 2, rowIndex: 1, legend: { visible: false } }).setTitleFont((f) => f.setSize(13))
  hist.axisX.setTitle('ms')
  hist.axisY.setTitle('jobs')
  const plots = timeChart(0, 2, 2, 'Plots (ZPROF_PLOT)', 'value')
  const metric = timeChart(2, 2, 1, 'Metric', '')
  const mtab = dataTable(dash, { columnIndex: 0, rowIndex: 3 }).setTitle('Heartbeat metrics (click one to chart it)').setTitleFont((f) => f.setSize(13))
  const stab = dataTable(dash, { columnIndex: 1, rowIndex: 3 }).setTitle('Stacks (watermark every 10th heartbeat)').setTitleFont((f) => f.setSize(13))
  const ptab = dataTable(dash, { columnIndex: 2, rowIndex: 3 }).setTitle('Prints (ZPROF_PRINT)').setTitleFont((f) => f.setSize(13))
  for (const g of [mtab, stab, ptab]) g.setCellChangeHighlight(false)

  const jobS = new Map<string, ReturnType<typeof jobs.addPointSeries>>()
  // points, not lines: a plot has gaps (no margin without consecutive frames: a 30 fps clip),
  // and a line would draw a value across them that was never measured
  const plotS = new Map<string, ReturnType<typeof plots.addPointSeries>>()
  const histS = hist.addLineSeries({ automaticColorIndex: 0 })
  const metricS = metric.addLineSeries({ automaticColorIndex: 4 })
  let picked: string | null = null
  let metricNames: string[] = []
  mtab.addEventListener('cellclick', (e: { row: number }) => {
    const n = metricNames[e.row - 1]
    if (n) { picked = n; last && render(last) }
  })
  let last: LiveTiming | null = null

  const render = (tm: LiveTiming) => {
    last = tm
    // marked jobs: points, and the spread of the first marker
    let i = 0
    for (const [name, s] of Object.entries(tm.spans)) {
      let ser = jobS.get(name)
      if (!ser) {
        ser = jobs.addPointSeries({ automaticColorIndex: i }).setName(`${name}${s.thread ? ` (${s.thread})` : ''}`).setMaxSampleCount(5000)
        jobS.set(name, ser)
      }
      ser.clear().appendSamples({ xValues: s.t, yValues: s.v.map((v) => v / 1000) })
      i++
    }
    const tiles: KpiTile[] = []
    const first = Object.entries(tm.spans)[0]
    if (first) {
      const [name, s] = first
      const d = [...s.v].sort((a, b) => a - b)
      const span = (s.t[s.t.length - 1] - s.t[0]) / 1000
      tiles.push(
        { id: 'rate', label: `${name} jobs`, value: span > 0 ? (s.t.length / span).toFixed(1) : '-', unit: '/s', sub: `${s.t.length} kept`, status: 'info', source: 'marks' },
        { id: 'p50', label: `${name} median`, value: f1(quantile(d, 0.5) / 1000), unit: 'ms', sub: `p99 ${f1(quantile(d, 0.99) / 1000)} ms`, status: 'info', source: 'marks' },
        { id: 'max', label: `${name} longest`, value: f1(d[d.length - 1] / 1000), unit: 'ms', sub: 'of those kept', status: 'info', source: 'marks' },
      )
      const lo = 0, hi = d[d.length - 1] / 1000 || 1, B = 40
      const counts = new Array(B).fill(0)
      for (const v of d) counts[Math.min(B - 1, Math.floor(((v / 1000 - lo) / (hi - lo)) * B))]++
      const xs: number[] = [], ys: number[] = []
      counts.forEach((c, k) => { const a = lo + (k * (hi - lo)) / B, b = lo + ((k + 1) * (hi - lo)) / B; xs.push(a, b); ys.push(c, c) })
      histS.clear().appendSamples({ xValues: xs, yValues: ys })
      hist.setTitle(`${name}: how long its jobs took (${d.length})`)
    }
    // plots
    i = 0
    for (const [name, s] of Object.entries(tm.plots)) {
      let ser = plotS.get(name)
      if (!ser) {
        ser = plots.addPointSeries({ automaticColorIndex: i + 2 }).setName(name).setMaxSampleCount(20000)
        plotS.set(name, ser)
      }
      ser.clear().appendSamples({ xValues: s.t, yValues: s.v })
      const sorted = [...s.v].sort((a, b) => a - b)
      if (i === 0) tiles.push({ id: 'plot', label: `${name} least`, value: f1(sorted[0]), sub: `last ${f1(s.v[s.v.length - 1])}`, status: 'info', source: 'plot' })
      i++
    }
    // metrics: the table, and the picked one as a chart
    metricNames = Object.keys(tm.metrics).sort()
    picked ??= metricNames.find((n) => tm.metrics[n].kind !== 'counter') ?? metricNames[0] ?? null
    const row = (name: string, s: TimingSeries): CellContent[] => {
      const v = s.v, lastV = v[v.length - 1]
      const secs = v.length > 1 ? (s.t[s.t.length - 1] - s.t[0]) / 1000 : 0
      const rate = s.kind === 'counter' && secs > 0 ? v.slice(1).reduce((a, b) => a + b, 0) / secs : s.kind === 'gauge' && secs > 0 ? (lastV - v[0]) / secs : NaN
      return [name, s.kind ?? '', s.unit ?? '', { value: lastV, text: f1(lastV) }, { value: Math.min(...v), text: f1(Math.min(...v)) },
        { value: Math.max(...v), text: f1(Math.max(...v)) }, Number.isFinite(rate) ? { value: rate, text: f1(rate) } : '']
    }
    mtab.setTableContent([['Metric', 'Kind', 'Unit', 'Last', 'Min', 'Max', 'Per second'], ...metricNames.map((n) => row(n, tm.metrics[n]))])
    if (picked && tm.metrics[picked]) {
      const s = tm.metrics[picked]
      metricS.setName(picked).clear().appendSamples({ xValues: s.t, yValues: s.v })
      metric.setTitle(`${picked} (${s.kind}${s.unit ? `, ${s.unit}` : ''})`)
    }
    tiles.push({ id: 'metrics', label: 'Metrics', value: String(metricNames.length), sub: 'every heartbeat', status: 'info', source: 'heartbeat' })
    kpi.setTiles(tiles)
    stab.setTableContent([['Thread', 'Used', 'Size', 'Used %'], ...Object.entries(tm.stacks).map(([n, s]): CellContent[] =>
      [n, s.used, s.size, { value: (100 * s.used) / s.size, text: ((100 * s.used) / s.size).toFixed(0) }])])
    ptab.setTableContent([['Time', 'Thread', 'Text'], ...tm.prints.slice(-200).map(([tms, th, text]): CellContent[] =>
      [{ value: tms, text: `${(tms / 1000).toFixed(3)} s` }, th, text])])
  }
  return { render, dispose: () => dash.dispose() }
}
