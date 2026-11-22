// SPDX-License-Identifier: Apache-2.0
import type { Color, Theme } from 'sferic'

/** Status levels shared by every widget (spec section 7: thresholds and alarms). */
export type Status = 'ok' | 'warn' | 'crit' | 'info' | 'idle'

export function statusColor(t: Theme, s: Status): Color {
  const [bad, mid, good] = t.examples.badGoodColorPalette
  switch (s) {
    case 'crit': return bad
    case 'warn': return mid
    case 'ok': return good
    case 'info': return t.examples.highlightColor
    default: return t.minorTickLabelColor
  }
}

/**
 * Higher-is-worse classification against optional warn / crit thresholds, as
 * used by BulletChart rows (thresholds already converted to "used" units).
 */
export function classify(v: number, warn?: number, crit?: number): Status {
  if (crit !== undefined && v >= crit) return 'crit'
  if (warn !== undefined && v >= warn) return 'warn'
  return 'ok'
}

/**
 * Shape glyph drawn next to a status color so state never depends on hue alone:
 * ok = circle, warn = triangle, crit = square, info = diamond, idle = ring.
 */
export function drawStatusGlyph(ctx: CanvasRenderingContext2D, s: Status, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  switch (s) {
    case 'ok': ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); break
    case 'warn': ctx.moveTo(cx, cy - r * 1.1); ctx.lineTo(cx + r * 1.1, cy + r * 0.9); ctx.lineTo(cx - r * 1.1, cy + r * 0.9); ctx.closePath(); ctx.fill(); break
    case 'crit': ctx.rect(cx - r * 0.9, cy - r * 0.9, r * 1.8, r * 1.8); ctx.fill(); break
    case 'info': ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill(); break
    default: ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.restore()
}
