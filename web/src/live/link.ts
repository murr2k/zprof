/**
 * The page's connection to the zprof bridge (`python -m zprof_bridge serve`,
 * ws://127.0.0.1:8786 unless ?bridge= says otherwise).
 *
 * The bridge sends a hello (the target and the timeline's lanes), binary
 * timeline batches every 50 ms and a statistics record per second of target
 * time. A new hello (a thread or interrupt appeared) is followed by the whole
 * retained timeline again, so subscribers rebuild on hello. Opened only when a
 * live view asks for it, so a page without a bridge stays quiet.
 */

export interface LiveLane {
  name: string
  kind: 'irq' | 'thread'
  prio: number | null
  sender: boolean
  idle: boolean
  /** Share of the bridge's retained window spent running (for colors). */
  cpu_pct?: number
}
export interface LiveHello {
  type: 'hello'
  source: 'live' | 'replay'
  target: string
  kernel: string
  ts_hz: number
  ring_kb: number
  hook_ns: number
  elf: string | null
  elf_ok: boolean | null
  lanes: LiveLane[]
  retain_ms: number
  /** New after the target rebooted: the timeline starts over. */
  epoch: number
}
/** What the target records, by task (the bridge's presets). */
export interface LivePreset { id: string; title: string; classes: number; note: string }
/** The bridge's link to the target (not the page's link to the bridge), and what it records. */
export interface LiveStatus {
  type: 'status'
  link: 'connecting' | 'up' | 'down'
  why: string
  sessions: number
  reboots: number
  source: 'live' | 'replay'
  target: string
  /** A live target can be told what to record; a replay cannot. */
  control?: boolean
  presets?: LivePreset[]
  /** The kernel-object classes the target records now (its own answer), and their preset if any. */
  classes?: number | null
  preset?: string | null
  /** What the page asked for (applied again at every new session). */
  want?: number | null
}
/** One thread or interrupt in the schedulability analysis; times in us. */
export interface SchedRow {
  key: string
  name: string
  kind: 'thread' | 'irq'
  prio: number
  coop: boolean
  periodic: boolean
  t_us: number | null
  j_us: number
  c_us: number
  c_mean_us: number
  c_p99_us: number
  s_us: number
  b_us: number
  b_meas_us: number
  b_by: string
  d_us: number | null
  d_src: 'declared' | 'period' | null
  /** Its deadline is in the verdict (declared ones are, when any are). */
  counts: boolean
  /** A job is one declared period of the thread's work (a loop with no one release object). */
  per_period: boolean
  jobs: number
  discarded: number
  rate_s: number
  u_pct: number
  r_meas_us: number | null
  r_p99_us: number | null
  sender: boolean
  /** Seconds into the observation when its longest job ended. */
  c_max_at: number | null
  /** Its jobs come from the application's marks of this name (zprof.h). */
  marks: string | null
  /** Its event loop: where it waits (call site and object), and how often it blocks inside a handler. */
  loop: SchedLoop | null
  /** The response-time bound; null with bounded false: none (the load can grow without limit). */
  r_us: number | null
  bounded: boolean
  slack_pct?: number | null
  status?: 'ok' | 'warn' | 'crit' | 'idle'
  grow_us?: number
  parts?: { c?: number; s?: number; b?: number; q?: number; by?: [string, number][] }
}
export interface SchedLoop {
  /** ao: one wait point, run to completion; ao-inside: one event wait point, blocks inside some
   * handlers; multi: several wait points (a sequential loop); marked: jobs from application marks. */
  shape: 'ao' | 'ao-inside' | 'multi' | 'marked'
  wait_points: number
  /** Share of its events whose handling blocked on something else. */
  inside_pct: number
  /** The firmware sent call sites (else wait points are objects only). */
  sites: boolean
  points: [string, number][]
  inside_by: [string, number][]
}
export interface SchedRec { level: 'crit' | 'warn' | 'info'; task: string; title: string; detail: string; advice: string }
export interface LiveSched {
  type: 'sched'
  rows: SchedRow[]
  deadlines: number
  misses: number
  worst_slack_pct: number | null
  worst_task: string | null
  u_pct: number
  u_rm_pct: number
  ll_pct: number
  observed_s: number
  jobs: number
  discarded: number
  gaps: number
  whatif: boolean
  scale?: number | null
  /** A priority order (Audsley) that meets every deadline: thread -> new priority (changes only). */
  order?: Record<string, number> | null
  order_found?: boolean
  recs: SchedRec[]
  deadlines_src?: Record<string, string>
  preset?: string | null
  req?: number
}
/** What-if changes to one thread: priority, worst execution, period, deadline. */
export interface SchedOverride { prio?: number; c_us?: number; t_us?: number; d_us?: number }
export interface LiveThreadStat {
  lane: number | null
  name: string
  prio: number | null
  cpu_pct: number
  net_pct: number
  switches_s: number
  wake_mean_us: number | null
  wake_p99_us: number | null
  wake_max_us: number | null
  sender: boolean
}
export interface LiveIrqStat { lane: number | null; name: string; per_s: number; cpu_pct: number; mean_us: number | null; max_us: number }
export interface LiveObjStat {
  name: string
  cls: string
  calls: string
  calls_s: number
  blocks_s: number
  /** Calls that returned without the object: a timeout, -EBUSY, an empty poll, a NULL get. */
  without: number
  wait_mean_us: number | null
  wait_max_us: number | null
  /** Share of the window threads spent blocked on it (summed over threads). */
  wait_pct: number
  /** For a k_timer the "wait" is its expiry function's run time. */
  timer: boolean
  /** A mutex some thread blocked on (another held it): contention, not a thread's rest. */
  contended: boolean
}
export interface LiveStats {
  type: 'stats'
  t_ms: number
  secs: number
  busy_pct: number
  isr_pct: number
  wfi_pct: number
  events_s: number
  kbytes_s: number
  dropped: number
  dropped_total: number
  self_pct: number
  hooks_pct: number
  threads: LiveThreadStat[]
  irqs: LiveIrqStat[]
  objects?: LiveObjStat[]
}
/** Timeline intervals, times in ms from the session start. */
export interface IntervalBatch { n: number; t0: Float64Array; t1: Float64Array; lane: Uint16Array; code: Uint8Array; tMax: number }
/** BLOCKED: on a mutex another thread held; WAITING: for an event (a thread's normal rest). */
export const CODE = { RUN: 0, READY: 1, ISR: 2, DROP: 3, BLOCKED: 4, WAITING: 5 } as const
export type LinkState = 'connecting' | 'waiting' | 'open' | 'closed'

