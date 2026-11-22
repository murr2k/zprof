import { sferic, ColorRGBA, type Color, type DataGrid } from 'sferic'
import { SequenceTrace, fmtFull, type SeqFrame, type SeqItem, type SeqLane, type SeqLink, type SeqMark, type SeqSource, type SeqSpan } from '../charts/SequenceTrace'
import { AnatomyChart } from '../charts/AnatomyChart'
import {
  targetSim, cloneLog, AP, IRQS, IDLE, LANES, OBJECTS, RS, ST_BLOCKED, ST_IRQ0, ST_MISS, ST_OVERRUN, ST_READY, THREADS, TH,
  CTRL_BUDGET_US, laneOfThread, threadOfLane, type EventRing, type IntervalLog, type Job,
} from '../sim/target'
import { SEQ_OBJECTS, describe, eventsIn, intervalsIn, jobAt, laneName, links, logSpan, objectSpans, seqLaneOfObj, us } from '../sim/query'
import { explainJob } from '../sim/explain'
import { anatomyRow } from './anatomy'
import { go, takeFocus } from '../nav'
import { button, el, esc, glyph, segmented, select } from '../dom'
import { irqColor, threadColor, type View } from './common'
import { dataTable } from '../charts/dataTable'

type FindKind = 'inversion' | 'miss' | 'block' | 'coop' | 'param' | 'heap'
const FIND: [FindKind, string][] = [
  ['inversion', 'Priority inversion'], ['miss', 'Deadline miss'], ['block', 'Lock wait'], ['coop', 'Cooperative work item > 150 us'],
  ['param', 'Parameter change'], ['heap', 'Heap allocation failure'],
]
const objColor = (t: { seriesColors: Color[] }, o: number) => {
  const k = OBJECTS[o].kind
  return t.seriesColors[{ timer: 9, sem: 1, msgq: 4, fifo: 2, mutex: 8, work: 7, heap: 5 }[k] % t.seriesColors.length]
}

/**
 * Trace: the vertical sequence view of a recorded window (or the live tail),
 * with the response anatomy and a plain-language explanation of the job
 * under the selection, and the event log of the visible window.
 */
