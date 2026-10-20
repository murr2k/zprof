import type { Theme } from 'sferic'
import type { AnatomyRow, AnatomySeg } from '../charts/AnatomyChart'
import { statusColor } from '../charts/status'
import { IRQS, THREADS, type Job } from '../sim/target'
import { fmtFull } from '../charts/SequenceTrace'
import { irqColor, threadColor } from './common'

/** Decomposition segments of a job, own execution first, so delays stack toward the deadline line. */
export function anatomySegs(t: Theme, j: Job): AnatomySeg[] {
  const segs: AnatomySeg[] = [{ name: `own execution (${THREADS[j.thread].name})`, us: j.exec, color: threadColor(t, j.thread) }]
  THREADS.forEach((d, i) => { if (j.pre[i] >= 1) segs.push({ name: `preempted: ${d.name}`, us: j.pre[i], color: threadColor(t, i).setA(200) }) })
  IRQS.forEach((n, k) => { if (j.isr[k] >= 1) segs.push({ name: `ISR ${n}`, us: j.isr[k], color: irqColor(t, k) }) })
  if (j.holderRan > 0 && j.holder >= 0) segs.push({ name: `lock held: ${THREADS[j.holder].name} ran`, us: j.holderRan, color: threadColor(t, j.holder), hatch: true })
  if (j.inv > 0) segs.push({ name: 'priority inversion', us: j.inv, color: statusColor(t, 'crit'), hatch: true })
  return segs
}

export function anatomyRow(t: Theme, j: Job): AnatomyRow {
  return {
    id: j.id,
    label: `${THREADS[j.thread].name} #${j.id}`,
    sub: fmtFull(j.release),
    segs: anatomySegs(t, j),
    status: j.miss ? 'crit' : j.inv > 0 ? 'warn' : 'ok',
  }
}
