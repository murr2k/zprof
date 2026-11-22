// SPDX-License-Identifier: Apache-2.0
import { sferic, type CellContent, type Theme } from 'sferic'
import { KpiStrip, type KpiTile } from '../charts/KpiStrip'
import { BulletChart, type BulletRow } from '../charts/BulletChart'
import { PriorityMap, type MapPoint } from '../charts/PriorityMap'
import { statusColor, type Status } from '../charts/status'
import { dataTable } from '../charts/dataTable'
import { level, liveRule } from '../thresholds'
import { button, el, esc, glyph, sortableTable } from '../dom'
import { liveLink, type LiveSched, type SchedLoop, type SchedOverride, type SchedRow } from '../live/link'
import type { View } from './common'

const us = (x: number | null | undefined) =>
  x === null || x === undefined ? '' : x >= 10_000 ? `${(x / 1000).toFixed(1)} ms` : x >= 100 ? `${Math.round(x).toLocaleString('en-US')} us` : `${x.toFixed(1)} us`
const num = (x: number | null | undefined, text?: string): CellContent =>
  x === null || x === undefined ? '' : { value: x, text: text ?? us(x) }

/** The event loop's shape, sorted by how often a handler blocks (an Active Object: 0). */
export const loopText = (lp: SchedLoop | null | undefined) => !lp ? '' :
  lp.shape === 'ao' ? 'active object'
    : lp.shape === 'ao-inside' ? `waits inside ${lp.inside_pct < 1 ? lp.inside_pct.toFixed(2) : lp.inside_pct.toFixed(0)} %`
      : lp.shape === 'multi' ? `${lp.wait_points} wait points`
        : `marked, ${lp.wait_points} wait point${lp.wait_points === 1 ? '' : 's'}`
const loopCell = (r: SchedRow): CellContent => (r.loop ? { value: r.loop.shape === 'multi' ? 100 + r.loop.wait_points : r.loop.inside_pct, text: loopText(r.loop) } : '')

/**
 * Schedulability: the measured system against its deadlines, from the bridge's
 * response-time analysis (host/bridge/zprof_bridge/sched.py, docs/SCHEDULABILITY.md).
 * Jobs, execution times, blocking and the densest bursts come from the trace;
 * deadlines from the deadlines file (else a periodic thread's period, for
 * information). Side panel: recommendations, and what-ifs the bridge analyses on
 * the measured model (priorities, execution times, periods, deadlines; Audsley's
 * priority order); a what-if follows the live data until it is cleared.
 */