export const engineeringTrace: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const [bad, mid] = t.examples.badGoodColorPalette

  // ---------------------------------------------------------------- layout
  const root = el('div', 'vstack')
  const bar = el('div', 'toolbar')
  const body = el('div', 'fill')
  const split = el('div', 'hsplit')
  const left = el('div', 'fill')
  const side = el('div', 'side')
  const card = el('div', 'card')
  const sideFill = el('div', 'fill')
  side.append(card, sideFill)
  split.append(left, side)
  body.append(split)
  root.append(bar, body)
  container.appendChild(root)

  const dash = sferic().Dashboard({ container: left, theme: t, numberOfColumns: 1, numberOfRows: 1 })
  const trace = dash.createPanel(SequenceTrace, { columnIndex: 0, rowIndex: 0 })
  const dash2 = sferic().Dashboard({ container: sideFill, theme: t, numberOfColumns: 1, numberOfRows: 2, splitterThickness: 4 })
  dash2.setRowHeight(0, 0.8).setRowHeight(1, 1.7)
  const anat = dash2.createPanel(AnatomyChart, { columnIndex: 0, rowIndex: 0 }).setTitle('Response anatomy of the selected job').setTitleFont((f) => f.setSize(13))
  anat.setBudget(CTRL_BUDGET_US).setEmptyText('Select an event or a ctrl_loop span')
  const log: DataGrid = dataTable(dash2, { columnIndex: 0, rowIndex: 1 }).setTitle('Event log, visible window').setTitleFont((f) => f.setSize(13))
  log.setCellChangeHighlight(false)

  // ---------------------------------------------------------------- lanes and colors
  const lanes: SeqLane[] = [
    ...IRQS.map((n, k) => ({ name: n, kind: 'irq' as const, color: irqColor(t, k) })),
    ...THREADS.map((d, i) => ({ name: `${d.name} ${d.prio}`, kind: 'thread' as const, color: threadColor(t, i).setA(255) })),
    ...SEQ_OBJECTS.map((o) => ({ name: OBJECTS[o].name, kind: 'object' as const, color: objColor(t, o) })),
  ]
  trace.setLanes(lanes)
  const thCol = THREADS.map((_, i) => threadColor(t, i).setA(i === IDLE ? 90 : 235).toUint32())
  const irqCol = IRQS.map((_, k) => irqColor(t, k).toUint32())
  const readyCol = (t.isDark ? ColorRGBA(170, 185, 215, 120) : ColorRGBA(90, 100, 125, 120)).toUint32()
  const blockedCol = bad.setA(170).toUint32()
  const boostCol = t.examples.highlightColor.toUint32()
  const linkCol = {
    signal: t.seriesColors[0].setA(230).toUint32(),
    handoff: mid.toUint32(),
    data: t.tickColor.setA(t.isDark ? 130 : 160).toUint32(),
    block: bad.setA(220).toUint32(),
  }

  // ---------------------------------------------------------------- data: frozen snapshot or live rings
  let L: IntervalLog = cloneLog(sim.ilog)
  let E: EventRing = sim.events.clone()
  let jobs: Job[] = sim.jobs.slice()
  let snapT = sim.now / 1000
  let live = false

  const source: SeqSource = {
    range: () => logSpan(L),
    frame(t0, t1, upp): SeqFrame {
      const spans: SeqSpan[] = [], marks: SeqMark[] = [], items: SeqItem[] = [], lks: SeqLink[] = []
      intervalsIn(L, t0, t1, (lane, a, b, st) => {
        if (a === b) {
          if (st === ST_MISS) marks.push({ lane, t: a, color: bad.toUint32() })
          else if (st === ST_OVERRUN) marks.push({ lane, t: a, color: mid.toUint32() })
          return
        }
        if (st < ST_READY) spans.push({ lane, t0: a, t1: b, color: thCol[st], w: st === IDLE ? 0.45 : 0.78 })
        else if (st === ST_READY) spans.push({ lane, t0: a, t1: b, color: readyCol, w: 0.18 })
        else if (st < ST_MISS) spans.push({ lane, t0: a, t1: b, color: irqCol[st - ST_IRQ0], w: 0.86 })
        else if (st === ST_BLOCKED) spans.push({ lane, t0: a, t1: b, color: blockedCol, w: 0.34 })
      })
      const os = objectSpans(E, t0, t1)
      for (const s of os.spans) {
        const lane = seqLaneOfObj(s.obj)
        if (lane < 0) continue
        if (s.owner >= 0) spans.push({ lane, t0: s.t0, t1: s.t1, color: thCol[s.owner], w: 0.62 })
        else spans.push({ lane, t0: s.t0, t1: s.t1, color: objColor(t, s.obj).setA(200).toUint32(), w: 0.14 + 0.62 * s.level })
      }
      for (const b of os.boosts) spans.push({ lane: laneOfThread(b.thread), t0: b.t0, t1: b.t1, color: boostCol, w: 0.16, x: 0 })
      if (upp < 0.06) {
        for (const l of links(E, t0, t1)) {
          if (l.kind === 'data' && upp > 0.012) continue
          const lane0 = l.fromObj ? seqLaneOfObj(l.from) : l.from
          const lane1 = l.toObj ? seqLaneOfObj(l.to) : l.to
          if (lane0 < 0 || lane1 < 0) continue
          lks.push({ t0: l.t0, lane0, t1: l.t1, lane1, color: linkCol[l.kind], id: l.id })
        }
      }
      // Coarse zoom: only the events that would survive label selection anyway.
      let n = 0
      eventsIn(E, t0, t1, () => { n++ })
      const maxPrio = n > 4000 ? 0 : n > 1500 ? 1 : 9
      eventsIn(E, t0, t1, (id, k) => {
        const d = describe(E, k)
        if (d.prio > maxPrio) return
        items.push({ id, t: E.t[k], lane: E.ctx[k], text: d.text, tone: d.tone, prio: d.prio })
      })
      return { spans, items, links: lks, marks }
    },
    spanInfo(lane, tm) {
      if (lane >= LANES.length) {
        const o = SEQ_OBJECTS[lane - LANES.length]
        const s = objectSpans(E, tm - 0.0005, tm + 0.0005).spans.find((x) => x.obj === o)
        const d = OBJECTS[o]
        const rows = [`${d.name} (${d.kind})`, d.note]
        if (s && s.owner >= 0) rows.push(`held by ${THREADS[s.owner].name}`)
        else if (s && s.level > 0 && d.cap) rows.push(`fill ${(s.level * d.cap).toFixed(0)} / ${d.cap}`)
        return rows
      }
      let hit: string[] | null = null
      intervalsIn(L, tm - 0.002, tm + 0.002, (l, a, b, st) => {
        if (l !== lane || a > tm || b < tm || a === b) return
        const what = st < ST_READY ? 'running' : st === ST_READY ? 'ready, waiting for the CPU' : st < ST_MISS ? 'in ISR' : st === ST_BLOCKED ? 'blocked on a lock' : ''
        hit = [`${laneName(lane)} ${what}`, `${us((b - a) * 1000)}  (${fmtFull(a)})`]
        const th = threadOfLane(lane)
        if (th === TH.CTRL || th === TH.SENSOR) {
          const j = jobAt(jobs, th, tm)
          if (j) hit.push(`job ${j.id}: response ${us(j.resp)}${j.miss ? ' MISS' : ''}, click to explain`)
        }
      })
      return hit
    },
  }
  trace.setSource(source)

  // ---------------------------------------------------------------- selection: job band, anatomy, explanation
  const renderCard = (j: Job | null, ev: string | null) => {
    if (!j) {
      card.innerHTML = `<h3>${glyph('info')} Nothing selected</h3><p class="muted">Click an annotation, a ctrl_loop or sensor_rx span, or use Find. The job under the selection is decomposed into where its response time went.</p>${ev ? `<p>${esc(ev)}</p>` : ''}`
      return
    }
    const x = explainJob(j)
    card.innerHTML = `<h3>${glyph(x.status)} ${esc(x.headline)}</h3>` +
      (ev ? `<p class="muted">Selected: ${esc(ev)}</p>` : '') +
      x.lines.map((l) => `<p>${l.tone === 'crit' || l.tone === 'warn' ? glyph(l.tone) : glyph('idle', 8)}<span>${esc(l.text)}</span></p>`).join('')
    if (x.fix) {
      const fx = el('div', 'fix')
      fx.innerHTML = `${glyph('info')}<span>${esc(x.fix.text)}</span>`
      if (x.fix.param) {
        const p = x.fix.param
        fx.appendChild(button(`Try ${p.id} = ${p.value}`, () => go('tune', { param: p, label: x.headline }), 'btn primary', 'Open Watch & Tune with this change staged (not sent)'))
      }
      card.appendChild(fx)
    }
  }
  const selectJob = (j: Job | null, ev: string | null = null) => {
    anat.setRows(j ? [anatomyRow(t, j)] : [])
    trace.setBand(j ? { t0: j.release, t1: j.end, label: `job ${j.id} ${us(j.resp)}`, color: j.miss ? bad : j.inv > 0 ? mid : t.examples.highlightColor } : null)
    renderCard(j, ev)
  }
  const jobForEvent = (k: number): Job | null => {
    const th = threadOfLane(E.ctx[k])
    const tm = E.t[k]
    if (E.api[k] === AP.MISS) return jobs.find((j) => j.id === E.aux[k]) ?? null
    if (th === TH.CTRL || th === TH.SENSOR) return jobAt(jobs, th, tm)
    return jobAt(jobs, TH.CTRL, tm)
  }
  trace.addEventListener('select', (e: { item: SeqItem }) => {
    const k = E.slot(e.item.id)
    if (k < 0) return
    selectJob(jobForEvent(k), `${fmtFull(E.t[k])}  ${laneName(E.ctx[k])}: ${e.item.text}`)
    markLogRow(e.item.id)
  })
  trace.addEventListener('spanclick', (e: { lane: number; t: number }) => {
    const th = threadOfLane(e.lane)
    if (th === TH.CTRL || th === TH.SENSOR) selectJob(jobAt(jobs, th, e.t))
  })

  // ---------------------------------------------------------------- event log of the visible window
  let logIds: number[] = []
  let logTimer = 0
  const fillLog = () => {
    logTimer = 0
    const { t0, t1 } = trace.getView()
    const rows: string[][] = [['Time', 'Context', 'Event']]
    logIds = []
    eventsIn(E, t0, t1, (id, k) => {
      if (logIds.length >= 400) return
      logIds.push(id)
      rows.push([fmtFull(E.t[k]).slice(-14), laneName(E.ctx[k]), describe(E, k).text])
    })
    log.setTableContent(rows)
    log.setColumnWidth(2, { min: 220 })
    markLogRow(trace.getSelected())
  }
  let markedRow = -1
  const markLogRow = (id: number) => {
    if (markedRow >= 0) log.setRowBackgroundFillStyle(markedRow, undefined)
    const i = logIds.indexOf(id)
    markedRow = i < 0 ? -1 : i + 1
    if (markedRow > 0) { log.setRowBackgroundFillStyle(markedRow, t.examples.highlightColor.setA(60)); log.scrollToRow(markedRow) }
  }
  log.addEventListener('cellclick', (e: { row: number }) => {
    const id = logIds[e.row - 1]
    if (id === undefined) return
    const k = E.slot(id)
    if (k < 0) return
    trace.setSelected(id)
    selectJob(jobForEvent(k), `${fmtFull(E.t[k])}  ${laneName(E.ctx[k])}: ${describe(E, k).text}`)
    markLogRow(id)
  })
  trace.addEventListener('viewchange', () => { if (!logTimer) logTimer = window.setTimeout(fillLog, 120) })

  // ---------------------------------------------------------------- find
  let kind: FindKind = 'inversion'
  const hits = (): { t: number; job?: Job; id?: number }[] => {
    const out: { t: number; job?: Job; id?: number }[] = []
    if (kind === 'inversion') for (const j of jobs) { if (j.inv > 0) out.push({ t: j.release, job: j }) }
    else if (kind === 'coop') for (const j of jobs) { if (j.pre[TH.SYSWQ] > 150) out.push({ t: j.release, job: j }) }
    else eventsIn(E, -Infinity, Infinity, (id, k) => {
      const api = E.api[k], res = E.res[k]
      if ((kind === 'miss' && api === AP.MISS) || (kind === 'block' && res === RS.BLOCKS && E.peer[k] >= 0) ||
        (kind === 'param' && api === AP.PARAM) || (kind === 'heap' && api === AP.MALLOC && res === RS.FAILED)) out.push({ t: E.t[k], id })
    })
    return out
  }
  const findNote = el('span', 'note')
  const jump = (dir: 1 | -1) => {
    const hs = hits()
    if (!hs.length) { findNote.textContent = 'none in this recording'; return }
    const { t0, t1 } = trace.getView()
    const ref = t0 + (t1 - t0) / 3
    let i = dir > 0 ? hs.findIndex((h) => h.t > ref + 1e-6) : hs.length - 1 - [...hs].reverse().findIndex((h) => h.t < ref - 1e-6)
    if (i < 0 || i >= hs.length) i = dir > 0 ? 0 : hs.length - 1
    show(hs[i])
    findNote.innerHTML = `<b>${i + 1}</b> of ${hs.length}`
  }
  const show = (h: { t: number; job?: Job; id?: number }) => {
    if (live) setMode('snapshot')
    trace.centerOn(h.t, Math.min(trace.uppMs, 0.004))
    if (h.job) {
      const missEv = h.job.miss ? findEvent(AP.MISS, h.job.end) : -1
      trace.setSelected(missEv)
      selectJob(h.job)
    } else if (h.id !== undefined) {
      trace.setSelected(h.id)
      const k = E.slot(h.id)
      if (k >= 0) selectJob(jobForEvent(k), `${fmtFull(E.t[k])}  ${laneName(E.ctx[k])}: ${describe(E, k).text}`)
    }
  }
  const findEvent = (api: number, tm: number) => {
    let found = -1
    eventsIn(E, tm - 0.002, tm + 0.002, (id, k) => { if (E.api[k] === api) found = id })
    return found
  }

  // ---------------------------------------------------------------- toolbar
  const snapNote = el('span', 'note')
  const refreshNote = () => {
    const r = logSpan(L)
    snapNote.innerHTML = live ? '<b>live tail</b>, scroll to freeze' : `snapshot at <b>${fmtFull(snapT).slice(0, 12)}</b>, ${((r.t1 - r.t0) / 1000).toFixed(1)} s recorded`
  }
  let tailTimer = 0
  const setMode = (m: 'snapshot' | 'live') => {
    live = m === 'live'
    mode.set(m)
    clearInterval(tailTimer)
    if (live) {
      L = sim.ilog
      E = sim.events
      jobs = sim.jobs
      tailTimer = window.setInterval(() => { trace.invalidate(); trace.tail(logSpan(L).t1) }, 100)
      trace.tail(logSpan(L).t1)
    } else {
      L = cloneLog(sim.ilog)
      E = sim.events.clone()
      jobs = sim.jobs.slice()
      snapT = sim.now / 1000
    }
    trace.invalidate()
    refreshNote()
  }
  const mode = segmented<'snapshot' | 'live'>([['snapshot', 'Snapshot'], ['live', 'Live tail']], 'snapshot', setMode)
  trace.addEventListener('userscroll', () => { if (live) setMode('snapshot') })
  bar.append(
    mode.el, snapNote,
    button('Refresh', () => { setMode('snapshot'); fillLog() }, 'btn', 'Take a new snapshot of the recording'),
    el('span', 'sep'), el('span', 'note', 'Find'),
    select(FIND, kind, (v) => { kind = v; findNote.textContent = '' }),
    button('&#9664; Prev', () => jump(-1)), button('Next &#9654;', () => jump(1)), findNote,
    el('span', 'sep'),
    button('&minus;', () => trace.zoom(1.6), 'btn', 'Zoom out'), button('+', () => trace.zoom(1 / 1.6), 'btn', 'Zoom in'),
    button('1 period', () => { const v = trace.getView(); trace.setView(v.t0, (sim.period / 1000) * 1.25 / Math.max(200, (v.t1 - v.t0) / v.upp)) }, 'btn', 'Fit one control period'),
    el('span', 'grow'),
    el('span', 'note', 'wheel scroll &middot; Ctrl+wheel zoom &middot; drag pan &middot; double-click zoom in'),
  )
  refreshNote()

  // ---------------------------------------------------------------- initial position: a handed-over focus, else the latest inversion
  renderCard(null, null)
  const f = takeFocus('trace')
  if (f?.t !== undefined) {
    // Without a job, explain the ctrl_loop job of that moment: the one running, else the one
    // released earlier in the same control period.
    const inPeriod = () => {
      for (let i = jobs.length - 1; i >= 0; i--) {
        const x = jobs[i]
        if (x.thread === TH.CTRL && x.release <= f.t! && f.t! - x.release < sim.period / 1000) return x
      }
      return undefined
    }
    const j = f.job !== undefined ? jobs.find((x) => x.id === f.job) : jobAt(jobs, TH.CTRL, f.t) ?? inPeriod()
    show({ t: f.t, job: j })
  } else {
    const hs = hits()
    if (hs.length) { show(hs[hs.length - 1]); findNote.innerHTML = `<b>${hs.length}</b> of ${hs.length}` }
    else trace.centerOn(logSpan(L).t1 - 5)
  }
  setTimeout(fillLog, 50)

  return () => {
    clearInterval(tailTimer)
    clearTimeout(logTimer)
    dash.dispose()
    dash2.dispose()
  }
}
