import { ColorRGBA, SolidFill, SolidLine, type Color, type Theme } from 'sferic'

export interface ViewContext {
  container: HTMLElement
  theme: Theme
}
export type View = (ctx: ViewContext) => () => void

/** Thread index (THREADS order) -> theme series color slot; idle is drawn dim. */
const THREAD_SLOTS = [7, 4, 0, 2, 3, 1, 6, 5]
export function threadColor(t: Theme, i: number): Color {
  if (i >= THREAD_SLOTS.length) return t.isDark ? ColorRGBA(120, 132, 156, 110) : ColorRGBA(150, 158, 175, 120)
  return t.seriesColors[THREAD_SLOTS[i] % t.seriesColors.length]
}
export function irqColor(t: Theme, k: number): Color {
  const white = ColorRGBA(255, 255, 255, 255)
  return [t.seriesColors[9], t.seriesColors[8], t.seriesColors[3].mix(white, 0.45)][k] ?? t.seriesColors[0]
}

export const line = (c: Color, thickness = 1) => new SolidLine({ thickness, fillStyle: new SolidFill({ color: c }) })
export const fill = (c: Color) => new SolidFill({ color: c })
