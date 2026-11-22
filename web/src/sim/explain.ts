// SPDX-License-Identifier: Apache-2.0
import { CTRL_BUDGET_US, IRQS, OBJECTS, THREADS, TH, type Job } from './target'

/**
 * Plain-language account of one job's response time, built only from the
 * job's decomposition (Job.isr / pre / holderRan / inv). The fix suggestions
 * name a registered parameter when one exists, so the UI can offer to try it.
 */
export type Tone = 'crit' | 'warn' | 'ok' | 'info' | 'dim'
export interface Explanation {
  headline: string
  status: 'crit' | 'warn' | 'ok'
  lines: { text: string; tone: Tone }[]
  fix: { text: string; param?: { id: string; value: number } } | null
}

const f0 = (v: number) => v.toFixed(0)

export function explainJob(j: Job): Explanation {
  const th = THREADS[j.thread]
  const lines: Explanation['lines'] = []
  const isr = j.isr.reduce((a, b) => a + b, 0)
  lines.push({ text: `Started ${f0(j.lat)} us after release; own execution ${f0(j.exec)} us.`, tone: 'info' })
  if (isr >= 5) {
    const parts = IRQS.map((n, k) => [n, j.isr[k]] as const).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1])
    lines.push({ text: `ISRs took ${f0(isr)} us (${parts.map(([n, v]) => `${n} ${f0(v)}`).join(', ')}).`, tone: isr > 100 ? 'warn' : 'dim' })
  }
  const pre = THREADS.map((d, i) => ({ d, i, v: j.pre[i] })).filter((x) => x.v >= 5).sort((a, b) => b.v - a.v)
  for (const p of pre) {
    if (p.i === TH.SYSWQ) lines.push({ text: `sysworkq is cooperative (prio -1): its ${f0(p.v)} us work item ran to completion before ${th.name} could start.`, tone: p.v > 150 ? 'warn' : 'dim' })
    else lines.push({ text: `Preempted by ${p.d.name} (prio ${p.d.prio}) for ${f0(p.v)} us.`, tone: 'dim' })
  }
  const lock = j.lock >= 0 ? OBJECTS[j.lock] : null
  if (lock && (j.holderRan > 0 || j.inv > 0)) {
    const h = j.holder >= 0 ? THREADS[j.holder] : null
    lines.push({ text: `Waited on ${lock.name} (${lock.kind === 'mutex' ? 'k_mutex' : 'k_sem as a lock'}) held by ${h ? `${h.name} (prio ${h.prio})` : 'another thread'}; the holder ran ${f0(j.holderRan)} us of it.`, tone: 'warn' })
  }
  if (j.inv > 0) {
    const by = THREADS.map((d, i) => ({ d, v: j.invBy[i] })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)
    const holder = j.holder >= 0 ? THREADS[j.holder] : null
    lines.push({
      text: `Priority inversion: ${by.map((x) => `${x.d.name} (prio ${x.d.prio})`).join(', ')} ran ${f0(j.inv)} us while ${th.name} (prio ${th.prio}) waited on a prio ${holder?.prio ?? '?'} holder.`,
      tone: 'crit',
    })
  }
  let fix: Explanation['fix'] = null
  if (j.inv > 0 && lock && lock.kind !== 'mutex') {
    fix = { text: 'Guard the bus with a k_mutex: priority inheritance runs the holder at the waiter\'s priority, so the wait is bounded by the critical section.', param: { id: 'storage.bus_mutex', value: 1 } }
  } else if (lock && j.holderRan > 150) {
    fix = { text: 'Shorten the critical section: a smaller storage write chunk halves the hold.', param: { id: 'storage.chunk', value: 128 } }
  } else if (j.pre[TH.SYSWQ] > 150) {
    fix = { text: 'Move the long item off the cooperative system work queue to a preemptible work queue (k_work_queue_start with a priority below ctrl_loop), or split it.' }
  }
  const status = j.miss ? 'crit' : j.inv > 0 ? 'warn' : 'ok'
  const headline = `${th.name} job ${j.id}: response ${f0(j.resp)} us${j.miss ? ` > ${CTRL_BUDGET_US} us deadline` : j.thread === TH.CTRL ? ` (deadline ${CTRL_BUDGET_US} us)` : ''}`
  return { headline, status, lines, fix }
}
