/** Deterministic PRNG (mulberry32) so every reload shows the same synthetic story. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export type Rng = ReturnType<typeof rng>

export const gauss = (r: Rng) => {
  let u = 0, v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
export const uniform = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r()
export const expo = (r: Rng, mean: number) => -Math.log(1 - r()) * mean

/** p-quantile of an ascending array. */
export function quantile(sorted: ArrayLike<number>, p: number) {
  const n = sorted.length
  if (!n) return NaN
  const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/** Ordinary least squares y = a + b x with the 95% half-width of b (normal approximation). */
export function linfit(xs: ArrayLike<number>, ys: ArrayLike<number>) {
  const n = xs.length
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n, my = sy / n
  let sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my) }
  const b = sxy / sxx, a = my - b * mx
  let sse = 0
  for (let i = 0; i < n; i++) sse += (ys[i] - a - b * xs[i]) ** 2
  const se = Math.sqrt(sse / Math.max(1, n - 2) / sxx)
  return { a, b, ci95: 1.96 * se }
}

/** Regularized lower incomplete gamma P(s, x) by series / continued fraction. */
function gammaP(s: number, x: number): number {
  if (x <= 0) return 0
  const lg = lgamma(s)
  if (x < s + 1) {
    let sum = 1 / s, term = sum
    for (let k = 1; k < 500; k++) { term *= x / (s + k); sum += term; if (term < sum * 1e-14) break }
    return sum * Math.exp(-x + s * Math.log(x) - lg)
  }
  let b = x + 1 - s, c = 1e300, d = 1 / b, h = d
  for (let k = 1; k < 500; k++) {
    const an = -k * (k - s)
    b += 2
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return 1 - Math.exp(-x + s * Math.log(x) - lg) * h
}
function lgamma(z: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61503916999185,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z)
  z -= 1
  let x = c[0]
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}
/** Chi-square quantile: smallest x with CDF(x; k) >= p (bisection). */
export function chi2inv(p: number, k: number) {
  let lo = 0, hi = Math.max(10, k * 10)
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2
    if (gammaP(k / 2, m / 2) < p) lo = m
    else hi = m
  }
  return (lo + hi) / 2
}

/**
 * One-sided lower confidence bound on MTBF for a time-terminated test:
 * MTBF_L = 2T / chi2(C; 2r + 2). With r = 0 this is the zero-failure bound.
 */
export const mtbfLower = (hours: number, failures: number, conf: number) => (2 * hours) / chi2inv(conf, 2 * failures + 2)
