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
import { targetSim, LINK_BUDGET_BPS, type Heartbeat } from './sim/target'
import { liveTarget } from './views/liveTarget'
import { liveSched } from './views/liveSched'
import { liveTiming } from './views/liveTiming'
import { liveLinkIfOpen } from './live/link'
import { button, segmented } from './dom'
import { bytesRate } from './format'
import { ICONS } from './icons'
import { setNavigator } from './nav'

interface Entry {
  id: string
  name: string
  icon: string
  view: View
  /** Real data from a target through the bridge; every other view is the mockup on the simulator. */
  live?: boolean
  /** Live counts for a rail badge (crit wins the color). */
  badge?: () => { crit: number; warn: number }
}
const GROUPS: { role: string; views: Entry[] }[] = [
  { role: 'Intelligence', views: [
    { id: 'insights', name: 'Insights', icon: 'insights', view: insightsView, badge: () => insights().summary() },
  ] },
  // Real data from a target through the zprof bridge; the groups below are the mockup's simulated views.
  { role: 'Target', views: [
    { id: 'target', name: 'Live target', icon: 'live', view: liveTarget, live: true },
    { id: 'sched', name: 'Schedulability', icon: 'timing', view: liveSched, live: true },
    { id: 'ltiming', name: 'Timing', icon: 'trace', view: liveTiming, live: true },
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
  watchLive()
  renderHeader()
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
// It describes only what the current view shows: the real target on a live view, the
// simulator's invented one on a mockup view, never both.
const sim = targetSim()
const modeEl = document.getElementById('mode')!
const chip = (k: string, v: string, cls = '') => `<span class="chip ${cls}">${k} <b>${v}</b></span>`
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
let lastHb: Heartbeat | null = null

// What the target records (the bridge's presets): on live views, for a live target.
// Rebuilt only when the choices or the target's answer change, so it is never
// replaced under the pointer.
const presetsEl = document.getElementById('presets')!
let presetsSig = ''
function renderPresets() {
  const st = current.live ? liveLinkIfOpen()?.status : null
  const ok = !!(st && st.control && st.presets?.length)
  const sig = ok ? `${st!.presets!.map((p) => p.id).join(',')}|${st!.preset}|${st!.want}` : ''
  if (sig === presetsSig) return
  presetsSig = sig
  presetsEl.hidden = !ok
  presetsEl.replaceChildren()
  if (!ok) return
  const ps = st!.presets!
  presetsEl.append(Object.assign(document.createElement('span'), { textContent: 'recording' }))
  const seg = segmented(ps.map((p) => [p.id, p.title] as [string, string]), st!.preset ?? '', (id) => liveLinkIfOpen()?.setPreset(id))
  for (const b of seg.el.querySelectorAll('button')) {
    const p = ps.find((x) => x.title === b.textContent)
    if (p) b.title = p.note
  }
  presetsEl.append(seg.el)
  if (!st!.preset && st!.classes !== null && st!.classes !== undefined) {
    presetsEl.append(Object.assign(document.createElement('span'), { textContent: `classes 0x${st!.classes.toString(16)}` }))
  }
  presetsEl.append(capEl)
}

// Capture-then-upload: the board records into its own buffer with nothing on the
// network, then uploads it. The button and the Stop are rebuilt only when the state
// changes; the progress text is updated in place.
const capEl = Object.assign(document.createElement('span'), { className: 'rec-capture' })
let capSig = ''
let capText: HTMLSpanElement | null = null
const mb = (b: number) => (b / 1048576).toFixed(1)
function renderCapture() {
  const st = current.live ? liveLinkIfOpen()?.status : null
  const c = st?.control ? st.capture : null
  const ok = !!(c && c.capacity > 0 && c.state !== 4)
  const busy = ok && (c!.state === 1 || c!.state === 2)
  const sig = ok ? (busy ? String(c!.state) : 'idle') : ''
  if (sig !== capSig) {
    capSig = sig
    capEl.replaceChildren()
    capText = null
    if (ok && !busy) {
      capEl.append(button('Capture', () => liveLinkIfOpen()?.capture(0), 'btn tiny',
        `Record into the board's own ${mb(c!.capacity)} MB buffer with nothing sent meanwhile, ` +
        'then upload it: no record lost to the sender or the network (until full or Stop)'))
    } else if (busy) {
      capText = document.createElement('span')
      capEl.append(capText)
      if (c!.state === 1) capEl.append(button('Stop', () => liveLinkIfOpen()?.captureStop(), 'btn tiny'))
    }
  }
  if (capText && c) {
    capText.textContent = c.state === 1
      ? `capturing ${mb(c.bytes)} of ${mb(c.capacity)} MB, ${(c.ms / 1000).toFixed(1)} s`
      : `uploading ${mb(c.bytes)} MB`
  }
}

function renderHeader() {
  const rl = document.getElementById('railLink')
  renderPresets()
  renderCapture()
  if (current.live) {
    modeEl.textContent = 'live target'
    const l = liveLinkIfOpen()
    if (!l || l.state !== 'open' || !l.hello) {
      targetEl.innerHTML = chip('bridge', l ? l.state : 'not opened', 'opt')
      if (rl) rl.textContent = 'no target'
      return
    }
    const h = l.hello, s = l.stats[l.stats.length - 1], st = l.status
    const build = h.elf ? (h.elf_ok === false ? 'OTHER BUILD' : h.elf_ok ? 'the board\'s build' : '') : 'no ELF'
    const down = st?.link === 'down'
    const pill = down
      ? `<span class="chip pill warn" title="${esc(st!.why)}"><span class="dot"></span>${h.source === 'replay' ? 'recording' : 'TCP'} <b>${h.source === 'replay' ? 'ended' : 'reconnecting'}</b></span>`
      : `<span class="chip pill"><span class="dot"></span>${h.source === 'replay' ? 'recording' : 'TCP'} <b>${s ? `${s.kbytes_s.toFixed(0)} KB/s` : '...'}</b></span>`
    const sessions = st && st.sessions > 1 ? chip('sessions', `${st.sessions}${st.reboots ? `, ${st.reboots} reboot(s)` : ''}`, 'opt') : ''
    targetEl.innerHTML =
      chip(h.source === 'replay' ? 'replay' : 'target', esc(h.target)) +
      chip('zephyr', esc(h.kernel)) +
      chip('elf', `${esc(h.elf ?? '')} ${build}`.trim(), h.elf_ok === false ? '' : 'opt') +
      sessions + pill
    if (rl) rl.textContent = down ? `link down: ${st!.why}` : h.source === 'replay' ? 'replaying a recording' : 'target streaming'
    return
  }
  modeEl.textContent = 'mockup, synthetic data'
  const hb = lastHb
  if (!hb) return
  const util = (hb.linkBps / LINK_BUDGET_BPS) * 100
  targetEl.innerHTML =
    chip('simulated', 'synthetic target', 'opt') +
    chip('fw', 'v1.5.0-rc1 g3f9c2e1', 'opt') +
    chip('zephyr', 'main a915b2f1', 'opt') +
    `<span class="chip pill"><span class="dot"></span>RTT ch1 <b>${bytesRate(hb.linkBps)}</b> ${util.toFixed(0)}%</span>`
  if (rl) rl.textContent = `simulated, up ${Math.floor(hb.uptimeMs / 3.6e6)} h ${Math.floor((hb.uptimeMs % 3.6e6) / 60000)} min`
}

// Live views refresh the header from the bridge link once a live view has opened it.
let liveWatched = false
function watchLive() {
  const l = liveLinkIfOpen()
  if (liveWatched || !l) return
  liveWatched = true
  const refresh = () => { if (current.live) renderHeader() }
  l.onHello(refresh)
  l.onState(refresh)
  l.onStats(refresh)
  l.onStatus(refresh)
}

sim.onHeartbeat((h) => {
  if (h.seq % 5) return
  lastHb = h
  if (!current.live) renderHeader()
})

refreshBadges()
render()
