import { sferic, AxisTickStrategies, AxisScrollStrategies, DashedLine, StipplePatterns, type Color } from 'sferic'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { AddressMap, type MapBlock, type MapRegion } from '../charts/AddressMap'
import { HeapXRay } from '../charts/HeapXRay'
import { targetSim, THREADS, TH, IDLE, type Heartbeat } from '../sim/target'
import { REGIONS, HEAP_BASE, type BlockKind } from '../sim/memmap'
import { linfit } from '../sim/rng'
import { level } from '../thresholds'
import { el, segmented } from '../dom'
import { fill, line, threadColor, type View } from './common'

const KIND_SLOT: Record<BlockKind, number> = { data: 1, bss: 2, stack: 4, heap: 5, pool: 6, log: 7, rtt: 9, tunables: 3, retained: 8, free: 0, reserved: 0 }
/** Owners that allocate from the heap in this firmware, in the legend's order. */
const HEAP_OWNERS = [TH.MAIN, TH.NET, TH.STORAGE]

/**
 * Memory: where RAM goes and how the heap behaves. The floor plan is the
 * linker's view with live use; the X-ray is the allocator's view, chunk by
 * chunk; the leak cone projects the leaking owner to exhaustion with the
 * confidence of its trend.
 */
export const engineeringMemory: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const [bad, mid] = t.examples.badGoodColorPalette
  const root = el('div', 'vstack')
  const bar = el('div', 'toolbar')
  const host = el('div', 'fill')
  root.append(bar, host)
  container.appendChild(root)

  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 2, numberOfRows: 4, splitterThickness: 4 })
  dash.setRowHeight(0, 0.5).setRowHeight(1, 1.1).setRowHeight(2, 1).setRowHeight(3, 1)
  dash.setColumnWidth(0, 1.1).setColumnWidth(1, 1)
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 2 })
  const map = dash.createPanel(AddressMap, { columnIndex: 0, rowIndex: 1, columnSpan: 2 })
    .setTitle('RAM floor plan, STM32N6570-DK (regions from the pinned devicetree; long free runs folded; bar = live use, tick = high-water)')
    .setTitleFont((f) => f.setSize(13))
  const xray = dash.createPanel(HeapXRay, { columnIndex: 0, rowIndex: 2, rowSpan: 2 })
    .setTitle('_system_heap X-ray: every 8 B chunk along a Hilbert curve')
    .setTitleFont((f) => f.setSize(13))
  const own = dash.createChartXY({ columnIndex: 1, rowIndex: 2, legend: { visible: true, position: 'right' } })
    .setTitle('Heap by owner (stacked) and largest free run')
    .setTitleFont((f) => f.setSize(13))
  const leak = dash.createChartXY({ columnIndex: 1, rowIndex: 3, legend: { visible: true, position: 'right' } })
    .setTitleFont((f) => f.setSize(13))

  const ownerColor = (i: number): Color => threadColor(t, i).setA(255)
  xray.setHeap(sim.heap, HEAP_BASE, THREADS.map((d, i) => ({ name: d.name, color: ownerColor(i) })))

  // ---------------------------------------------------------------- floor plan with live use
  const kc = (k: BlockKind) => (k === 'rtt' ? t.examples.highlightColor : t.seriesColors[KIND_SLOT[k] % t.seriesColors.length])
  const nocacheStart = REGIONS[0].blocks.find((b) => b.name.startsWith('zprof_nocache'))!.start
  const regions = (h: Heartbeat | null): MapRegion[] => REGIONS.map((r) => ({
    name: r.name, dt: r.dt, base: r.base, size: r.size, attr: r.attr, enabled: r.enabled, note: r.note,
    windows: r.base === REGIONS[0].base
      ? [{ start: nocacheStart, size: 32 * 1024, label: 'MPU NOCACHE window (RTT, tunables)', color: t.examples.highlightColor }]
      : r.enabled && r.attr.includes('NOCACHE') ? [{ start: r.base, size: r.size, label: 'NOCACHE, retained', color: t.examples.highlightColor }] : [],
    blocks: r.blocks.map((b): MapBlock => {
      const ti = b.live?.startsWith('stack:') && b.live !== 'stack:isr' ? Number(b.live.slice(6)) : -1
      const m: MapBlock = { name: b.name, start: b.start, size: b.size, color: ti >= 0 ? ownerColor(ti) : kc(b.kind), note: b.note, kind: b.kind }
      if (!h || !b.live) return m
      if (b.live === 'heap') { m.used = h.heap.alloc; m.peak = h.heap.maxAlloc }
      else if (b.live === 'slab') { m.used = h.slab.used * 1536; m.peak = h.slab.maxUsed * 1536 }
      else if (b.live === 'log') { m.used = h.logBuf.used; m.peak = h.logBuf.peak }
      else if (b.live === 'rtt') { m.used = h.rttUp.used; m.peak = h.rttUp.peak }
      else if (b.live === 'stack:isr') { m.used = 910; m.peak = 1104 }
      else if (b.live.startsWith('stack:')) { const s = h.threads[Number(b.live.slice(6))]; m.used = s.stackUsed; m.peak = s.stackHwm }
      return m
    }),
  }))

  // ---------------------------------------------------------------- heap by owner over time
  own.axisX.setTickStrategy(AxisTickStrategies.Time).setScrollStrategy(AxisScrollStrategies.scrolling)
    .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - 60_000, stopAxisAfter: false }))
  own.axisY.setTitle('Heap').setUnits('KiB').setDefaultInterval({ start: 0, end: 24 })
  own.axisY.addConstantLine(true).setValue(24).setStrokeStyle(line(bad, 1.5))
  const bands = HEAP_OWNERS.map((i) => own.addAreaRangeSeries().setName(THREADS[i].name).setMaxSampleCount(900)
    .setAreaFillStyle(fill(ownerColor(i).setA(130))).setStrokeStyle(line(ownerColor(i), 1)))
  const hdrBand = own.addAreaRangeSeries().setName('headers, others').setMaxSampleCount(900)
    .setAreaFillStyle(fill(t.minorTickLabelColor.setA(90))).setStrokeStyle(line(t.minorTickLabelColor, 1))
  const lf = own.addLineSeries({ automaticColorIndex: 3 }).setName('largest free run').setMaxSampleCount(900)
  lf.setStrokeStyle(new DashedLine({ thickness: 1.5, fillStyle: fill(t.examples.highlightColor), pattern: StipplePatterns.Dashed }))
  const pushOwn = (h: Heartbeat) => {
    let acc = 0
    const x = [h.t]
    HEAP_OWNERS.forEach((i, k) => {
      const lo = acc
      acc += h.heap.byOwner[i] / 1024
      bands[k].appendSamples({ xValues: x, yValues: [acc], lowValues: [lo] })
    })
    hdrBand.appendSamples({ xValues: x, yValues: [h.heap.alloc / 1024], lowValues: [acc] })
    lf.appendSamples({ xValues: x, yValues: [h.heap.largestFree / 1024] })
  }

  // ---------------------------------------------------------------- leak cone
  leak.axisX.setTickStrategy(AxisTickStrategies.Time)
  leak.axisY.setTitle('main live').setUnits('KiB')
  const hist = leak.addPointSeries({ automaticColorIndex: 1 }).setName('main, live bytes').setMaxSampleCount(2000)
  hist.setPointFillStyle(fill(ownerColor(TH.MAIN))).setPointSize(3)
  const fit = leak.addLineSeries({ automaticColorIndex: 1 }).setName('trend (OLS)')
  fit.setStrokeStyle(line(ownerColor(TH.MAIN), 2))
  const cone = leak.addAreaRangeSeries().setName('95% band')
  cone.setAreaFillStyle(fill(mid.setA(60))).setStrokeStyle(line(mid.setA(160), 1))
  const room = leak.axisY.addConstantLine(true).setStrokeStyle(line(bad, 1.5))
  let eta = { mins: NaN, lo: NaN, hi: NaN, slope: 0 }
  const refreshLeak = () => {
    const hb = sim.heartbeats
    if (hb.length < 50) return
    const win = hb.slice(-600)
    const xs = win.map((h) => (h.t - win[0].t) / 1000), ys = win.map((h) => h.heap.byOwner[TH.MAIN])
    const f = linfit(xs, ys)
    const last = win[win.length - 1]
    const roomB = last.heap.size - (last.heap.alloc - last.heap.byOwner[TH.MAIN])
    const now = last.t, cur = f.a + f.b * xs[xs.length - 1]
    const s = Math.max(1e-6, f.b), sLo = Math.max(1e-6, f.b - f.ci95), sHi = f.b + f.ci95
    eta = { mins: (roomB - cur) / s / 60, lo: (roomB - cur) / sHi / 60, hi: f.b - f.ci95 > 0 ? (roomB - cur) / sLo / 60 : Infinity, slope: f.b }
    const horizon = Math.min(Number.isFinite(eta.hi) ? eta.hi : eta.mins * 2, 240) * 60_000
    hist.clear().appendSamples({ xValues: win.map((h) => h.t), yValues: ys.map((v) => v / 1024) })
    const xsF = [now, now + horizon]
    fit.clear().appendSamples({ xValues: xsF, yValues: xsF.map((x) => (cur + f.b * (x - now) / 1000) / 1024) })
    const N = 24
    const cx = Array.from({ length: N + 1 }, (_, i) => now + (horizon * i) / N)
    cone.clear().appendSamples({
      xValues: cx,
      lowValues: cx.map((x) => (cur + Math.max(0, f.b - f.ci95) * (x - now) / 1000) / 1024),
      yValues: cx.map((x) => (cur + (f.b + f.ci95) * (x - now) / 1000) / 1024),
    })
    room.setValue(roomB / 1024)
    leak.axisX.setInterval({ start: win[0].t, end: now + horizon, stopAxisAfter: true })
    leak.axisY.setInterval({ start: 0, end: (roomB / 1024) * 1.08, stopAxisAfter: true })
    const etaTxt = Number.isFinite(eta.mins) && f.b > 0 ? `heap exhausted in ${eta.mins.toFixed(0)} min (95%: ${eta.lo.toFixed(0)} to ${Number.isFinite(eta.hi) ? eta.hi.toFixed(0) : 'never'})` : 'no significant growth'
    leak.setTitle(`Leak cone: main grows ${f.b.toFixed(1)} +/- ${f.ci95.toFixed(1)} B/s; ${etaTxt}`)
  }

  // ---------------------------------------------------------------- KPIs
  const staticRam = REGIONS[0].blocks.reduce((a, b) => a + b.size, 0)
  const refreshKpi = (h: Heartbeat) => {
    const worst = h.threads.filter((_, i) => i !== IDLE).map((s) => ({ name: s.name, m: (1 - s.stackHwm / s.stackSize) * 100 })).sort((a, b) => a.m - b.m)[0]
    const tiles: KpiTile[] = [
      { id: 'ram', label: 'Static RAM', value: (staticRam / 1024).toFixed(0), unit: 'KiB', sub: `of 2048 KiB zephyr,sram (${((staticRam / 2097152) * 100).toFixed(1)}%)`, status: 'info', source: 'linker map' },
      { id: 'heap', label: 'Heap in use', value: (h.heap.alloc / 1024).toFixed(1), unit: '/ 24 KiB', sub: `peak ${(h.heap.maxAlloc / 1024).toFixed(1)} KiB`, status: level('heap._system_heap.peak_pct', (h.heap.maxAlloc / h.heap.size) * 100), source: 'k_heap trace' },
      { id: 'lf', label: 'Largest free run', value: (h.heap.largestFree / 1024).toFixed(1), unit: 'KiB', sub: `of ${((h.heap.size - h.heap.alloc) / 1024).toFixed(1)} KiB free`, status: 'info', source: 'allocator map' },
      { id: 'frag', label: 'Fragmentation', value: (h.heap.frag * 100).toFixed(0), unit: '%', sub: '1 - largest / free', status: level('heap._system_heap.frag_pct', h.heap.frag * 100), source: 'allocator map' },
      { id: 'leak', label: 'main heap growth', value: eta.slope.toFixed(1), unit: 'B/s', sub: Number.isFinite(eta.mins) && eta.slope > 0 ? `exhausted in ~${eta.mins.toFixed(0)} min` : 'stable', status: level('heap.main.growth', eta.slope), source: 'OLS, 60 s' },
      { id: 'fail', label: 'Failed allocations', value: String(h.heap.failures), sub: 'since boot', status: level('heap._system_heap.failures', h.heap.failures), source: 'k_heap trace' },
      { id: 'stack', label: 'Min stack margin', value: worst.m.toFixed(0), unit: '%', sub: worst.name, status: level(`stack.${worst.name}.margin`, worst.m), source: 'stats (watermark)' },
      { id: 'rtt', label: 'RTT up 1 peak', value: ((h.rttUp.peak / h.rttUp.size) * 100).toFixed(0), unit: '%', sub: 'in the NOCACHE window', status: level('trace.buf.peak_pct', (h.rttUp.peak / h.rttUp.size) * 100), source: 'agent' },
    ]
    kpi.setTiles(tiles)
  }

  for (const h of sim.heartbeats) pushOwn(h)
  let lastHb: Heartbeat | null = sim.heartbeats[sim.heartbeats.length - 1] ?? null
  refreshLeak()
  if (lastHb) { refreshKpi(lastHb); map.setRegions(regions(lastHb)) }
  let n = 0
  const offHb = sim.onHeartbeat((h) => {
    lastHb = h
    pushOwn(h)
    if (n++ % 3 === 0) map.setRegions(regions(h))
    if (n % 5 === 0) refreshKpi(h)
    if (n % 20 === 0) refreshLeak()
  })
  const xrayTimer = setInterval(() => { xray.setNow(sim.now / 1000); xray.requestRender() }, 100)

  // ---------------------------------------------------------------- toolbar
  const mode = segmented<'owner' | 'age'>([['owner', 'Owner'], ['age', 'Allocation age']], 'owner', (m) => xray.setMode(m))
  bar.append(el('span', 'note', 'X-ray color'), mode.el, el('span', 'sep'),
    el('span', 'note', 'Heap map rebuilt on the host from k_heap alloc / free trace events (address, size, calling thread): no target memory reads'),
    el('span', 'grow'), el('span', 'note', 'leak rule: heap.*.growth in the thresholds file'))

  return () => {
    clearInterval(xrayTimer)
    offHb()
    dash.dispose()
  }
}
