/**
 * Chunk-level model of a Zephyr sys_heap for the heap X-ray: 8-byte chunk
 * units, one header chunk per allocation, coalescing on free. sys_heap really
 * splits from size buckets; address-ordered first fit is close enough to show
 * how long-lived blocks pin the free space into fragments.
 *
 * The host can rebuild this map without touching target memory: the k_heap
 * alloc/free tracing hooks give address, size and the calling thread.
 */
export const CHUNK = 8

export interface HeapBlock { start: number; units: number; bytes: number; owner: number; t: number }

export class HeapSim {
  readonly units: number
  /** Per chunk unit: 0 free, 1 header, 2 + owner thread index. */
  readonly cell: Uint8Array
  private free: { s: number; n: number }[]
  private blocks = new Map<number, HeapBlock>()
  /** Allocated bytes including headers. */
  used = 0
  peak = 0
  failures = 0
  allocs = 0
  frees = 0
  /** Bumps on every change, so views can skip redundant texture uploads. */
  version = 0

  constructor(readonly bytes: number) {
    this.units = Math.floor(bytes / CHUNK)
    this.cell = new Uint8Array(this.units)
    this.free = [{ s: 0, n: this.units }]
  }

  /** Returns the start unit, or -1 when no free run is large enough. */
  alloc(bytes: number, owner: number, t: number): number {
    const n = Math.ceil(bytes / CHUNK) + 1
    const f = this.free
    for (let i = 0; i < f.length; i++) {
      if (f[i].n < n) continue
      const s = f[i].s
      f[i].s += n
      f[i].n -= n
      if (!f[i].n) f.splice(i, 1)
      this.cell[s] = 1
      this.cell.fill(2 + owner, s + 1, s + n)
      this.blocks.set(s, { start: s, units: n, bytes, owner, t })
      this.used += n * CHUNK
      if (this.used > this.peak) this.peak = this.used
      this.allocs++
      this.version++
      return s
    }
    this.failures++
    return -1
  }

  release(s: number) {
    const b = this.blocks.get(s)
    if (!b) return
    this.blocks.delete(s)
    this.cell.fill(0, s, s + b.units)
    this.used -= b.units * CHUNK
    this.frees++
    this.version++
    // Insert sorted, then coalesce with neighbours.
    const f = this.free
    let i = 0
    while (i < f.length && f[i].s < s) i++
    f.splice(i, 0, { s, n: b.units })
    if (i + 1 < f.length && f[i].s + f[i].n === f[i + 1].s) { f[i].n += f[i + 1].n; f.splice(i + 1, 1) }
    if (i > 0 && f[i - 1].s + f[i - 1].n === f[i].s) { f[i - 1].n += f[i].n; f.splice(i, 1) }
  }

  get freeBytes() { return this.bytes - this.used }
  get largestFree() { return this.free.reduce((a, f) => Math.max(a, f.n), 0) * CHUNK }
  /** 1 - largest free / total free: 0 means one contiguous free run. */
  get fragmentation() { const fb = this.freeBytes; return fb > 0 ? 1 - this.largestFree / fb : 0 }
  get freeRuns() { return this.free.length }
  get blockCount() { return this.blocks.size }
  block(s: number) { return this.blocks.get(s) }
  /** Block containing chunk unit `u`, if allocated. */
  blockAt(u: number): HeapBlock | undefined {
    if (!this.cell[u]) return undefined
    let s = u
    while (s > 0 && this.cell[s] !== 1) s--
    return this.blocks.get(s)
  }
  forEachBlock(fn: (b: HeapBlock) => void) { for (const b of this.blocks.values()) fn(b) }
  liveByOwner(n: number) {
    const out = new Array(n).fill(0)
    for (const b of this.blocks.values()) out[b.owner] += b.units * CHUNK
    return out
  }
}
