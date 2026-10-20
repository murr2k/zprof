import { sferic, AxisTickStrategies, BarChartTypes, type CellContent } from 'sferic'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { statusColor, type Status } from '../charts/status'
import { gateRule, ruleStatus } from '../thresholds'
import { gauss, quantile, rng } from '../sim/rng'
import type { View } from './common'

/**
 * Build-to-build regression view: baseline A vs candidate B, same board, same
 * loadgen scenario, same zprof configuration (spec section 6.3). Synthetic data.
 */
const A = 'v1.4.2', B = 'v1.5.0-rc1'
const MODULES = ['kernel', 'arch', 'drivers', 'net', 'app', 'zprof', 'libc', 'logging']
const ROM = { a: [18.2, 6.1, 24.6, 61.3, 22.4, 4.1, 9.8, 7.2], b: [18.3, 6.1, 25.1, 64.8, 27.9, 4.6, 9.8, 7.4] }
const RAM = { a: [9.6, 2.3, 6.8, 21.4, 12.2, 3.1, 1.4, 4.2], b: [9.6, 2.3, 6.9, 25.8, 13.1, 3.4, 1.4, 6.3] }
const THREADS = ['ctrl_loop', 'sensor_rx', 'net_rx', 'storage', 'logging', 'sysworkq', 'zprof']
const CPU = { a: [14.2, 9.4, 1.4, 1.1, 0.9, 0.2, 0.18], b: [15.9, 9.5, 2.9, 1.0, 1.3, 0.2, 0.19] }
const SPANS = [
  { name: 'ctrl_loop response', a: [148, 22, 401], b: [163, 26, 447] },
  { name: 'sensor_rx wake', a: [9, 3, 31], b: [9.5, 3, 33] },
  { name: 'net_rx wake', a: [24, 9, 88], b: [31, 12, 121] },
]
const TWISTER: [string, number, string, string, string, string][] = [
  ['kernel.common', 42, 'pass', 'pass', '+1.2%', ''],
  ['drivers.spi.loopback', 9, 'pass', 'pass', '-0.4%', ''],
  ['app.ctrl.pid', 14, 'pass', 'pass', '+3.1%', ''],
  ['app.proto.parse', 18, 'pass', 'FAIL', '+0.8%', 'test_max_len: assert proto.c:212'],
  ['app.storage.nvs', 11, 'pass', 'pass', '+12.4%', 'qspi_page_program slower'],
  ['net.udp.echo', 16, 'pass', 'pass', '+4.0%', ''],
  ['zprof.framing', 21, 'pass', 'pass', '0.0%', ''],
  ['zprof.heartbeat', 11, 'pass', 'pass', '+0.3%', ''],
]
const KCONFIG: [string, string, string, string][] = [
  ['CONFIG_NET_BUF_RX_COUNT', '32', '48', 'RAM +3.1 KiB'],
  ['CONFIG_PROTO_MAX', '256', '512', 'ties to app.proto FAIL'],
  ['CONFIG_LOG_BUFFER_SIZE', '2048', '4096', 'RAM +2.0 KiB'],
  ['CONFIG_NET_RX_STACK_SIZE', '3072', '3072', 'unchanged; net_rx margin 21% -> 17%'],
  ['CONFIG_ZPROF_HEARTBEAT_MS', '100', '100', ''],
  ['CONFIG_SCHED_THREAD_USAGE_ANALYSIS', 'y', 'y', ''],
]

