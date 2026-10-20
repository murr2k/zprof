export const pct = (v: number, d = 1) => `${v.toFixed(d)}`
export const us = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v.toFixed(v < 10 ? 1 : 0)} us`)
export const kib = (b: number, d = 1) => `${(b / 1024).toFixed(d)}`
export const rate = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : v >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(0))
export const bytesRate = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} MB/s` : `${(bps / 1e3).toFixed(0)} kB/s`)
export function hms(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
/** Duration in target ms for cursors: picks us / ms / s. */
export function durMs(ms: number) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)} us`
  if (ms < 1000) return `${ms.toFixed(3)} ms`
  return `${(ms / 1000).toFixed(3)} s`
}
export const hours = (h: number) => (h < 1 ? `${(h * 60).toFixed(0)} min` : `${h.toFixed(1)} h`)
