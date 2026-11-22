// SPDX-License-Identifier: Apache-2.0
import raw from '../../config/zprof.thresholds.json'
import type { Status } from './charts/status'

/**
 * The project thresholds file (config/zprof.thresholds.json, spec section 7).
 * Every rule reads: breach when value <op> threshold. crit breach -> crit
 * (FAIL for criteria, BLOCK for the gate), warn breach -> warn.
 */
export type Op = '>=' | '>' | '<=' | '<'
export interface Rule { metric: string; op: Op; warn?: number; crit?: number; unit?: string; title?: string; note?: string }
export interface Criterion extends Rule {
  id: string
  title: string
  agg: 'count' | 'max' | 'min' | 'last' | 'slope'
  per?: 'run' | 'dut'
  judge?: 'point' | 'interval'
  confidence?: number
  warmupHours?: number
  minWindowHours?: number
}
export interface GateRule extends Rule { mode: 'absolute' | 'delta' | 'delta_pct' }
export interface ThresholdsFile { version: 1; name?: string; description?: string; live: Rule[]; criteria: Criterion[]; gate: GateRule[] }

export const thresholds = raw as unknown as ThresholdsFile

export const breaches = (op: Op, v: number, t: number) =>
  op === '>=' ? v >= t : op === '>' ? v > t : op === '<=' ? v <= t : v < t

/** Status of a value against one rule; NaN means "not evaluable". */
export function ruleStatus(r: Rule, v: number): Status {
  if (!Number.isFinite(v)) return 'idle'
  if (r.crit !== undefined && breaches(r.op, v, r.crit)) return 'crit'
  if (r.warn !== undefined && breaches(r.op, v, r.warn)) return 'warn'
  return 'ok'
}

/** '*' in a rule matches exactly one dotted segment of the concrete metric ID. */
const matches = (pattern: string, id: string) => {
  const p = pattern.split('.'), s = id.split('.')
  return p.length === s.length && p.every((x, i) => x === '*' || x === s[i])
}

/** Most specific live rule for a concrete metric ID (fewest wildcards wins). */
export function liveRule(id: string): Rule | undefined {
  return thresholds.live
    .filter((r) => matches(r.metric, id))
    .sort((a, b) => a.metric.split('*').length - b.metric.split('*').length)[0]
}
/** Live status of a concrete metric; 'idle' when no rule covers it. */
export const level = (id: string, v: number): Status => {
  const r = liveRule(id)
  return r ? ruleStatus(r, v) : 'idle'
}

/**
 * Bullet-chart thresholds in "used" units for a resource of `size`. Margin
 * rules (stack.*.margin, lower is worse) and peak rules (*.peak_pct) are
 * both expressed as a share of capacity used.
 */
export function usedLimits(id: string, size: number): { warn?: number; crit?: number } {
  const r = liveRule(id)
  if (!r) return {}
  const lowerIsWorse = r.op === '<' || r.op === '<='
  const f = (t?: number) => (t === undefined ? undefined : size * (lowerIsWorse ? 1 - t / 100 : t / 100))
  return { warn: f(r.warn), crit: f(r.crit) }
}

export const criterion = (id: string) => {
  const c = thresholds.criteria.find((x) => x.id === id)
  if (!c) throw new Error(`zprof thresholds: no criterion "${id}"`)
  return c
}
export const gateRule = (metric: string) => thresholds.gate.find((g) => g.metric === metric)

const PASS_OP: Record<Op, string> = { '>': '<=', '>=': '<', '<': '>=', '<=': '>' }
/** Human text for a rule's pass condition, e.g. "<= 425 us (fail > 500)". */
export function limitText(r: Rule) {
  const u = !r.unit || r.unit === 'count' ? '' : r.unit === '%' ? '%' : ` ${r.unit}`
  if (r.warn !== undefined) return `${PASS_OP[r.op]} ${r.warn}${u}${r.crit !== undefined ? ` (fail ${r.op} ${r.crit})` : ''}`
  return `${PASS_OP[r.op]} ${r.crit}${u}`
}
