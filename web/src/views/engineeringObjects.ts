// SPDX-License-Identifier: Apache-2.0
import { sferic, type CellContent, type Color, type HierarchyNodeData } from 'sferic'
import { FlowGraph, type FlowEdge, type FlowNode } from '../charts/FlowGraph'
import { targetSim, AP, IRQS, OB, OBJECTS, RS, THREADS, TH, LINK_BUDGET_BPS, API, threadOfLane, type Heartbeat } from '../sim/target'
import { go } from '../nav'
import { irqColor, threadColor, type View } from './common'
import { dataTable } from '../charts/dataTable'

const OBJ_COLOR: Record<string, number> = { timer: 9, sem: 1, msgq: 4, fifo: 2, mutex: 8, work: 7, heap: 5 }

/**
 * Objects: who talks to whom, live. The flow graph animates each kernel call
 * on its edge as it happens and carries the objects' state; the sunburst
 * breaks the last 10 s of calls down by object type, object and API (the
 * call-count tree, made spatial); the table is the inspector.
 */
export const engineeringObjects: View = ({ container, theme: t }) => {
  const sim = targetSim()
  const sc = t.seriesColors
  const oc = (o: number): Color => sc[OBJ_COLOR[OBJECTS[o].kind] % sc.length]
  const dash = sferic().Dashboard({ container, theme: t, numberOfColumns: 2, numberOfRows: 2, splitterThickness: 4 })
  dash.setRowHeight(0, 1.7).setRowHeight(1, 1).setColumnWidth(0, 1.85).setColumnWidth(1, 1)
  const flow = dash.createPanel(FlowGraph, { columnIndex: 0, rowIndex: 0 })
    .setTitle('Kernel object flow, live: one particle per call (thinned), true rate on each edge')
    .setTitleFont((f) => f.setSize(13))
  const sun = dash.createSunburstChart({ columnIndex: 1, rowIndex: 0 }).setTitle('Kernel calls, last 10 s: type > object > API').setTitleFont((f) => f.setSize(13))
  sun.setValueFormatter((v) => `${v.toFixed(0)} calls`)
  const grid = dataTable(dash, { columnIndex: 0, rowIndex: 1, columnSpan: 2 }).setTitle('Object inspector').setTitleFont((f) => f.setSize(13))
  grid.setCellChangeHighlight(false)

  // ---------------------------------------------------------------- graph
  const T = (i: number) => `t${i}`, O = (o: number) => `o${o}`
  const tn = (i: number, x: number, y: number): FlowNode => ({ id: T(i), label: THREADS[i].name, kind: 'thread', x, y, color: threadColor(t, i).setA(255) })
  const on = (o: number, x: number, y: number): FlowNode => ({ id: O(o), label: OBJECTS[o].name, kind: 'object', x, y, color: oc(o) })
  const nodes: FlowNode[] = [
    ...IRQS.map((n, k) => ({ id: `irq${k}`, label: `ISR ${n}`, kind: 'irq' as const, x: 0, y: [0.12, 0.45, 0.76][k], color: irqColor(t, k) })),
    on(OB.CTRL_TMR, 0.17, 0.0), on(OB.CTRL_TICK, 0.36, 0.0), on(OB.SYSWQ, 0.17, 0.25),
    on(OB.SPI_DONE, 0.17, 0.45), on(OB.RX_FIFO, 0.17, 0.76),
    tn(TH.SYSWQ, 0.36, 0.25), tn(TH.SENSOR, 0.36, 0.45), tn(TH.NET, 0.36, 0.76),
    on(OB.SAMPLE_Q, 0.53, 0.45), tn(TH.CTRL, 0.68, 0.18),
    on(OB.BUS_LOCK, 0.86, 0.3), on(OB.BUS_MTX, 0.86, 0.53), tn(TH.STORAGE, 0.68, 0.64),
    on(OB.HEAP, 0.53, 0.9), tn(TH.MAIN, 0.36, 1), on(OB.CFG_MTX, 0.17, 1),
    tn(TH.ZPROF, 0.86, 0.82), tn(TH.LOGGING, 0.68, 0.97),
    { id: 'rtt', label: 'RTT to host', kind: 'sink', x: 1, y: 0.9, color: t.examples.highlightColor },
  ]
  const ec = (from: string): Color => nodes.find((n) => n.id === from)!.color
  const E = (id: string, from: string, to: string): FlowEdge => ({ id, from, to, color: ec(from) })
  const edges: FlowEdge[] = [
    E('tmr', 'irq0', O(OB.CTRL_TMR)), E('tick', O(OB.CTRL_TMR), O(OB.CTRL_TICK)), E('tick_ctrl', O(OB.CTRL_TICK), T(TH.CTRL)),
    E('wq', 'irq0', O(OB.SYSWQ)), E('wq_t', O(OB.SYSWQ), T(TH.SYSWQ)),
    E('spi', 'irq1', O(OB.SPI_DONE)), E('spi_s', O(OB.SPI_DONE), T(TH.SENSOR)),
    E('sq_put', T(TH.SENSOR), O(OB.SAMPLE_Q)), E('sq_get', O(OB.SAMPLE_Q), T(TH.CTRL)),
    E('eth', 'irq2', O(OB.RX_FIFO)), E('fifo_get', O(OB.RX_FIFO), T(TH.NET)),
    E('c_lock', T(TH.CTRL), O(OB.BUS_LOCK)), E('s_lock', T(TH.STORAGE), O(OB.BUS_LOCK)),
    E('c_mtx', T(TH.CTRL), O(OB.BUS_MTX)), E('s_mtx', T(TH.STORAGE), O(OB.BUS_MTX)),
    E('net_heap', T(TH.NET), O(OB.HEAP)), E('st_heap', T(TH.STORAGE), O(OB.HEAP)), E('main_heap', T(TH.MAIN), O(OB.HEAP)),
    E('main_cfg', T(TH.MAIN), O(OB.CFG_MTX)),
    E('zprof_rtt', T(TH.ZPROF), 'rtt'), E('log_rtt', T(TH.LOGGING), 'rtt'),
  ]
  flow.setGraph(nodes, edges)

  // ---------------------------------------------------------------- events to particles
  const counts = new Map<string, number>()
  const hit = (id: string) => { counts.set(id, (counts.get(id) ?? 0) + 1); flow.pulse(id) }
  const offEv = sim.onEvent((R, id) => {
    const k = id & (R.cap - 1)
    const api = R.api[k], res = R.res[k], o = R.obj[k], th = threadOfLane(R.ctx[k])
    const took = res === RS.OK || res === RS.WOKE
    switch (o) {
      case OB.CTRL_TMR: if (api === AP.EXPIRY) hit('tmr'); break
      case OB.CTRL_TICK: if (api === AP.SEM_GIVE) hit('tick'); else if (took) hit('tick_ctrl'); break
      case OB.SYSWQ: if (api === AP.WORK_SUBMIT) { hit('wq'); hit('wq_t') } break
      case OB.SPI_DONE: if (api === AP.SEM_GIVE) hit('spi'); else if (took) hit('spi_s'); break
      case OB.SAMPLE_Q: if (api === AP.MSGQ_PUT) hit('sq_put'); else if (api === AP.MSGQ_GET && R.aux[k] > 0) hit('sq_get'); break
      case OB.RX_FIFO: if (api === AP.FIFO_PUT) hit('eth'); else if (took) hit('fifo_get'); break
      case OB.BUS_LOCK: if (api === AP.SEM_TAKE && (took || res === RS.BLOCKS)) hit(th === TH.CTRL ? 'c_lock' : 's_lock'); break
      case OB.BUS_MTX: if (api === AP.MTX_LOCK && (took || res === RS.BLOCKS)) hit(th === TH.CTRL ? 'c_mtx' : 's_mtx'); break
      case OB.HEAP: hit(th === TH.NET ? 'net_heap' : th === TH.STORAGE ? 'st_heap' : 'main_heap'); break
      case OB.CFG_MTX: if (api === AP.MTX_LOCK) hit('main_cfg'); break
    }
  })

  // ---------------------------------------------------------------- live node state
  let last: Heartbeat | null = sim.heartbeats[sim.heartbeats.length - 1] ?? null
  let rateT = performance.now()
  const thrState = (i: number) => {
    const s = last?.threads[i]
    const eff = sim.threadPrio(i)
    const boosted = eff !== THREADS[i].prio
    return { s, eff, boosted }
  }
  const refreshNodes = () => {
    const now = sim.now / 1000
    const recentInv = sim.jobs.filter((j) => j.end > now - 1000 && j.inv > 0).length
    const recentMiss = sim.jobs.filter((j) => j.end > now - 1000 && j.miss).length
    for (let i = 0; i < TH.IDLE; i++) {
      const { s, eff, boosted } = thrState(i)
      flow.setNodeState(T(i), {
        gauge: s ? s.cpuPct / 25 : 0,
        text: s ? `${s.cpuPct.toFixed(1)}% cpu, ${s.state}` : '',
        tag: boosted ? `prio ${eff} (${THREADS[i].prio})` : `prio ${eff}`,
        alarm: i === TH.CTRL && recentMiss ? 'crit' : i === TH.NET && recentInv ? 'warn' : boosted ? 'info' : null,
      })
    }
    OBJECTS.forEach((d, o) => {
      const st = sim.objectState(o)
      const w = st.waiters.length
      let text = '', gauge: number | undefined, alarm: 'warn' | 'crit' | null = null
      if (d.kind === 'msgq' || d.kind === 'fifo') { text = `${st.depth}/${d.cap}, peak ${st.peak}`; gauge = st.depth / d.cap }
      else if (o === OB.BUS_LOCK || o === OB.BUS_MTX || o === OB.CFG_MTX) {
        text = st.owner >= 0 ? `held by ${THREADS[st.owner].name}` : 'free'
        if (w) text += `, ${w} waiting`
        if (o === OB.BUS_LOCK && recentInv) alarm = 'crit'
        else if (w) alarm = 'warn'
      } else if (d.kind === 'sem') text = `count ${st.count}${w ? `, ${w} waiting` : ''}`
      else if (d.kind === 'heap') { const h = sim.heap; text = `${(h.used / 1024).toFixed(1)} / 24 KiB, frag ${(h.fragmentation * 100).toFixed(0)}%`; gauge = h.used / h.bytes }
      else if (d.kind === 'timer') text = `period ${sim.period} us`
      else if (d.kind === 'work') text = `${st.ops} items`
      flow.setNodeState(O(o), { text, gauge, alarm, tag: d.kind === 'mutex' ? 'k_mutex' : d.kind === 'sem' ? 'k_sem' : `k_${d.kind}` })
    })
    if (last) flow.setNodeState('rtt', { text: `${(last.linkBps / 1000).toFixed(0)} kB/s`, gauge: last.linkBps / LINK_BUDGET_BPS })
    flow.setEdgeAlarm('c_lock', recentInv ? 'crit' : null)
    flow.setEdgeAlarm('s_lock', recentInv ? 'crit' : null)
    const dt = (performance.now() - rateT) / 1000
    if (dt >= 1) {
      for (const e of edges) flow.setEdgeRate(e.id, (counts.get(e.id) ?? 0) / dt)
      if (last) { flow.setEdgeRate('zprof_rtt', 10); flow.setEdgeRate('log_rtt', last.threads[TH.LOGGING].switchesPerS) }
      counts.clear()
      rateT = performance.now()
    }
  }
  const offHb = sim.onHeartbeat((h) => {
    last = h
    flow.pulse('zprof_rtt', 0)
    if (h.threads[TH.LOGGING].switchesPerS > 0) flow.pulse('log_rtt', 0)
  })
  flow.setInfo((id) => {
    if (id === 'rtt') return ['RTT up-buffer 1 to the bridge', last ? `${(last.linkBps / 1000).toFixed(0)} kB/s, ${((last.linkBps / LINK_BUDGET_BPS) * 100).toFixed(0)}% of budget` : '']
    if (id.startsWith('irq')) { const k = Number(id.slice(3)); const s = last?.irqs[k]; return [`ISR ${IRQS[k]}`, s ? `${s.perS.toFixed(0)}/s, ${s.pct.toFixed(2)}% CPU, max ${s.maxUs.toFixed(1)} us` : ''] }
    if (id.startsWith('t')) {
      const i = Number(id.slice(1)), { s, eff } = thrState(i)
      return [`${THREADS[i].name}, prio ${THREADS[i].prio}${eff !== THREADS[i].prio ? `, running at ${eff} (priority inheritance)` : ''}`, s ? `${s.cpuPct.toFixed(2)}% CPU, ${s.switchesPerS.toFixed(0)} switches/s` : '', s ? `stack ${s.stackHwm} / ${s.stackSize} B watermark` : '', 'click: open in Trace']
    }
    const o = Number(id.slice(1)), d = OBJECTS[o], st = sim.objectState(o)
    return [`${d.name} (${d.kind})`, d.note, `${st.ops} calls, ${st.blocks} blocked`, st.maxWaitUs ? `worst wait ${st.maxWaitUs.toFixed(0)} us` : '', st.maxHoldUs ? `longest hold ${st.maxHoldUs.toFixed(0)} us` : ''].filter(Boolean)
  })
  flow.addEventListener('nodeclick', () => go('trace'))

  // ---------------------------------------------------------------- sunburst and inspector
  const refreshSun = () => {
    const R = sim.events
    const by = new Map<string, number>()
    const t0 = sim.now / 1000 - 10_000
    for (let id = R.lowerBound(t0); id < R.total; id++) {
      const k = id & (R.cap - 1)
      const o = R.obj[k]
      if (o < 0) continue
      const key = `${o}|${R.api[k]}`
      by.set(key, (by.get(key) ?? 0) + 1)
    }
    const kinds = new Map<string, Map<number, HierarchyNodeData[]>>()
    for (const [key, n] of by) {
      const [o, api] = key.split('|').map(Number)
      const kind = OBJECTS[o].kind
      if (!kinds.has(kind)) kinds.set(kind, new Map())
      const objs = kinds.get(kind)!
      if (!objs.has(o)) objs.set(o, [])
      objs.get(o)!.push({ name: API[api], value: n })
    }
    sun.setData({ name: 'calls', children: [...kinds].map(([kind, objs]) => ({ name: `k_${kind}`, children: [...objs].map(([o, apis]) => ({ name: OBJECTS[o].name, children: apis })) })) })
  }
  let prevOps = OBJECTS.map((_, o) => sim.objectState(o).ops), prevBlocks = OBJECTS.map((_, o) => sim.objectState(o).blocks), prevT = performance.now()
  const refreshGrid = () => {
    const dt = (performance.now() - prevT) / 1000
    prevT = performance.now()
    const head = ['Object', 'Type', 'State', 'Peak', 'Waiters', 'Calls/s', 'Blocks/s', 'Worst wait', 'Longest hold', 'Note']
    const rows: CellContent[][] = OBJECTS.map((d, o) => {
      const st = sim.objectState(o)
      const ops = (st.ops - prevOps[o]) / dt, blk = (st.blocks - prevBlocks[o]) / dt
      prevOps[o] = st.ops
      prevBlocks[o] = st.blocks
      const state = d.kind === 'msgq' || d.kind === 'fifo' ? `${st.depth} / ${d.cap}` : st.owner >= 0 ? `held by ${THREADS[st.owner].name}` : d.kind === 'sem' ? `count ${st.count}` : d.kind === 'heap' ? `${(sim.heap.used / 1024).toFixed(1)} KiB used` : d.kind === 'timer' ? `${sim.period} us` : ''
      return [
        { text: d.name, textColor: oc(o).setA(255) }, d.kind === 'heap' ? 'sys_heap' : `k_${d.kind}`, state,
        d.kind === 'msgq' || d.kind === 'fifo' ? String(st.peak) : '', st.waiters.map((w) => THREADS[w].name).join(', '),
        ops.toFixed(0), blk ? blk.toFixed(1) : '', st.maxWaitUs ? `${st.maxWaitUs.toFixed(0)} us` : '', st.maxHoldUs ? `${st.maxHoldUs.toFixed(0)} us` : '', d.note,
      ]
    })
    grid.setTableContent([head, ...rows])
    grid.setColumnWidth(9, { min: 260 })
  }
  refreshSun()
  refreshGrid()
  refreshNodes()
  const timer = setInterval(() => { refreshNodes() }, 200)
  const slow = setInterval(() => { refreshSun(); refreshGrid() }, 2000)

  return () => {
    clearInterval(timer)
    clearInterval(slow)
    offEv()
    offHb()
    dash.dispose()
  }
}