export const reliabilityCompare: View = ({ container, theme: t }) => {
  const r = rng(99)
  const ca = t.seriesColors[0], cb = t.seriesColors[1]
  const dash = sferic().Dashboard({ container, theme: t, numberOfColumns: 3, numberOfRows: 3, splitterThickness: 4 })
  dash.setRowHeight(0, 0.6).setRowHeight(1, 1.4).setRowHeight(2, 1.2)

  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
  const romA = sum(ROM.a), romB = sum(ROM.b), ramA = sum(RAM.a), ramB = sum(RAM.b)
  const cpuA = sum(CPU.a), cpuB = sum(CPU.b)
  const d = (a: number, b: number) => `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(1)}%`
  const passA = TWISTER.reduce((s, x) => s + x[1], 0)
  const failB = TWISTER.filter((x) => x[3] === 'FAIL').length
  const COV = { a: 78.4, b: 76.9 }, MARGIN = { a: 21, b: 17 }
  // Every status below comes from the gate section of config/zprof.thresholds.json.
  const gate = (metric: string, v: number): Status => {
    const r = gateRule(metric)
    return r ? ruleStatus(r, v) : 'idle'
  }
  const p99 = gateRule('span.ctrl_loop.p99')
  const tiles: KpiTile[] = [
    { id: 'verdict', label: 'Regression gate', value: '', status: 'idle', source: 'thresholds file' },
    { id: 'rom', label: 'ROM', value: romB.toFixed(1), unit: 'KiB', sub: `${d(romA, romB)} vs ${A} (${romA.toFixed(1)})`, status: gate('build.rom', ((romB - romA) / romA) * 100), source: 'build: rom_report' },
    { id: 'ram', label: 'RAM', value: ramB.toFixed(1), unit: 'KiB', sub: `${d(ramA, ramB)} vs ${A} (${ramA.toFixed(1)})`, status: gate('build.ram', ((ramB - ramA) / ramA) * 100), source: 'build: ram_report' },
    { id: 'cpu', label: 'Busy CPU', value: cpuB.toFixed(1), unit: '%', sub: `+${(cpuB - cpuA).toFixed(1)} pt vs ${A}`, status: gate('cpu.busy', cpuB - cpuA), source: 'stats, same scenario' },
    { id: 'p99', label: 'ctrl_loop p99', value: String(SPANS[0].b[2]), unit: 'us', sub: `${d(SPANS[0].a[2], SPANS[0].b[2])}, limit ${p99?.crit ?? '?'} us`, status: gate('span.ctrl_loop.p99', SPANS[0].b[2]), source: 'span' },
    { id: 'stack', label: 'Min stack margin', value: String(MARGIN.b), unit: '%', sub: `net_rx, was ${MARGIN.a}% in ${A}`, status: gate('stack.min_margin', MARGIN.b), source: 'stats (watermark)' },
    { id: 'tests', label: 'Tests', value: `${passA - failB}/${passA}`, sub: `${failB} suite failing in ${B}`, status: gate('test.failed', failB), source: 'twister.json' },
    { id: 'cov', label: 'Line coverage', value: COV.b.toFixed(1), unit: '%', sub: `${(COV.b - COV.a).toFixed(1)} pt vs ${A}`, status: gate('test.coverage', COV.b - COV.a), source: 'gcov via twister' },
  ]
  // The gate summarizes the other tiles: any crit blocks, any warn needs review.
  const nCrit = tiles.slice(1).filter((x) => x.status === 'crit').length
  const nWarn = tiles.slice(1).filter((x) => x.status === 'warn').length
  Object.assign(tiles[0], { value: nCrit ? 'BLOCK' : nWarn ? 'REVIEW' : 'PASS', sub: `${nCrit} over limit, ${nWarn} warnings`, status: nCrit ? 'crit' : nWarn ? 'warn' : 'ok' })
  dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 3 }).setTiles(tiles)

  // Footprint by module, grouped A vs B.
  dash.createBarChart({ columnIndex: 0, rowIndex: 1, type: BarChartTypes.Vertical, legend: { visible: true, position: 'bottom' } })
    .setTitle('ROM by module (KiB)').setTitleFont((f) => f.setSize(13))
    .setPalette([ca, cb])
    .setDataGrouped(MODULES, [{ subCategory: A, values: ROM.a }, { subCategory: B, values: ROM.b }])

  // CPU by thread, grouped.
  dash.createBarChart({ columnIndex: 1, rowIndex: 1, type: BarChartTypes.Vertical, legend: { visible: true, position: 'bottom' } })
    .setTitle('CPU by thread, same scenario (%)').setTitleFont((f) => f.setSize(13))
    .setPalette([ca, cb])
    .setDataGrouped(THREADS, [{ subCategory: A, values: CPU.a }, { subCategory: B, values: CPU.b }])

  // Latency distributions: box plots per span, A vs B.
  const box = dash.createChartXY({ columnIndex: 2, rowIndex: 1, legend: { visible: true, position: 'bottom' } })
    .setTitle('Latency distributions (box = IQR, whiskers = 1.5 IQR)').setTitleFont((f) => f.setSize(13))
  box.axisX.setTickStrategy(AxisTickStrategies.Empty).setThickness(30)
  box.axisY.setTitle('Latency').setUnits('us').setTickStrategy(AxisTickStrategies.Numeric)
  ;[{ name: A, k: 'a' as const, c: 0, off: -0.19 }, { name: B, k: 'b' as const, c: 1, off: 0.19 }].forEach((b) => {
    const s = box.addBoxSeries({ automaticColorIndex: b.c }).setName(b.name).setDefaultStyle((f) => f.setBodyWidth(1).setTailWidth(0.55))
    SPANS.forEach((sp, i) => {
      const [mu, sd, p99] = sp[b.k]
      const xs = Array.from({ length: 4000 }, () => {
        const tailHit = r() < 0.03
        return Math.max(1, mu + gauss(r) * sd * 0.6 + (tailHit ? Math.abs(gauss(r)) * (p99 - mu) * 0.6 : 0))
      }).sort((x, y) => x - y)
      const q1 = quantile(xs, 0.25), q3 = quantile(xs, 0.75), iqr = q3 - q1
      // Normalize each span to its own scale so three spans share one axis: plot as % of ctrl budget.
      s.add({
        x: i + b.off, width: 0.34,
        lowerExtreme: xs.find((v) => v >= q1 - 1.5 * iqr)!, lowerQuartile: q1, median: quantile(xs, 0.5), upperQuartile: q3,
        upperExtreme: [...xs].reverse().find((v) => v <= q3 + 1.5 * iqr)!,
      })
    })
  })
  SPANS.forEach((sp, i) => box.axisX.addCustomTick().setValue(i).setText(sp.name))
  box.axisX.setDefaultInterval({ start: -0.6, end: SPANS.length - 0.4 })
  box.axisY.setDefaultInterval({ start: 0, end: 260 })

  // Test results diff.
  const tw = dash.createDataGrid({ columnIndex: 0, rowIndex: 2, columnSpan: 2 }).setTitle('Test suites (twister.json, same board)').setTitleFont((f) => f.setSize(13))
  const cell = (s: string): CellContent => {
    const st: Status = s === 'FAIL' ? 'crit' : 'ok'
    return { text: s, fill: statusColor(t, st).setA(st === 'ok' ? 50 : 200), textColor: t.titleColor }
  }
  tw.setTableContent([
    ['Suite', 'Cases', A, B, 'Duration', 'Note'],
    ...TWISTER.map(([s, n, a, b, dur, note]) => [s, String(n), cell(a), cell(b), dur, note] as CellContent[]),
  ])
  tw.setColumnWidth(0, { min: 150 }).setCellChangeHighlight(false)

  // Kconfig diff.
  const kc = dash.createDataGrid({ columnIndex: 2, rowIndex: 2 }).setTitle('Kconfig differences').setTitleFont((f) => f.setSize(13))
  kc.setTableContent([['Symbol', A, B, 'Impact'], ...KCONFIG.map((k) => [...k] as CellContent[])])
  kc.setColumnWidth(0, { min: 190 }).setCellChangeHighlight(false)
  KCONFIG.forEach((k, i) => { if (k[1] !== k[2]) kc.setCellTextFillStyle(2, i + 1, t.examples.highlightColor) })

  return () => dash.dispose()
}
