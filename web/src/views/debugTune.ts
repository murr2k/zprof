import { sferic, AxisTickStrategies, DashedLine, StipplePatterns, SolidLine, emptyLine, type CellContent } from 'sferic'
import type { PointLineAreaSeries } from 'sferic/xy/series/PointLineAreaSeries'
import type { ConstantLine, CustomTick } from 'sferic/xy/Axis'
import { KpiStrip } from '../charts/KpiStrip'
import { targetSim, AP, PARAMS, TH, CTRL_BUDGET_US, OB, type Job, type ParamDef, type ParamReq } from '../sim/target'
import { REGIONS, hex } from '../sim/memmap'
import { quantile } from '../sim/rng'
import { level, liveRule } from '../thresholds'
import { takeFocus } from '../nav'
import { button, el, esc, glyph, segmented } from '../dom'
import { fmtFull } from '../charts/SequenceTrace'
import { fill, line, type View } from './common'

const ARM_S = 120
const PERSIST = 5
type Trigger = 'step' | 'miss' | 'roll'

interface StepMetrics { t: number; from: number; to: number; os: number; rise: number; settle: number; iae: number; kp: number; ki: number }

/**
 * Watch & Tune: debugger territory, done the safe way. Parameters live in the
 * agent's registry; a write goes down RTT, is range-checked by the agent,
 * staged, and applied by the owning thread at its safe point, and the ack
 * comes back with the target time it took effect. The scope triggers on
 * setpoint steps or deadline misses with persistence, the step table measures
 * each response, and the box plot compares timing before and after the last
 * change.
 */