type Off = () => void
const MAGIC = 0x3156495a // "ZIV1" little-endian

export function decodeBatch(buf: ArrayBuffer): IntervalBatch | null {
  const dv = new DataView(buf)
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) return null
  const n = dv.getUint32(4, true)
  const t0 = new Float64Array(buf, 8, n)
  const t1 = new Float64Array(buf, 8 + 8 * n, n)
  const lane = new Uint16Array(buf, 8 + 16 * n, n)
  const code = new Uint8Array(buf, 8 + 18 * n, n)
  let tMax = -Infinity
  for (let i = 0; i < n; i++) if (t1[i] > tMax) tMax = t1[i]
  return { n, t0, t1, lane, code, tMax }
}

export class LiveLink {
  state: LinkState = 'connecting'
  hello: LiveHello | null = null
  /** The bridge's link to the target: down while the bridge re-makes it. */
  status: LiveStatus | null = null
  readonly stats: LiveStats[] = []
  private helloSig = ''
  private readonly statusL = new Set<(s: LiveStatus) => void>()
  private batches: IntervalBatch[] = []
  private ws: WebSocket | null = null
  private retry = 1000
  private timer = 0
  private readonly helloL = new Set<(h: LiveHello) => void>()
  private readonly batchL = new Set<(b: IntervalBatch) => void>()
  private readonly statsL = new Set<(s: LiveStats) => void>()
  private readonly stateL = new Set<(s: LinkState) => void>()
  private readonly schedL = new Set<(s: LiveSched) => void>()
  /** The last schedulability analysis of the measured system (every few seconds). */
  sched: LiveSched | null = null
  private req = 0
  private readonly pending = new Map<number, (s: LiveSched) => void>()

  constructor(readonly url: string) { this.open() }

  private setState(s: LinkState) {
    if (s === this.state) return
    this.state = s
    for (const f of this.stateL) f(s)
  }

