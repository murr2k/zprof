import { insights, type Insight } from '../sim/insights'
import { targetSim } from '../sim/target'
import { go } from '../nav'
import { el, esc, glyph } from '../dom'
import type { View } from './common'

/** Inline SVG sparkline: cheap enough to rebuild every second for a dozen cards. */
function spark(v: number[], color: string) {
  if (v.length < 2) return ''
  const w = 150, h = 30
  let lo = Math.min(...v), hi = Math.max(...v)
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((y - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`).join(' ')
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`
}

const ago = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 60_000).toFixed(1)} min`)

/**
 * Insights: the ranked findings of the rule engine, each with its evidence,
 * a trend, links into the views that show it, and a parameter to try when
 * the registry has one. Nothing here writes to the target: "Try" only stages
 * the change in Watch & Tune.
 */
export const insightsView: View = ({ container }) => {
  const eng = insights()
  const root = el('div', 'insights')
  container.appendChild(root)
  let list: Insight[] = []
  const color = (s: string) => getComputedStyle(document.documentElement).getPropertyValue(s === 'crit' ? '--crit' : s === 'warn' ? '--warn' : '--accent').trim()
  const render = () => {
    list = eng.list
    const sum = eng.summary()
    const info = list.length - sum.crit - sum.warn
    root.innerHTML = `
      <div class="ins-head">
        <h2>Insights</h2>
        <span class="count">${glyph('crit')} ${sum.crit} critical</span>
        <span class="count">${glyph('warn')} ${sum.warn} warnings</span>
        <span class="count">${glyph('info')} ${info} notes</span>
        <span class="note" style="color:var(--dim);font-size:12px">rules run every second over the live trace, jobs and heartbeats; severities from config/zprof.thresholds.json</span>
      </div>
      <div class="ins-grid">${list.map((x, i) => card(x, i)).join('') || '<p>No findings: every rule is inside its thresholds.</p>'}</div>`
  }
  const card = (x: Insight, i: number) => {
    const g = x.sev === 'info' ? 'info' : x.sev
    const age = x.since ? ago(Math.max(0, targetSim().now / 1000 - x.since)) : ''
    return `<div class="ins ${x.sev}">
      <h3>${glyph(g)}<span>${esc(x.title)}</span></h3>
      <div class="meta">${x.sev.toUpperCase()}${age ? ` &middot; raised ${age} ago, held ${x.held} evaluations` : ' &middot; from the soak record'}</div>
      <p>${esc(x.detail)}</p>
      <ul>${x.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      ${x.spark ? `<div class="spark">${spark(x.spark, color(x.sev))}<span>${esc(x.sparkLabel ?? '')}</span></div>` : ''}
      <div class="acts">
        ${x.links.map((l, k) => `<button class="btn" data-i="${i}" data-link="${k}">${esc(l.label)}</button>`).join('')}
        ${x.action ? `<button class="btn primary" data-i="${i}" data-act="1" title="Opens Watch & Tune with the change staged; nothing is sent">${esc(x.action.label)}</button>` : ''}
      </div>
    </div>`
  }
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b || b.dataset.i === undefined) return
    const x = list[Number(b.dataset.i)]
    if (!x) return
    if (b.dataset.act) go('tune', { param: x.action!.param, label: x.title })
    else { const l = x.links[Number(b.dataset.link)]; go(l.view, l.focus) }
  })
  const off = eng.onChange(render)
  render()
  return () => off()
}
