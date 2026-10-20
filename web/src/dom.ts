import type { Status } from './charts/status'

/** Minimal DOM builders for view chrome (toolbars, cards, forms). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}
export function button(label: string, onClick: () => void, cls = 'btn', title = '') {
  const b = el('button', cls, label)
  b.type = 'button'
  if (title) b.title = title
  b.onclick = onClick
  return b
}
/** Segmented control; returns a setter for the active value. */
export function segmented<T extends string>(items: [T, string][], value: T, onChange: (v: T) => void) {
  const wrap = el('div', 'seg')
  const btns = items.map(([v, label]) => {
    const b = button(label, () => { set(v); onChange(v) })
    wrap.appendChild(b)
    return [v, b] as const
  })
  const set = (v: T) => { for (const [k, b] of btns) b.classList.toggle('on', k === v) }
  set(value)
  return { el: wrap, set }
}
export function select<T extends string>(items: [T, string][], value: T, onChange: (v: T) => void) {
  const s = el('select', 'sel')
  for (const [v, label] of items) {
    const o = el('option', '', label)
    o.value = v
    s.appendChild(o)
  }
  s.value = value
  s.onchange = () => onChange(s.value as T)
  return s
}

/** Status glyph as inline SVG: color plus shape (spec section 7.1). */
export function glyph(s: Status | 'info', size = 10) {
  const shape: Record<string, string> = {
    ok: '<circle cx="5" cy="5" r="4.2"/>',
    warn: '<path d="M5 0.6 9.6 9H0.4z"/>',
    crit: '<rect x="0.8" y="0.8" width="8.4" height="8.4"/>',
    info: '<path d="M5 0.4 9.6 5 5 9.6 0.4 5z"/>',
    idle: '<circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  }
  return `<svg class="st-${s}" width="${size}" height="${size}" viewBox="0 0 10 10" fill="currentColor" aria-label="${s}">${shape[s] ?? shape.idle}</svg>`
}
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