  private open() {
    this.setState('connecting')
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => { this.retry = 1000; this.setState('waiting') }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.text(JSON.parse(e.data))
      else this.binary(e.data as ArrayBuffer)
    }
    ws.onclose = () => {
      this.ws = null
      this.setState('closed')
      this.timer = window.setTimeout(() => this.open(), this.retry)
      this.retry = Math.min(this.retry * 2, 10_000)
    }
  }

  private text(m: { type: string }) {
    if (m.type === 'hello') {
      const h = m as LiveHello
      // The same lanes in the same timeline (a reconnect of the bridge to the target, or
      // of this page to the bridge): keep what is drawn and carry on. Different lanes or
      // a reboot of the target (a new epoch): subscribers rebuild.
      const sig = `${h.epoch}|${h.lanes.map((l) => `${l.kind}:${l.name}`).join(',')}`
      this.hello = h
      this.setState('open')
      if (sig === this.helloSig) return
      this.helloSig = sig
      this.batches = []
      for (const f of this.helloL) f(h)
    } else if (m.type === 'status') {
      this.status = m as LiveStatus
      for (const f of this.statusL) f(this.status)
    } else if (m.type === 'stats') {
      const s = m as LiveStats
      this.stats.push(s)
      if (this.stats.length > 120) this.stats.shift()
      for (const f of this.statsL) f(s)
    } else if (m.type === 'sched') {
      const s = m as LiveSched
      if (s.req !== undefined && s.req !== null) {
        const f = this.pending.get(s.req)
        this.pending.delete(s.req)
        f?.(s)
        return
      }
      this.sched = s
      for (const f of this.schedL) f(s)
    } else if (m.type === 'waiting') {
      this.setState('waiting')
    }
  }

  /** A message to the bridge; false when the page is not connected to one. */
  send(m: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(m))
    return true
  }

  /** Ask the target to record a preset's classes (the bridge keeps the choice). */
  setPreset(id: string) { return this.send({ type: 'preset', id }) }

  /** The measured system with these changes, analysed by the bridge. */
  whatIf(overrides: Record<string, SchedOverride>): Promise<LiveSched> {
    const req = ++this.req
    return new Promise((resolve, reject) => {
      if (!this.send({ type: 'whatif', req, overrides })) { reject(new Error('no bridge')); return }
      this.pending.set(req, resolve)
      window.setTimeout(() => { if (this.pending.delete(req)) reject(new Error('the bridge did not answer')) }, 15_000)
    })
  }

  private binary(buf: ArrayBuffer) {
    const b = decodeBatch(buf)
    if (!b || !b.n) return
    this.batches.push(b)
    const keep = (this.hello?.retain_ms ?? 12_000)
    while (this.batches.length > 1 && this.batches[0].tMax < b.tMax - keep) this.batches.shift()
    for (const f of this.batchL) f(b)
  }

  /** The retained timeline since the last hello, oldest first. */
  replay(fn: (b: IntervalBatch) => void) { for (const b of this.batches) fn(b) }

  onHello(f: (h: LiveHello) => void): Off { this.helloL.add(f); return () => this.helloL.delete(f) }
  onBatch(f: (b: IntervalBatch) => void): Off { this.batchL.add(f); return () => this.batchL.delete(f) }
  onStats(f: (s: LiveStats) => void): Off { this.statsL.add(f); return () => this.statsL.delete(f) }
  onState(f: (s: LinkState) => void): Off { this.stateL.add(f); return () => this.stateL.delete(f) }
  onStatus(f: (s: LiveStatus) => void): Off { this.statusL.add(f); return () => this.statusL.delete(f) }
  onSched(f: (s: LiveSched) => void): Off { this.schedL.add(f); return () => this.schedL.delete(f) }

  close() {
    clearTimeout(this.timer)
    if (this.ws) { this.ws.onclose = null; this.ws.close() }
  }
}

let link: LiveLink | null = null
/** The page's bridge link, opened on first use. */
export function liveLink(): LiveLink {
  if (!link) {
    const q = new URLSearchParams(location.search).get('bridge')
    link = new LiveLink(q ?? 'ws://127.0.0.1:8786')
  }
  return link
}
export const liveLinkIfOpen = () => link
