// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-view navigation: one view hands another a focus (a time, a job, a
 * parameter to prefill) and switches to it. The target view takes the focus
 * once when it is built.
 */
export interface Focus {
  /** Target time in ms (the timeline's X units). */
  t?: number
  /** Job id to select (sim Job.id). */
  job?: number
  /** Short reason shown by the receiving view. */
  label?: string
  /** Watch & Tune: parameter to prefill. */
  param?: { id: string; value: number }
}

let pending: { view: string; focus: Focus } | null = null
let navigate: (view: string) => void = (view) => { location.hash = view }

/** Installed by main.ts so a hash change and an in-app jump share one path. */
export function setNavigator(fn: (view: string) => void) { navigate = fn }

export function go(view: string, focus?: Focus) {
  pending = focus ? { view, focus } : null
  navigate(view)
}

export function takeFocus(view: string): Focus | null {
  if (!pending || pending.view !== view) return null
  const f = pending.focus
  pending = null
  return f
}