export const liveSched: View = ({ container, theme: t }) => {
  const link = liveLink()
  const root = el('div', 'hsplit')
  const side = el('div', 'tune')
  const right = el('div', 'fill')
  root.append(side, right)
  container.appendChild(root)
  const note = el('div', 'live-note')
  note.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'text-align:center;padding:24px;font:14px/1.6 system-ui,sans-serif;opacity:.85;white-space:pre-line'
  right.appendChild(note)
  const host = el('div')
  host.style.cssText = 'position:absolute;inset:0'
  right.appendChild(host)

  // ---------------------------------------------------------------- side panel
  const secA = el('div', 'sec')
  secA.innerHTML = '<h4>Analysis <span class="grow"></span><span id="sched-obs"></span></h4>'
  const banner = el('div', 'notice info')
  banner.hidden = true
  const about = el('div', 'sched-about')
  about.innerHTML = 'Response-time analysis of the measured system: execution times are the largest seen, ' +
    'bursts the densest seen, and the bound assumes every thread\'s worst coincides, so the verdict holds ' +
    '<b>for the load observed</b>. Analyse one operating mode at a time (a screen, a transfer): start a ' +
    '<b>New observation</b> on it, and run it through what matters there.'
  const reset = button('New observation', () => { link.send({ type: 'sched_reset' }); clearWhatIf() }, 'btn',
    'Forget the jobs and bursts seen so far and start measuring again')
  const tools = el('div', 'row-tools')
  tools.append(reset)
  secA.append(about, tools, banner)

  const secR = el('div', 'sec')
  secR.innerHTML = '<h4>Recommendations <span class="grow"></span><span>limits from the thresholds file</span></h4>'
  const recs = el('div', 'recs')
  secR.append(recs)

  const secW = el('div', 'sec')
  secW.innerHTML = '<h4>What if <span class="grow"></span><span>the bridge analyses it on the measured model</span></h4>'
  const pick = el('select', 'sel')
  const fPrio = el('input', 'inp'), fC = el('input', 'inp'), fT = el('input', 'inp'), fD = el('input', 'inp')
  for (const [f, ph] of [[fPrio, 'priority'], [fC, 'worst C, us'], [fT, 'period, us'], [fD, 'deadline, us']] as const) {
    f.placeholder = ph
    f.inputMode = 'decimal'
  }
  const form = el('div', 'whatif')
  const lab = (s: string, f: HTMLElement) => { const l = el('label', '', `<span>${s}</span>`); l.append(f); return l }
  form.append(lab('Thread', pick), lab('Priority', fPrio), lab('Worst C (us)', fC), lab('Period (us)', fT), lab('Deadline (us)', fD))
  const changes = el('div', 'changes')
  const add = button('Add change', () => addChange(), 'btn')
  const run = button('Run what-if', () => runWhatIf(), 'btn primary')
  const suggest = button('Suggest an order', () => applyOrder(), 'btn',
    'Audsley\'s assignment: the priorities the threads with deadlines use now, in an order that meets every deadline')
  const back = button('Back to measured', () => clearWhatIf(), 'btn')
  const wtools = el('div', 'row-tools')
  wtools.append(add, run, suggest, back)
  secW.append(form, wtools, changes)
  const secL = el('div', 'sec')
  secL.innerHTML = '<h4>Event loop <span class="grow"></span><span>where the thread picked above waits</span></h4>'
  const loopBox = el('div', 'loopbox')
  secL.append(loopBox)
  side.append(secA, secR, secW, secL)
  const renderLoop = () => {
    const r = rowsByName().get(pick.value)
    const lp = r?.loop
    loopBox.replaceChildren()
    if (!r || !lp) {
      loopBox.append(el('div', 'sched-about', 'Too few waits seen yet.'))
      return
    }
    const what = lp.shape === 'ao' ? 'An Active Object: one wait point, every event run to completion.'
      : lp.shape === 'ao-inside' ? `One event wait point; it blocks while handling ${lp.inside_pct < 1 ? lp.inside_pct.toFixed(2) : lp.inside_pct.toFixed(1)} % of its events.`
        : lp.shape === 'multi' ? `A sequential loop: ${lp.wait_points} places it waits as it goes round.`
          : `Its jobs come from the "${r.marks}" marks; it waits at ${lp.wait_points} place${lp.wait_points === 1 ? '' : 's'}.`
    loopBox.append(el('div', 'sched-about', `<b>${esc(r.name)}</b>: ${esc(what)}` +
      (lp.sites ? '' : ' (The firmware sent no call sites: wait points are kernel objects only.)')))
    const tbl = sortableTable(el('table', 'audit'))
    const total = lp.points.reduce((a, [, n]) => a + n, 0)
    tbl.innerHTML = '<tr><th>Waits on, at</th><th class="num">Waits</th><th class="num">Inside a handler</th></tr>' +
      lp.points.map(([lab, n]) => {
        const ins = lp.inside_by.find(([l]) => l === lab)?.[1] ?? 0
        return `<tr><td class="mono">${esc(lab)}</td><td class="num">${n.toLocaleString('en-US')} (${(100 * n / (total || 1)).toFixed(1)} %)</td>` +
          `<td class="num">${ins ? ins.toLocaleString('en-US') : ''}</td></tr>`
      }).join('')
    loopBox.append(tbl)
  }
  pick.addEventListener('change', renderLoop)

  // ---------------------------------------------------------------- what-if state
  const overrides: Record<string, SchedOverride> = {}
  let whatIf: LiveSched | null = null
  let measured: LiveSched | null = link.sched
  const rowsByName = () => new Map((measured?.rows ?? []).map((r) => [r.name, r]))
  const fillForm = () => {
    const r = rowsByName().get(pick.value)
    const o = overrides[pick.value] ?? {}
    fPrio.value = String(o.prio ?? r?.prio ?? '')
    fC.value = String(Math.round(o.c_us ?? r?.c_us ?? 0) || '')
    fT.value = String(Math.round(o.t_us ?? (r?.periodic ? r.t_us ?? 0 : 0)) || '')
    fD.value = String(Math.round(o.d_us ?? r?.d_us ?? 0) || '')
  }
  pick.onchange = fillForm
  const addChange = () => {
    const r = rowsByName().get(pick.value)
    if (!r) return
    const o: SchedOverride = {}
    const n = (f: HTMLInputElement) => (f.value.trim() === '' ? NaN : Number(f.value))
    if (Number.isFinite(n(fPrio)) && n(fPrio) !== r.prio) o.prio = n(fPrio)
    if (Number.isFinite(n(fC)) && Math.round(n(fC)) !== Math.round(r.c_us)) o.c_us = n(fC)
    if (Number.isFinite(n(fT)) && n(fT) > 0 && Math.round(n(fT)) !== Math.round(r.t_us ?? -1)) o.t_us = n(fT)
    if (Number.isFinite(n(fD)) && Math.round(n(fD)) !== Math.round(r.d_us ?? -1)) o.d_us = n(fD)
    if (Object.keys(o).length) overrides[r.name] = o
    else delete overrides[r.name]
    renderChanges()
  }
  const renderChanges = () => {
    changes.replaceChildren()
    for (const [name, o] of Object.entries(overrides)) {
      const parts = [o.prio !== undefined && `priority ${o.prio}`, o.c_us !== undefined && `C ${us(o.c_us)}`,
        o.t_us !== undefined && `period ${us(o.t_us)}`, o.d_us !== undefined && `deadline ${us(o.d_us)}`].filter(Boolean)
      const c = el('div', 'change', `<b>${esc(name)}</b> ${parts.join(', ')}`)
      c.append(button('x', () => { delete overrides[name]; renderChanges() }, 'btn tiny', 'Remove this change'))
      changes.append(c)
    }
    run.disabled = !Object.keys(overrides).length
  }
  const runWhatIf = async () => {
    if (!Object.keys(overrides).length) return
    try {
      whatIf = await link.whatIf(overrides)
      render()
    } catch (e) {
      banner.hidden = false
      banner.className = 'notice'
      banner.textContent = `What-if failed: ${(e as Error).message}`
    }
  }
  const applyOrder = () => {
    const ord = measured?.order
    if (!ord || !Object.keys(ord).length) return
    for (const [name, p] of Object.entries(ord)) overrides[name] = { ...(overrides[name] ?? {}), prio: p }
    renderChanges()
    void runWhatIf()
  }
  const clearWhatIf = () => {
    for (const k of Object.keys(overrides)) delete overrides[k]
    whatIf = null
    renderChanges()
    render()
  }
  renderChanges()

  // ---------------------------------------------------------------- dashboard
  let built: ReturnType<typeof build> | null = null
  const render = () => {
    const s = whatIf ?? measured
    if (!s) {
      built?.dispose()
      built = null
      note.hidden = false
      note.textContent = link.state === 'open'
        ? 'Measuring: the first analysis comes a few seconds after the target is up.'
        : `No zprof bridge at ${link.url} (${link.state}).\n\nStart one with the deadlines file:\n` +
          '... -m zprof_bridge serve --host <board> --elf <zephyr.elf> --deadlines <deadlines.json>'
      return
    }
    note.hidden = true
    built ??= build(host, t)
    built.render(s, measured)
    // side: observation, banner, recommendations, the thread picker
    side.querySelector('#sched-obs')!.textContent =
      `${s.observed_s.toFixed(0)} s, ${s.jobs.toLocaleString('en-US')} jobs${s.discarded ? `, ${s.discarded} left out` : ''}`
    banner.hidden = !whatIf
    if (whatIf) {
      banner.className = 'notice info'
      banner.innerHTML = `${glyph('info')} <b>What-if</b>: the measured model with your changes, analysed again ` +
        `every few seconds as new data comes in. Nothing on the target changes.`
    }
    recs.replaceChildren()
    if (!s.recs.length) recs.append(el('div', 'rec ok', `${glyph('ok')} Nothing to recommend: every deadline in the verdict is met with the slack the thresholds ask for.`))
    for (const r of s.recs) {
      const d = el('div', `rec ${r.level}`)
      d.innerHTML = `<div class="t">${glyph(r.level === 'info' ? 'info' : r.level)} ${esc(r.title)}</div>` +
        (r.detail ? `<div class="d">${esc(r.detail)}</div>` : '') + (r.advice ? `<div class="a">${esc(r.advice)}</div>` : '')
      recs.append(d)
    }
    const names = (measured?.rows ?? []).filter((r) => r.kind === 'thread').map((r) => r.name).sort()
    if (names.join('|') !== Array.from(pick.options).map((o) => o.value).join('|')) {
      const keep = pick.value
      pick.replaceChildren(...names.map((n) => { const o = el('option', '', esc(n)); o.value = n; return o }))
      pick.value = names.includes(keep) ? keep : (measured?.worst_task ?? names[0] ?? '')
      fillForm()
    }
    suggest.disabled = !(measured?.order && Object.keys(measured.order).length)
    renderLoop()
  }

  const off = link.onSched((s) => {
    measured = s
    if (whatIf && Object.keys(overrides).length) void runWhatIf()   // the what-if follows the live data
    else render()
  })
  const offState = link.onState(() => { if (!measured) render() })
  render()

  return () => {
    off()
    offState()
    built?.dispose()
  }
}

