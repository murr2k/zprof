// SPDX-License-Identifier: Apache-2.0
import { sferic, AxisTickStrategies, BarChartTypes, type CellContent } from 'sferic'
import { addIntervalSeries } from '../charts/IntervalSeries'
import { KpiStrip } from '../charts/KpiStrip'
import { hotFunctions, layout, MODULES, type Module } from '../sim/profile'
import { fill, type View } from './common'
import { dataTable } from '../charts/dataTable'

/** Synthetic call rates for the table (calls per second on the synthetic target). */
const CALLS: Record<string, number> = {
  fir_q15: 1000, iir_biquad_df2t: 1000, pid_update: 1000, ctrl_step: 1000, spi_xfer_fifo: 1000, read_sensors: 1000,
  sensor_decode: 2000, crc16_ccitt: 2000, spi_dma_isr: 2000, k_sem_give: 2000, sys_clock_isr: 1000, sys_clock_announce: 1000,
  qspi_page_program: 64, arch_switch: 7200, z_swap: 5100, zcbor_decode: 350, eth_gem_isr: 350, flash_erase: 0.4,
}
const BUSY_PCT = 30.0
const RATE_HZ = 10_000

export const engineeringProfile: View = ({ container, theme: t }) => {
  const { nodes, all, depth } = layout()
  const modColor = (m: Module) => t.seriesColors[[2, 4, 0, 9, 3, 1, 6, 5][MODULES.indexOf(m)] % t.seriesColors.length]

  const dash = sferic().Dashboard({ container, theme: t, numberOfColumns: 3, numberOfRows: 3, splitterThickness: 4 })
  dash.setRowHeight(0, 0.55).setRowHeight(1, 2.0).setRowHeight(2, 1.45)
  dash.setColumnWidth(0, 1.2).setColumnWidth(1, 1.2).setColumnWidth(2, 1)

  const hot = hotFunctions(nodes, all)
  const samples = all / (BUSY_PCT / 100)
  const WINDOW_S = samples / RATE_HZ
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 3 })
  kpi.setTiles([
    { id: 'src', label: 'Profile source', value: 'Statistical', sub: 'CONFIG_INSTRUMENTATION_MODE_STATISTICAL', status: 'info', source: 'instrumentation' },
    { id: 'n', label: 'Busy samples', value: `${(all / 1000).toFixed(1)}k`, sub: `of ${(samples / 1000).toFixed(0)}k, idle excluded`, status: 'ok' },
    { id: 'win', label: 'Window', value: WINDOW_S.toFixed(1), unit: 's', sub: `${RATE_HZ / 1000} kHz equivalent`, status: 'ok' },
    { id: 'busy', label: 'Busy CPU', value: BUSY_PCT.toFixed(1), unit: '%', sub: 'matches Live heartbeat within 0.4%', status: 'ok', source: 'cross-check' },
    { id: 'top', label: 'Top self time', value: hot[0].name, sub: `${hot[0].selfPct.toFixed(1)}% of busy, ${hot[0].module}`, status: 'info' },
    { id: 'ovh', label: 'Instrumentation cost', value: '4.8', unit: '%', sub: 'instrumented build vs release', status: 'warn', source: 'A/B measured' },
    { id: 'sym', label: 'Symbolized', value: '99.6', unit: '%', sub: 'ELF matched by build ID', status: 'ok', source: 'pyelftools' },
    { id: 'bid', label: 'Build ID', value: '3f9c2e1', sub: 'v1.5.0-rc1, GCC 12.2', status: 'idle', source: 'hello record' },
  ])

  // ---------------------------------------------------------------- flame graph on IntervalSeries
  const fg = dash
    .createChartXY({ columnIndex: 0, rowIndex: 1, columnSpan: 3, legend: { visible: true, position: 'right', addEntriesAutomatically: false } })
    .setTitle('Flame graph: inclusive time by call path (root on top; wheel to zoom into a frame)')
    .setTitleFont((f) => f.setSize(13))
    .setCursorMode('show-nearest')
  fg.axisX.setTitle('Share of busy samples').setUnits('%').setDefaultInterval({ start: 0, end: 100 })
  const states = MODULES.map((m) => ({ name: m, color: modColor(m) }))
  const flame = addIntervalSeries(fg, {
    lanes: Array.from({ length: depth }, (_, i) => `depth ${i}`),
    states,
    lanePad: 0.04,
    labelMinPx: 42,
    tooltip: (h) => {
      const f = nodes.find((n) => n.depth === h.lane && Math.abs(n.x0 - h.t0) < 1e-9)
      if (!f) return []
      return [
        [{ text: f.name, color: h.state.color.setA(255) }],
        ['Module:', f.module],
        ['Inclusive:', `${((f.total / all) * 100).toFixed(2)}% (${f.total} samples)`],
        ['Self:', `${((f.self / all) * 100).toFixed(2)}%`],
        ['Path:', f.path.split(';').slice(-3).join(' > ')],
      ]
    },
  })
  fg.axisY.setTickStrategy(AxisTickStrategies.Empty).setInterval({ start: 0, end: depth, stopAxisAfter: true }).setMouseInteractions(false)
  fg.axisY.setThickness(8)
  for (const f of nodes) flame.append(f.depth, f.x0, f.x1, MODULES.indexOf(f.module), f.name)
  flame.commit()
  // Legend entries per module: one invisible point series each, just for the swatches.
  for (const m of MODULES) {
    const s = fg.addPointSeries().setName(m).setPointFillStyle(fill(modColor(m)))
    s.setCursorEnabled(false)
    fg.legend.add(s)
  }

  // ---------------------------------------------------------------- hot functions table
  const grid = dataTable(dash, { columnIndex: 0, rowIndex: 2, columnSpan: 2 }).setTitle('Hot functions by self time').setTitleFont((f) => f.setSize(13))
  const maxSelf = hot[0].selfPct
  const rows: CellContent[][] = hot.slice(0, 16).map((h) => {
    const calls = CALLS[h.name]
    const avg = calls ? (h.self / all) * (BUSY_PCT / 100) * 1e6 / calls : NaN
    return [
      { text: h.name, textColor: modColor(h.module).setA(255) },
      h.module,
      { value: h.selfPct, text: h.selfPct.toFixed(2), bar: h.selfPct, barMin: 0, barMax: maxSelf, barColor: modColor(h.module).setA(255) },
      h.totalPct.toFixed(2),
      calls ? (calls >= 1 ? calls.toFixed(0) : calls.toFixed(1)) : '',
      Number.isFinite(avg) ? `${avg.toFixed(1)} us` : '',
    ]
  })
  grid.setTableContent([['Function', 'Module', 'Self %', 'Total %', 'Calls/s', 'Avg self/call'], ...rows])
  grid.setColumnWidth(0, { min: 170 }).setCellChangeHighlight(false)

  // ---------------------------------------------------------------- self time by module
  const bymod = MODULES.map((m) => ({ category: m, value: nodes.filter((n) => n.module === m).reduce((a, n) => a + n.self, 0) / all * 100 }))
  dash
    .createBarChart({ columnIndex: 2, rowIndex: 2, type: BarChartTypes.Horizontal, legend: { visible: false } })
    .setTitle('Self time by module (% of busy)')
    .setTitleFont((f) => f.setSize(13))
    .setSorting('descending')
    .setBarsColor((info) => modColor(info.category as Module))
    .setValueLabels({ position: 'after-bar', formatter: (info) => `${info.value.toFixed(1)}%` })
    .setData(bymod)

  return () => dash.dispose()
}