export const debugTune: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const [bad, mid] = t.examples.badGoodColorPalette
  const root = el('div', 'hsplit')
  const side = el('div', 'tune')
  const right = el('div', 'fill')
  const rv = el('div', 'vstack')
  const bar = el('div', 'toolbar')
  const host = el('div', 'fill')
  rv.append(bar, host)
  right.append(rv)
  root.append(side, right)
  container.appendChild(root)

  // ---------------------------------------------------------------- write path
  let probe = false
  const secPath = el('div', 'sec')
  secPath.innerHTML = '<h4>Write path</h4>'
  const pathNote = el('div', 'notice info')
  const probeTbl = el('table', 'watch')
  const pathSeg = segmented<'agent' | 'probe'>([['agent', 'Agent registry (RTT down 1)'], ['probe', 'Probe MEM-AP direct']], 'agent', (v) => { probe = v === 'probe'; renderPath(); refreshRows() })
  secPath.append(pathSeg.el, pathNote)
  const nocache = REGIONS[0].blocks.find((b) => b.name === 'zprof tunables block')!.start
  const watchBlk = REGIONS[0].blocks.find((b) => b.name === 'zprof watch block')!.start
  const bss = REGIONS[0].blocks.find((b) => b.kind === 'bss')!.start
  const PROBE_VARS = [
    { name: 'g_ctrl.kp', type: 'float', addr: bss + 0x2a0, where: '.bss, D-cached', risk: 'crit' as const, get: () => sim.param('ctrl.kp') },
    { name: 'g_ctrl.integ', type: 'float', addr: bss + 0x2a8, where: '.bss, D-cached', risk: 'crit' as const, get: () => sim.watch.integ[sim.watch.slot(sim.watch.total - 1)] },
    { name: 'zprof_param[0].value', type: 'float', addr: nocache + 0x10, where: 'nocache, seqlock', risk: 'warn' as const, get: () => sim.param('ctrl.kp') },
    { name: 'zprof_watch.speed', type: 'float', addr: watchBlk + 0x08, where: 'nocache', risk: 'ok' as const, get: () => sim.watch.pv[sim.watch.slot(sim.watch.total - 1)] },
  ]
  const renderPath = () => {
    pathNote.className = probe ? 'notice' : 'notice info'
    pathNote.innerHTML = probe
      ? `${glyph('warn')} Probe writes go straight to RAM through the M55 AHB-AP (AP1), with no range check and no safe point. A write to a D-cached variable can be lost when a dirty line is evicted over it; a value wider than 32 bits can tear; a variable the compiler keeps in a register never sees it. This mockup reads through the probe but does not write; registry parameters stay on the agent path.`
      : `${glyph('info')} The agent range-checks each value, stages it, and the owning thread applies it at its safe point (seqlock per entry). The ack carries the target time it took effect, and every write lands in the recording as a trace event.`
    probeTbl.innerHTML = probe
      ? '<tr><td><b>Symbol</b></td><td><b>Address</b></td><td class="v"><b>Value</b></td><td></td></tr>' +
        PROBE_VARS.map((v) => `<tr><td class="mono">${v.name}</td><td class="mono">${hex(v.addr)}</td><td class="v" data-probe="${v.name}"></td><td class="src">${glyph(v.risk)} ${v.where}</td></tr>`).join('')
      : ''
    if (probe) pathNote.after(probeTbl)
    else probeTbl.remove()
  }
  renderPath()

  // ---------------------------------------------------------------- arming
  let armedUntil = 0
  const secArm = el('div', 'sec')
  secArm.innerHTML = '<h4>Safety</h4>'
  const armRow = el('div', 'arm')
  const sw = el('button', 'switch')
  sw.title = 'Arm parameter writes'
  const armText = el('span')
  const revertAll = button('Revert all to defaults', () => {
    for (const p of PARAMS) if (sim.param(p.id) !== p.def) send(p, p.def)
  }, 'btn', 'Send the default for every changed parameter')
  armRow.append(sw, armText, el('span', 'grow'), revertAll)
  secArm.append(armRow)
  sw.onclick = () => { armedUntil = armed() ? 0 : performance.now() + ARM_S * 1000; refreshRows() }
  const armed = () => performance.now() < armedUntil

  // ---------------------------------------------------------------- parameter rows
  const secP = el('div', 'sec')
  const banner = el('div', 'notice info')
  banner.hidden = true
  secP.innerHTML = '<h4>Parameters <span class="grow"></span><span>agent registry, 8 entries</span></h4>'
  secP.append(banner)
  interface Row { p: ParamDef; row: HTMLElement; cur: HTMLElement; num: HTMLInputElement | HTMLSelectElement; range: HTMLInputElement | null; apply: HTMLButtonElement; st: HTMLElement; last: ParamReq | null }
  const fmtV = (p: ParamDef, v: number) => (p.options ? p.options[v] ?? String(v) : p.kind === 'bool' ? (v ? 'on' : 'off') : p.kind === 'f32' ? String(Number(v.toFixed(5))) : String(v))
  const rows: Row[] = PARAMS.map((p) => {
    const row = el('div', 'prow')
    row.innerHTML = `<div class="top"><span class="name">${esc(p.label)}</span><span class="id mono">${p.id}</span><span class="cur"></span></div>`
    const cur = row.querySelector('.cur') as HTMLElement
    const ctl = el('div', 'ctl')
    let num: HTMLInputElement | HTMLSelectElement
    let range: HTMLInputElement | null = null
    if (p.options || p.kind === 'bool') {
      const s = el('select')
      ;(p.options ?? ['off (k_sem)', 'on (k_mutex)']).forEach((o, i) => { const op = el('option', '', o); op.value = String(i); s.appendChild(op) })
      num = s
    } else {
      range = el('input')
      range.type = 'range'
      range.min = String(p.min); range.max = String(p.max); range.step = String(p.step)
      const n = el('input')
      n.type = 'number'
      n.min = String(p.min); n.max = String(p.max); n.step = String(p.step)
      num = n
      range.oninput = () => { n.value = range!.value; dirty(r) }
      ctl.append(range)
    }
    num.value = String(sim.param(p.id))
    const apply = button('Apply', () => { const v = Number(r.num.value); if (valid(p, v)) send(p, v) }, 'btn primary', 'Send to the agent')
    ctl.append(num, apply)
    const st = el('div', 'st')
    const safe = el('div', 'safe', `${esc(p.unit ? `${p.unit}, ` : '')}${p.min} to ${p.max}; applied at ${esc(p.safePoint)}`)
    row.append(ctl, st, safe)
    secP.append(row)
    const r: Row = { p, row, cur, num, range, apply, st, last: null }
    num.oninput = () => { if (range) range.value = num.value; dirty(r) }
    num.onchange = num.oninput
    return r
  })
  const valid = (p: ParamDef, v: number) => Number.isFinite(v) && v >= p.min && v <= p.max && (p.kind === 'f32' || Number.isInteger(v))
  const dirty = (r: Row) => { r.row.classList.toggle('dirty', Number(r.num.value) !== sim.param(r.p.id)); refreshRow(r) }
  const send = (p: ParamDef, v: number) => {
    if (!armed() || probe) return
    const r = rows.find((x) => x.p === p)!
    r.last = sim.setParam(p.id, v)
    armedUntil = performance.now() + ARM_S * 1000
    refreshRows()
  }
  const refreshRow = (r: Row) => {
    const v = sim.param(r.p.id)
    r.cur.innerHTML = `${esc(fmtV(r.p, v))} <span class="id">${esc(r.p.unit)}</span>`
    const want = Number(r.num.value)
    r.apply.disabled = !armed() || probe || !valid(r.p, want) || want === v
    r.apply.title = probe ? 'Registry writes use the agent path' : !armed() ? 'Arm writes first' : !valid(r.p, want) ? `Outside ${r.p.min}..${r.p.max}` : ''
    const q = r.last
    if (!q) { r.st.textContent = ''; return }
    const ms = (x: number) => `${((x - q.tSent)).toFixed(1)} ms`
    const acked = sim.now / 1000 >= q.tAck
    r.st.innerHTML = q.state === 'rejected' ? `${glyph('crit')} rejected by the agent: ${esc(q.reason)}`
      : q.state === 'sent' ? `${glyph('idle')} sent ${fmtV(r.p, q.to)}, waiting for the agent`
      : q.state === 'staged' ? `${glyph('warn')} staged after ${ms(q.tStaged)}, waiting for ${esc(r.p.safePoint)}`
      : `${glyph('ok')} applied after ${ms(q.tApplied)}${acked ? `, ack ${ms(q.tAck)}` : ''} at ${fmtFull(q.tApplied).slice(-14)}`
  }
  const refreshRows = () => {
    const left = Math.max(0, (armedUntil - performance.now()) / 1000)
    sw.classList.toggle('on', armed())
    armText.innerHTML = probe ? 'Probe path: registry writes off' : armed() ? `<b>Armed</b>, ${left.toFixed(0)} s left` : 'Writes disarmed'
    revertAll.disabled = !armed() || probe
    for (const r of rows) refreshRow(r)
  }
  const offParam = sim.onParam((q) => {
    const r = rows.find((x) => x.p.id === q.id)
    if (!r) return
    if (!r.last || r.last.seq <= q.seq) r.last = q
    if (q.state === 'applied') { r.num.value = String(sim.param(q.id)); if (r.range) r.range.value = r.num.value; r.row.classList.remove('dirty') }
    refreshRow(r)
  })

  // ---------------------------------------------------------------- watch list and audit
  const secW = el('div', 'sec')
  secW.innerHTML = '<h4>Watch <span class="grow"></span><span>agent samples, target time</span></h4>'
  const wt = el('table', 'watch')
  secW.append(wt)
  const secA = el('div', 'sec')
  secA.innerHTML = '<h4>Audit trail <span class="grow"></span><span>every request, this session</span></h4>'
  const at = el('table', 'audit')
  secA.append(at)
  side.append(secPath, secArm, secP, secW, secA)

  const refreshSide = () => {
    const W = sim.watch, k = W.slot(W.total - 1)
    const sq = sim.objectState(OB.SAMPLE_Q)
    const wrows: [string, string, string][] = [
      ['plant speed (measured)', `${W.pv[k].toFixed(1)} rpm`, 'ctrl_loop'],
      ['setpoint', `${W.sp[k].toFixed(0)} rpm`, 'ctrl_loop'],
      ['error', `${W.e[k].toFixed(1)} rpm`, 'ctrl_loop'],
      ['output', `${W.u[k].toFixed(1)} %`, 'ctrl_loop'],
      ['integrator', `${W.integ[k].toFixed(2)}`, 'ctrl_loop'],
      ['sample_q depth', `${sq.depth} / 8`, 'k_msgq'],
      ['bus lock', sim.busIsMutex ? 'bus_mtx (k_mutex)' : 'bus_lock (k_sem)', 'storage.bus_mutex'],
    ]
    wt.innerHTML = wrows.map(([n, v, s]) => `<tr><td>${n}</td><td class="v">${v}</td><td class="src">${s}</td></tr>`).join('')
    if (probe) for (const v of PROBE_VARS) { const c = probeTbl.querySelector(`[data-probe="${v.name}"]`); if (c) c.textContent = Number(v.get()).toFixed(3) }
    const reqs = sim.audit.slice(-10).reverse()
    at.innerHTML = '<tr><th>Sent</th><th>Parameter</th><th>Change</th><th>State</th><th class="num">RTT</th></tr>' + (reqs.length
      ? reqs.map((q) => {
        const p = PARAMS.find((x) => x.id === q.id)!
        const g = q.state === 'applied' ? 'ok' : q.state === 'rejected' ? 'crit' : 'warn'
        const rt = q.tAck === q.tAck && sim.now / 1000 >= q.tAck ? `${(q.tAck - q.tSent).toFixed(1)} ms` : ''
        return `<tr><td>${fmtFull(q.tSent).slice(3, 12)}</td><td class="mono">${q.id}</td><td>${esc(fmtV(p, q.from))} &rarr; ${esc(fmtV(p, q.to))}</td><td>${glyph(g)} ${q.state}</td><td class="num">${rt}</td></tr>`
      }).join('')
      : '<tr><td colspan="5" class="src">No writes yet. Arm, change a value, Apply.</td></tr>')
  }

  // ---------------------------------------------------------------- charts
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 2, numberOfRows: 3, splitterThickness: 4 })
  dash.setRowHeight(0, 0.55).setRowHeight(1, 1.9).setRowHeight(2, 1.3)
  dash.setColumnWidth(0, 1.35).setColumnWidth(1, 1)
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 2 })
  const scope = dash.createChartXY({ columnIndex: 0, rowIndex: 1, columnSpan: 2, legend: { visible: true, position: 'right' } }).setTitleFont((f) => f.setSize(13))
  const steps = dash.createDataGrid({ columnIndex: 0, rowIndex: 2 }).setTitle('Step response per setpoint step (measured speed, from watch samples)').setTitleFont((f) => f.setSize(13))
  steps.setCellChangeHighlight(false)
  const box = dash.createChartXY({ columnIndex: 1, rowIndex: 2, legend: { visible: false } }).setTitleFont((f) => f.setSize(13))

  scope.axisX.setTitle('Time from trigger').setUnits('ms')
  scope.axisY.setTitle('Speed').setUnits('rpm').setDefaultInterval({ start: 1050, end: 2000 })
  const yU = scope.addAxisY({ opposite: true }).setTitle('Output').setUnits('%').setDefaultInterval({ start: 0, end: 100 })
  const sc = t.seriesColors
  const ghosts: PointLineAreaSeries[] = []
  for (let i = 0; i < PERSIST; i++) {
    const s = scope.addLineSeries({ automaticColorIndex: 0 }).setName(i === 0 ? 'previous sweeps' : '')
    s.setStrokeStyle(line(sc[0].setA(26 + i * 16), 1.2)).setCursorEnabled(false)
    if (i > 0) scope.legend.remove(s)
    ghosts.push(s)
  }
  const spS = scope.addLineSeries({ automaticColorIndex: 3 }).setName('setpoint')
  spS.setStrokeStyle(new DashedLine({ thickness: 1.5, fillStyle: fill(t.tickLabelColor), pattern: StipplePatterns.Dashed }))
  const pvS = scope.addLineSeries({ automaticColorIndex: 0 }).setName('speed (measured)')
  pvS.setStrokeStyle(line(sc[0], 2.2))
  const uS = scope.addLineSeries({ axisY: yU, automaticColorIndex: 6 }).setName('output %')
  uS.setStrokeStyle(line(sc[6 % sc.length].setA(200), 1.2))
  const markLines: ConstantLine[] = []
  const markTicks: CustomTick[] = []

  box.setTitle('ctrl_loop response before and after the last change')
  box.axisX.setTickStrategy(AxisTickStrategies.Empty).setDefaultInterval({ start: -0.6, end: 1.6 }).setMouseInteractions(false)
  box.axisY.setTitle('Response').setUnits('us')
  box.axisY.addConstantLine(true).setValue(CTRL_BUDGET_US).setStrokeStyle(line(bad, 1.5))
  const boxS = box.addBoxSeries({ automaticColorIndex: 0 })
  const boxTicks = [box.axisX.addCustomTick().setValue(0).setText('before').setGridStrokeStyle(emptyLine), box.axisX.addCustomTick().setValue(1).setText('after').setGridStrokeStyle(emptyLine)]

  // ---------------------------------------------------------------- scope sweeps
  let trig: Trigger = 'step'
  let running = true
  let single = false
  let winMs = 500
  let lastTrig = NaN
  const sweeps: { x: number[]; pv: number[]; dir: number }[] = []
  const triggerTime = (): number | null => {
    const W = sim.watch
    const newest = W.t[W.slot(W.total - 1)]
    const post = winMs * 0.8
    if (trig === 'roll') return newest
    if (trig === 'step') {
      for (let i = sim.steps.length - 1; i >= 0; i--) if (sim.steps[i].t + post <= newest) return sim.steps[i].t
      return null
    }
    const E = sim.events
    for (let id = E.total - 1; id >= E.oldest && id > E.total - 60000; id--) {
      const k = id & (E.cap - 1)
      if (E.api[k] === AP.MISS && E.t[k] + post <= newest) return E.t[k]
    }
    return null
  }
  const sweep = (tt: number) => {
    const W = sim.watch
    const pre = trig === 'roll' ? winMs : winMs * 0.2, post = trig === 'roll' ? 0 : winMs * 0.8
    const x: number[] = [], pv: number[] = [], sp: number[] = [], u: number[] = []
    for (let id = W.lowerBound(tt - pre); id < W.total; id++) {
      const k = W.slot(id)
      if (W.t[k] > tt + post) break
      x.push(W.t[k] - tt); pv.push(W.pv[k]); sp.push(W.sp[k]); u.push(W.u[k])
    }
    pvS.clear().appendSamples({ xValues: x, yValues: pv })
    spS.clear().appendSamples({ xValues: x, yValues: sp })
    uS.clear().appendSamples({ xValues: x, yValues: u })
    if (trig !== 'roll') {
      // Persistence overlays like with like: up-steps over up-steps, down over down.
      const step = trig === 'step' ? sim.steps.find((s) => s.t === tt) : undefined
      const dir = step ? Math.sign(step.to - step.from) : 0
      sweeps.push({ x, pv, dir })
      if (sweeps.length > 2 * PERSIST + 2) sweeps.shift()
      const old = sweeps.slice(0, -1).filter((s) => s.dir === dir).slice(-PERSIST)
      ghosts.forEach((g, i) => { g.clear(); const s = old[old.length - PERSIST + i]; if (s) g.appendSamples({ xValues: s.x, yValues: s.pv }) })
    } else ghosts.forEach((g) => g.clear())
    scope.axisX.setInterval({ start: -pre, end: post, stopAxisAfter: false })
    // Parameter changes inside the sweep.
    for (const m of markLines) scope.axisX.removeMarker(m)
    for (const m of markTicks) scope.axisX.removeMarker(m)
    markLines.length = 0
    markTicks.length = 0
    for (const q of sim.audit) {
      if (q.state !== 'applied' || q.tApplied < tt - pre || q.tApplied > tt + post) continue
      const xv = q.tApplied - tt
      markLines.push(scope.axisX.addConstantLine(true).setValue(xv).setStrokeStyle(new SolidLine({ thickness: 1.5, fillStyle: fill(t.examples.highlightColor) })))
      markTicks.push(scope.axisX.addCustomTick().setValue(xv).setText(`${q.id} ${fmtV(PARAMS.find((p) => p.id === q.id)!, q.to)}`))
    }
    const what = trig === 'step' ? 'setpoint step' : trig === 'miss' ? 'deadline miss' : 'roll'
    scope.setTitle(`Scope: speed loop, trigger ${what}${trig !== 'roll' ? ` at ${fmtFull(tt).slice(-14)}` : ''}${running ? '' : ' (stopped)'}`)
  }

  // ---------------------------------------------------------------- step metrics, before / after
  const paramAt = (id: string, tm: number) => {
    let v = PARAMS.find((p) => p.id === id)!.def
    for (const q of sim.audit) if (q.state === 'applied' && q.id === id && q.tApplied <= tm) v = q.to
    return v
  }
  const metrics = (s: { t: number; from: number; to: number }): StepMetrics | null => {
    const W = sim.watch
    const d = s.to - s.from, dir = Math.sign(d), mag = Math.abs(d)
    let peak = s.from, t10 = NaN, t90 = NaN, lastOut = 0, iae = 0, prevT = s.t, n = 0
    for (let id = W.lowerBound(s.t); id < W.total; id++) {
      const k = W.slot(id)
      const tm = W.t[k]
      if (tm > s.t + 700) break
      const v = W.pv[k]
      n++
      if (dir * (v - peak) > 0) peak = v
      const prog = dir * (v - s.from)
      if (!(t10 === t10) && prog >= 0.1 * mag) t10 = tm
      if (!(t90 === t90) && prog >= 0.9 * mag) t90 = tm
      if (Math.abs(v - s.to) > 0.02 * mag) lastOut = tm - s.t
      iae += Math.abs(s.to - v) * (tm - prevT) / 1000
      prevT = tm
    }
    if (n < 100) return null
    return { t: s.t, from: s.from, to: s.to, os: Math.max(0, (dir * (peak - s.to)) / mag) * 100, rise: t90 - t10, settle: lastOut, iae, kp: paramAt('ctrl.kp', s.t), ki: paramAt('ctrl.ki', s.t) }
  }
  let lastMetrics: StepMetrics[] = []
  const refreshSteps = () => {
    const newest = sim.watch.t[sim.watch.slot(sim.watch.total - 1)]
    lastMetrics = sim.steps.filter((s) => s.t + 700 <= newest).slice(-10).map(metrics).filter((m): m is StepMetrics => !!m).reverse()
    const head = ['Step at', 'rpm', 'Overshoot', 'Rise 10-90', 'Settle 2%', 'IAE', 'Kp', 'Ki']
    const osR = liveRule('ctrl.overshoot_pct'), stR = liveRule('ctrl.settle_ms')
    const tint = (s: string) => (s === 'crit' ? bad.setA(150) : s === 'warn' ? mid.setA(150) : undefined)
    steps.setTableContent([head, ...lastMetrics.map((m): CellContent[] => [
      fmtFull(m.t).slice(3, 12), `${m.from} > ${m.to}`, `${m.os.toFixed(1)}%`, `${m.rise.toFixed(0)} ms`, `${m.settle.toFixed(0)} ms`, m.iae.toFixed(1), String(m.kp), String(m.ki),
    ])])
    lastMetrics.forEach((m, i) => {
      steps.setCellBackgroundFillStyle(2, i + 1, osR ? tint(level('ctrl.overshoot_pct', m.os)) : undefined)
      steps.setCellBackgroundFillStyle(4, i + 1, stR ? tint(level('ctrl.settle_ms', m.settle)) : undefined)
    })
  }
  const refreshBox = () => {
    const q = [...sim.audit].reverse().find((x) => x.state === 'applied')
    boxS.clear()
    if (!q) { box.setTitle('ctrl_loop response before and after the last change (no change yet)'); return }
    const now = sim.now / 1000
    const pick = (a: number, b: number) => sim.jobs.filter((j: Job) => j.thread === TH.CTRL && j.release >= a && j.release < b).map((j) => j.resp).sort((x, y) => x - y)
    const before = pick(q.tApplied - 3000, q.tApplied)
    const after = pick(q.tApplied + 200, Math.min(now, q.tApplied + 3200))
    const add = (xs: number[], x: number) => {
      if (xs.length < 20) return
      const q1 = quantile(xs, 0.25), q3 = quantile(xs, 0.75)
      boxS.add({ x, width: 0.42, lowerExtreme: quantile(xs, 0.005), lowerQuartile: q1, median: quantile(xs, 0.5), upperQuartile: q3, upperExtreme: xs[xs.length - 1] })
    }
    add(before, 0)
    add(after, 1)
    const p = PARAMS.find((x) => x.id === q.id)!
    boxTicks[0].setText(`before: p99 ${quantile(before, 0.99).toFixed(0)} us`)
    boxTicks[1].setText(after.length >= 20 ? `after: p99 ${quantile(after, 0.99).toFixed(0)} us` : 'after: collecting')
    box.setTitle(`ctrl_loop response, 3 s before and after ${q.id} ${fmtV(p, q.from)} > ${fmtV(p, q.to)}`)
  }
  const refreshKpi = () => {
    const W = sim.watch, k = W.slot(W.total - 1)
    const m = lastMetrics[0]
    const now = sim.now / 1000
    const recent = sim.jobs.filter((j) => j.thread === TH.CTRL && j.end > now - 10_000)
    const resp = recent.map((j) => j.resp).sort((a, b) => a - b)
    const p99 = quantile(resp, 0.99)
    const inv = recent.filter((j) => j.inv > 0).length
    const miss = recent.filter((j) => j.miss).length
    kpi.setTiles([
      { id: 'pv', label: 'Speed', value: W.pv[k].toFixed(0), unit: 'rpm', sub: `setpoint ${W.sp[k].toFixed(0)}`, status: 'info', source: 'watch' },
      { id: 'os', label: 'Last overshoot', value: m ? m.os.toFixed(1) : '-', unit: '%', sub: m ? `step ${m.from} > ${m.to}` : 'waiting for a step', status: m ? level('ctrl.overshoot_pct', m.os) : 'idle', source: 'step metrics' },
      { id: 'st', label: 'Last settling', value: m ? m.settle.toFixed(0) : '-', unit: 'ms', sub: m ? `rise ${m.rise.toFixed(0)} ms` : '', status: m ? level('ctrl.settle_ms', m.settle) : 'idle', source: 'step metrics' },
      { id: 'g', label: 'Gains now', value: `${sim.param('ctrl.kp')} / ${sim.param('ctrl.ki')}`, sub: 'Kp / Ki', status: 'info', source: 'registry' },
      { id: 'p99', label: 'ctrl_loop p99', value: p99.toFixed(0), unit: 'us', sub: `deadline ${CTRL_BUDGET_US} us`, status: level('span.ctrl_loop.p99_pct', (p99 / CTRL_BUDGET_US) * 100), source: 'jobs' },
      { id: 'miss', label: 'Misses, 10 s', value: String(miss), sub: `${inv} inversions`, status: level('span.ctrl_loop.miss', miss), source: 'jobs' },
      { id: 'bus', label: 'Bus lock', value: sim.busIsMutex ? 'k_mutex' : 'k_sem', sub: `chunk ${sim.param('storage.chunk')} B`, status: sim.busIsMutex ? 'ok' : 'warn', source: 'registry' },
    ])
  }

  // ---------------------------------------------------------------- toolbar
  const trigSeg = segmented<Trigger>([['step', 'Setpoint step'], ['miss', 'Deadline miss'], ['roll', 'Roll']], trig, (v) => { trig = v; sweeps.length = 0; lastTrig = NaN })
  const runBtn = button('Stop', () => { running = !running; single = false; runBtn.textContent = running ? 'Stop' : 'Run'; lastTrig = NaN })
  const singleBtn = button('Single', () => { running = true; single = true; runBtn.textContent = 'Stop'; lastTrig = NaN }, 'btn', 'Capture the next trigger, then stop')
  const winSeg = segmented<'250' | '500' | '1000'>([['250', '250 ms'], ['500', '500 ms'], ['1000', '1 s']], '500', (v) => { winMs = Number(v); sweeps.length = 0; lastTrig = NaN })
  bar.append(el('span', 'note', 'Trigger'), trigSeg.el, runBtn, singleBtn, el('span', 'sep'), el('span', 'note', 'Window'), winSeg.el, el('span', 'grow'),
    el('span', 'note', 'Scope reads watch samples stamped in target time by ctrl_loop, so it lines up with the trace to the microsecond'))

  // ---------------------------------------------------------------- focus from another view (never auto-sent)
  const f = takeFocus('tune')
  if (f?.param) {
    const r = rows.find((x) => x.p.id === f.param!.id)
    if (r) {
      r.num.value = String(f.param.value)
      if (r.range) r.range.value = r.num.value
      dirty(r)
      r.row.classList.add('flash')
      setTimeout(() => r.row.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50)
      banner.hidden = false
      banner.innerHTML = `${glyph('info')} Suggested${f.label ? ` by <b>${esc(f.label)}</b>` : ''}: <span class="mono">${f.param.id} = ${f.param.value}</span>. Nothing is sent until you arm writes and press Apply.`
    }
  }

  let raf = 0, n = 0
  const frame = () => {
    if (n++ % 4 === 0 && running) {
      const tt = triggerTime()
      if (tt !== null && (trig === 'roll' || tt !== lastTrig)) {
        lastTrig = tt
        sweep(tt)
        if (single && trig !== 'roll') { running = false; single = false; runBtn.textContent = 'Run'; scope.setTitle(scope.getTitle().replace(/$/, ' (single, stopped)')) }
      }
    }
    if (n % 12 === 0) { refreshSide(); refreshRows() }
    if (n % 60 === 1) { refreshSteps(); refreshKpi(); refreshBox() }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  refreshSide()
  refreshRows()

  return () => {
    cancelAnimationFrame(raf)
    offParam()
    dash.dispose()
  }
}

