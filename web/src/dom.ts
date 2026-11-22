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
/** A number with an optional unit after it ("12.5 %", "1,024 KB", "3/s"). */
const LEAD_NUM = /^([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[-+]?\.\d+)\s*(?:%|[a-zA-Zµ°]+(?:\/[a-zA-Z]+)?|\/[a-zA-Z]+)?$/
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const sortKey = (s: string): number | string | null => {
  const t = s.trim()
  if (!t) return null
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16)
  const m = LEAD_NUM.exec(t)
  return m ? parseFloat(m[1].replace(/,/g, '')) : t
}

/**
 * An HTML table whose heading cells (th) sort its rows, as the grid tables do (charts/dataTable):
 * numbers largest first, text A to Z, a second click reverses, a third restores the order the
 * view wrote. Rows with one cell (a placeholder) stay put. The view may rewrite the rows at
 * any time (innerHTML, textContent): the sort is applied again by itself.
 */
export function sortableTable(table: HTMLTableElement): HTMLTableElement {
  let col = -1
  let dir: 1 | -1 = 1
  const bodyRows = () => [...table.rows].filter((r) => !r.querySelector('th') && r.cells.length > 1)
  const isNumeric = (rows: HTMLTableRowElement[], c: number) => rows.every((r) => typeof sortKey(r.cells[c]?.textContent ?? '') !== 'string')
  const apply = () => {
    const head = [...table.rows].find((r) => r.querySelector('th'))
    if (head) [...head.cells].forEach((c, i) => { c.classList.toggle('sort-asc', i === col && dir > 0); c.classList.toggle('sort-desc', i === col && dir < 0) })
    const rows = bodyRows()
    if (rows.length < 2) return
    // the view's order: rows written since the last pass are numbered in the order they stand
    if (rows.some((r) => !r.dataset.order)) rows.forEach((r, i) => { r.dataset.order = String(i) })
    let sorted = [...rows].sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order))
    if (col >= 0) {
      const numeric = isNumeric(sorted, col)
      const keys = new Map(sorted.map((r) => {
        const txt = r.cells[col]?.textContent ?? ''
        const k = sortKey(txt)
        return [r, k === null ? null : numeric ? k : txt.trim()] as const
      }))
      // stable: equal keys keep the view's order
      sorted = sorted.sort((a, b) => {
        const ka = keys.get(a)!, kb = keys.get(b)!
        if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1
        return (numeric ? (ka as number) - (kb as number) : collator.compare(ka as string, kb as string)) * dir
      })
    }
    if (sorted.every((r, i) => r === rows[i])) return
    const parent = rows[0].parentElement!
    for (const r of sorted) parent.appendChild(r)
  }
  const mo = new MutationObserver(() => { apply(); mo.takeRecords() })
  mo.observe(table, { childList: true, subtree: true })
  table.addEventListener('click', (e) => {
    const th = (e.target as Element).closest('th')
    if (!th || !table.contains(th)) return
    const i = th.cellIndex
    const first: 1 | -1 = isNumeric(bodyRows(), i) ? -1 : 1
    if (col !== i) { col = i; dir = first }
    else if (dir === first) dir = first < 0 ? 1 : -1
    else col = -1
    apply()
    mo.takeRecords()
  })
  table.classList.add('sortable')
  apply()
  return table
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
