import { Themes, type Theme } from 'sferic'
import type { View } from './views/common'
import { engineeringLive } from './views/engineeringLive'
import { engineeringProfile } from './views/engineeringProfile'
import { engineeringTrace } from './views/engineeringTrace'
import { engineeringTiming } from './views/engineeringTiming'
import { debugTune } from './views/debugTune'
import { engineeringObjects } from './views/engineeringObjects'
import { engineeringMemory } from './views/engineeringMemory'
import { engineeringHeadroom } from './views/engineeringHeadroom'
import { reliabilityHelix } from './views/reliabilityHelix'
import { insightsView } from './views/insightsView'
import { insights } from './sim/insights'
import { reliabilitySoak } from './views/reliabilitySoak'
import { reliabilityCompare } from './views/reliabilityCompare'
import { targetSim, LINK_BUDGET_BPS } from './sim/target'
import { bytesRate } from './format'
import { ICONS } from './icons'
import { setNavigator } from './nav'

interface Entry {
  id: string
  name: string
  icon: string
  view: View
  /** Live counts for a rail badge (crit wins the color). */
  badge?: () => { crit: number; warn: number }
}
const GROUPS: { role: string; views: Entry[] }[] = [
  { role: 'Intelligence', views: [
    { id: 'insights', name: 'Insights', icon: 'insights', view: insightsView, badge: () => insights().summary() },
  ] },
  { role: 'Engineering', views: [
    { id: 'live', name: 'Live', icon: 'live', view: engineeringLive },
    { id: 'trace', name: 'Trace', icon: 'trace', view: engineeringTrace },
    { id: 'timing', name: 'Timing', icon: 'timing', view: engineeringTiming },
    { id: 'objects', name: 'Objects', icon: 'objects', view: engineeringObjects },
    { id: 'memory', name: 'Memory', icon: 'memory', view: engineeringMemory },
    { id: 'headroom', name: 'Headroom 3D', icon: 'headroom', view: engineeringHeadroom },
    { id: 'profile', name: 'Profile', icon: 'profile', view: engineeringProfile },
  ] },
  { role: 'Debug', views: [
    { id: 'tune', name: 'Watch & Tune', icon: 'tune', view: debugTune },
  ] },
  { role: 'Reliability', views: [
    { id: 'soak', name: 'Soak run', icon: 'soak', view: reliabilitySoak },
    { id: 'helix', name: 'Thermal helix', icon: 'helix', view: reliabilityHelix },
    { id: 'compare', name: 'Build compare', icon: 'compare', view: reliabilityCompare },
  ] },
]
const ALL = GROUPS.flatMap((g) => g.views)

const viewEl = document.getElementById('view')!
const railEl = document.getElementById('rail')!
const crumbEl = document.getElementById('crumb')!
const targetEl = document.getElementById('target')!
const themeBtn = document.getElementById('theme') as HTMLButtonElement

const params = new URLSearchParams(location.search)
let themeName: 'storm' | 'daylight' = params.get('theme') === 'light' ? 'daylight' : 'storm'
let current: Entry = ALL.find((e) => e.id === location.hash.slice(1)) ?? ALL[0]
let cleanup: (() => void) | null = null

const store = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

function render() {
  cleanup?.()
  cleanup = null
  viewEl.replaceChildren()
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;inset:0'
  viewEl.appendChild(host)
  const theme: Theme = Themes[themeName]
  document.documentElement.dataset.theme = themeName === 'daylight' ? 'light' : 'dark'
  themeBtn.textContent = themeName === 'daylight' ? 'Dark' : 'Light'
  for (const b of railEl.querySelectorAll<HTMLButtonElement>('.item')) b.classList.toggle('active', b.dataset.id === current.id)
  const g = GROUPS.find((x) => x.views.includes(current))!
  crumbEl.innerHTML = `${g.role} / <b>${current.name}</b>`
  cleanup = current.view({ container: host, theme })
}

function show(id: string) {
  const e = ALL.find((x) => x.id === id)
  if (!e) return
  if (e !== current) {
    current = e
    history.replaceState(null, '', `${location.search}#${e.id}`)
  }
  render()
}
setNavigator(show)

// ---------------------------------------------------------------- rail
const badges = new Map<Entry, HTMLElement>()
for (const g of GROUPS) {
  const role = document.createElement('div')
  role.className = 'role'
  role.textContent = g.role
  railEl.appendChild(role)
  for (const v of g.views) {
    const b = document.createElement('button')
    b.className = 'item'
    b.dataset.id = v.id
    b.title = v.name
    b.innerHTML = `${ICONS[v.icon] ?? ''}<span class="label">${v.name}</span>`
    if (v.badge) {
      const s = document.createElement('span')
      s.className = 'badge'
      s.hidden = true
      b.appendChild(s)
      badges.set(v, s)
    }
    b.onclick = () => { if (current !== v) show(v.id) }
    railEl.appendChild(b)
  }
}
const spacer = document.createElement('div')
spacer.className = 'spacer'
const foot = document.createElement('div')
foot.className = 'foot'
foot.innerHTML = '<span class="dot"></span><span id="railLink">target running</span>'
const collapse = document.createElement('button')
collapse.className = 'collapse'
collapse.title = 'Collapse the rail'
collapse.innerHTML = `${ICONS.collapse}<span class="label">Collapse</span>`
collapse.onclick = () => {
  const c = railEl.classList.toggle('collapsed')
  store.set('zprof.rail', c ? 'collapsed' : 'open')
  // Charts size from their container: let them see the new width.
  window.dispatchEvent(new Event('resize'))
}
railEl.append(spacer, foot, collapse)
if (store.get('zprof.rail') === 'collapsed') railEl.classList.add('collapsed')

const refreshBadges = () => {
  for (const [e, el] of badges) {
    const c = e.badge!()
    const n = c.crit + c.warn
    el.hidden = n === 0
    el.textContent = String(n)
    el.classList.toggle('crit', c.crit > 0)
    el.title = `${c.crit} critical, ${c.warn} warnings`
  }
}
const badgeTimer = setInterval(refreshBadges, 1000)
window.addEventListener('beforeunload', () => clearInterval(badgeTimer))

themeBtn.onclick = () => {
  themeName = themeName === 'storm' ? 'daylight' : 'storm'
  const q = themeName === 'daylight' ? '?theme=light' : ''
  history.replaceState(null, '', `${location.pathname}${q}#${current.id}`)
  render()
}
window.addEventListener('hashchange', () => {
  const e = ALL.find((x) => x.id === location.hash.slice(1))
  if (e && e !== current) show(e.id)
})

// Target identity and link health: the common header every view shares (spec section 5.1).
const sim = targetSim()
const chip = (k: string, v: string, cls = '') => `<span class="chip ${cls}">${k} <b>${v}</b></span>`
sim.onHeartbeat((h) => {
  if (h.seq % 5) return
  const util = (h.linkBps / LINK_BUDGET_BPS) * 100
  targetEl.innerHTML =
    chip('targets', 'Zynq PS, STM32N6570-DK (synthetic data)', 'opt') +
    chip('fw', 'v1.5.0-rc1 g3f9c2e1', 'opt') +
    chip('zephyr', 'main a915b2f1', 'opt') +
    `<span class="chip pill"><span class="dot"></span>RTT ch1 <b>${bytesRate(h.linkBps)}</b> ${util.toFixed(0)}%</span>`
  const rl = document.getElementById('railLink')
  if (rl) rl.textContent = `up ${Math.floor(h.uptimeMs / 3.6e6)} h ${Math.floor((h.uptimeMs % 3.6e6) / 60000)} min`
})

refreshBadges()
render()