function build(host: HTMLElement, t: Theme) {
  const dash = sferic().Dashboard({ container: host, theme: t, numberOfColumns: 2, numberOfRows: 3, splitterThickness: 4 })
  dash.setRowHeight(0, 0.5).setRowHeight(1, 1.35).setRowHeight(2, 1.5)
  dash.setColumnWidth(0, 1.15).setColumnWidth(1, 1)
  const kpi = dash.createPanel(KpiStrip, { columnIndex: 0, rowIndex: 0, columnSpan: 2 })
  const bullets = dash.createPanel(BulletChart, { columnIndex: 0, rowIndex: 1, format: (v: number) => us(v) })
    .setTitleFont((f) => f.setSize(13))
  const map = dash.createPanel(PriorityMap, { columnIndex: 1, rowIndex: 1 })
    .setTitle('Priority against period: a dashed line joins a shorter deadline below a longer one')
    .setTitleFont((f) => f.setSize(13))
  const grid = dataTable(dash, { columnIndex: 0, rowIndex: 2, columnSpan: 2 }).setTitleFont((f) => f.setSize(13))
  grid.setCellChangeHighlight(false)
  const slackRule = liveRule('sched.x.slack_pct')

  const render = (s: LiveSched, measured: LiveSched | null) => {
    const wi = s.whatif ? 'What-if: ' : ''
    const judged = s.rows.filter((r) => r.kind === 'thread' && r.counts)
    const info = s.rows.filter((r) => r.kind === 'thread' && !r.counts && r.d_us !== null)
    const worst = s.worst_slack_pct
    const mSlack = measured && s.whatif ? measured.worst_slack_pct : null
    const tiles: KpiTile[] = [
      { id: 'verdict', label: `${wi}Deadlines met`, value: `${s.deadlines - s.misses} of ${s.deadlines}`,
        sub: s.deadlines ? (s.misses ? `${s.misses} can miss if the worst cases seen coincide` : 'every one, under the load observed') : 'no deadlines declared',
        status: !s.deadlines ? 'idle' : s.misses ? 'crit' : 'ok', source: 'response-time analysis' },
      { id: 'slack', label: 'Least slack', value: worst === null ? 'none' : worst.toFixed(0), unit: worst === null ? '' : '%',
        sub: `${s.worst_task ?? ''}${mSlack !== null && mSlack !== undefined ? `  (measured ${mSlack.toFixed(0)} %)` : ''}`,
        status: worst === null ? 'idle' : level(`sched.${s.worst_task}.slack_pct`, worst), source: '(D - R) / D' },
      { id: 'scale', label: 'Execution times can scale by', value: s.scale === null || s.scale === undefined ? '-' : `x${s.scale.toFixed(2)}`,
        sub: 'every thread and interrupt, deadlines still met',
        status: s.scale === null || s.scale === undefined ? 'idle' : level('sched.scale', s.scale), source: 'analysis' },
      { id: 'u', label: 'Utilisation', value: s.u_pct.toFixed(0), unit: '%', sub: 'each one\'s busiest second, summed', status: 'info', source: 'trace' },
      { id: 'll', label: 'Periodic, Liu and Layland', value: s.u_rm_pct.toFixed(0), unit: '%',
        sub: `bound ${s.ll_pct.toFixed(0)} %: sufficient, not necessary`, status: 'info', source: 'C / T' },
      { id: 'obs', label: 'Observed', value: s.observed_s.toFixed(0), unit: 's',
        sub: `${s.jobs.toLocaleString('en-US')} jobs${s.discarded ? `, ${s.discarded} left out at ${s.gaps} gaps` : ''}`,
        status: s.discarded ? 'warn' : 'info', source: 'trace' },
    ]
    kpi.setTiles(tiles)

    // response against deadline: measured worst (bar), bound (tick), deadline (crit zone)
    const bRow = (r: SchedRow, group?: string): BulletRow => {
      const d = r.d_us!
      const bound = r.bounded && r.r_us !== null ? r.r_us : 2 * d
      const max = Math.max(d, bound) * 1.04
      const warn = slackRule?.warn !== undefined ? d * (1 - slackRule.warn / 100) : undefined
      const crit = slackRule?.crit !== undefined ? d * (1 - slackRule.crit / 100) : d
      const text = r.bounded ? `R <= ${us(bound)} of ${us(d)} (${r.slack_pct?.toFixed(0)} % slack)` : `no bound (D ${us(d)})`
      return { name: r.name, value: r.r_meas_us ?? 0, peak: bound, max, warn, crit, text, group }
    }
    bullets.setTitle(`${wi}Response against deadline: bar = longest measured, tick = bound`)
    bullets.setRows([
      ...judged.map((r, i) => bRow(r, i === 0 ? 'Deadlines in the verdict' : undefined)),
      ...info.slice(0, 6).map((r, i) => bRow(r, i === 0 ? 'Periods, for information' : undefined)),
    ])

    map.setPoints(s.rows.filter((r) => r.kind === 'thread' && r.t_us).map((r): MapPoint => ({
      name: r.name, prio: r.prio, t: r.t_us!, periodic: r.periodic,
      d: r.counts || r.periodic ? r.d_us : null, judged: r.counts,
    })))

    // the table: threads with deadlines in the verdict, then the others by priority, then interrupts
    const order = (r: SchedRow) => (r.kind === 'irq' ? 2 : r.counts ? 0 : 1)
    const rows = [...s.rows].sort((a, b) => order(a) - order(b) || (a.kind === 'irq' ? b.u_pct - a.u_pct : a.prio - b.prio))
    grid.setTitle(`${wi}Threads and interrupts (us): C execution per job (net of interrupts), S waits inside a job, ` +
      'B time ready while a lower-priority thread ran, R response; bound from the analysis')
    const head = ['Thread', 'Kind', 'Event loop', 'Prio', 'Period', 'Jitter', 'C max', 'C p99', 'S', 'B', 'B by', 'Deadline', 'R bound',
      'R measured', 'Slack %', 'Room', 'U %', 'Jobs']
    grid.setTableContent([head, ...rows.map((r): CellContent[] => {
      const st: Status = (r.status as Status) ?? 'idle'
      const kind = r.kind === 'irq' ? 'interrupt'
        : `${r.coop ? 'coop' : 'preempt'}, ${r.marks ? `marked "${r.marks}"` : r.per_period ? 'per period' : r.periodic ? 'periodic' : 'events'}`
      return [
        r.sender ? `${r.name} (zprof)` : r.name, kind, loopCell(r), r.prio,
        num(r.t_us, r.t_us === null ? '' : `${r.periodic ? '' : '>= '}${us(r.t_us)}`), num(r.kind === 'irq' ? null : r.j_us),
        num(r.c_us), num(r.c_p99_us || null), num(r.s_us || null), num(r.b_us || null), r.b_by,
        num(r.d_us, r.d_us === null ? '' : `${us(r.d_us)}${r.counts ? '' : ' (period)'}`),
        r.kind === 'irq' ? '' : r.bounded ? num(r.r_us) : { value: Infinity, text: 'none', textColor: statusColor(t, 'crit') },
        num(r.r_meas_us),
        r.slack_pct === undefined || r.slack_pct === null ? '' :
          { value: r.slack_pct, text: r.slack_pct.toFixed(0), textColor: st === 'ok' ? undefined : statusColor(t, r.counts ? st : 'info') },
        num(r.grow_us ?? null), { value: r.u_pct, text: r.u_pct.toFixed(2) }, r.jobs,
      ]
    })])
  }
  return { render, dispose: () => dash.dispose() }
}
