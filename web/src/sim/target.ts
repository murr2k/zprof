import { expo, gauss, rng, uniform, quantile } from './rng'
import { HeapSim } from './heap'

/**
 * Synthetic Zephyr target for the mockup: an event-driven, preemptive priority
 * scheduler simulated at microsecond resolution. Threads run small programs of
 * kernel calls (k_sem, k_msgq, k_fifo, k_mutex, k_work, k_malloc) against
 * modelled kernel objects. Mutexes do priority inheritance; the SPI1 bus is
 * guarded by a k_sem instead, a deliberate bug: when net_rx preempts storage
 * while ctrl_loop waits for the bus, the wait is unbounded (priority
 * inversion). ctrl_loop closes a PI speed loop around a simulated motor, and
 * the host can retune it at run time through the agent's parameter registry.
 *
 * It emits what the zprof bridge would hand the browser (PLANS.md section 5):
 * intervals (thread run / ready / blocked, ISR spans), kernel events, job
 * records with a response-time decomposition, watch samples in target time,
 * and a heartbeat Sample bundle every 100 ms. Nothing here talks to hardware.
 */

export interface ThreadDef { name: string; prio: number; stack: number; base: number }
export const THREADS: ThreadDef[] = [
  { name: 'sysworkq', prio: -1, stack: 2048, base: 1180 },
  { name: 'main', prio: 0, stack: 2048, base: 1020 },
  { name: 'sensor_rx', prio: 2, stack: 1536, base: 880 },
  { name: 'ctrl_loop', prio: 3, stack: 2048, base: 1560 },
  { name: 'net_rx', prio: 5, stack: 3072, base: 2080 },
  { name: 'storage', prio: 8, stack: 4096, base: 2900 },
  { name: 'zprof', prio: 12, stack: 1536, base: 1100 },
  { name: 'logging', prio: 14, stack: 2048, base: 1320 },
  { name: 'idle', prio: 15, stack: 320, base: 180 },
]
export const IRQS = ['sys_clock', 'spi0_dma', 'eth0']
export const IDLE = THREADS.length - 1
/** Thread indices, for views that single threads out. */
export const TH = { SYSWQ: 0, MAIN: 1, SENSOR: 2, CTRL: 3, NET: 4, STORAGE: 5, ZPROF: 6, LOGGING: 7, IDLE } as const
const { SYSWQ, MAIN, SENSOR, CTRL, NET, STORAGE, ZPROF, LOGGING } = TH

/** Gantt lanes: IRQ lanes on top, then threads by priority. */
export const LANES = [...IRQS.map((n) => `IRQ ${n}`), ...THREADS.map((t) => t.name)]
export const laneOfThread = (i: number) => IRQS.length + i
export const threadOfLane = (l: number) => l - IRQS.length
/** Interval state ids (IntervalSeries states are built in the same order). */
export const ST_RUN0 = 0 // + thread index
export const ST_READY = THREADS.length
export const ST_IRQ0 = ST_READY + 1 // + irq index
export const ST_MISS = ST_IRQ0 + IRQS.length
export const ST_OVERRUN = ST_MISS + 1
/** Waiting for a lock (mutex or a semaphore used as one). */
export const ST_BLOCKED = ST_OVERRUN + 1

export const CTRL_BUDGET_US = 500
/** zprof link: RTT planning number from PLANS.md section 8. */
export const LINK_BUDGET_BPS = 2_000_000
// CTF with 10-byte headers: a switch is two 34 B events, an ISR two 10 B events, and a kernel
// call an enter / exit pair of about 14 B each (object id; more with timeout and return fields).
export const SWITCH_BYTES = 68, ISR_BYTES = 20, EVENT_BYTES = 28, HEARTBEAT_BYTES = 450
/** The board has been up 3 h 12 min when the page opens. */
export const BOOT_OFFSET_MS = (3 * 3600 + 12 * 60) * 1000

// ---------------------------------------------------------------- kernel objects

export type ObjKind = 'timer' | 'sem' | 'msgq' | 'fifo' | 'mutex' | 'work' | 'heap'
export interface ObjDef { name: string; kind: ObjKind; cap: number; note: string }
export const OBJECTS: ObjDef[] = [
  { name: 'ctrl_tmr', kind: 'timer', cap: 0, note: 'k_timer, period ctrl.period_us; expiry gives ctrl_tick' },
  { name: 'ctrl_tick', kind: 'sem', cap: 1, note: 'k_sem, limit 1' },
  { name: 'spi_done', kind: 'sem', cap: 1, note: 'k_sem given by the SPI0 DMA ISR' },
  { name: 'sample_q', kind: 'msgq', cap: 8, note: 'k_msgq, 8 x 16 B sensor samples' },
  { name: 'bus_lock', kind: 'sem', cap: 1, note: 'k_sem used as the SPI1 bus lock: no priority inheritance' },
  { name: 'bus_mtx', kind: 'mutex', cap: 1, note: 'k_mutex for the SPI1 bus (A/B flag storage.bus_mutex)' },
  { name: 'rx_fifo', kind: 'fifo', cap: 64, note: 'k_fifo of net_pkt from the Ethernet ISR, 64 net_buf' },
  { name: 'cfg_mtx', kind: 'mutex', cap: 1, note: 'k_mutex for the configuration store' },
  { name: 'sysworkq', kind: 'work', cap: 0, note: 'system work queue (cooperative thread)' },
  { name: '_system_heap', kind: 'heap', cap: 24576, note: 'k_malloc heap, 24 KiB' },
]
export const OB = { CTRL_TMR: 0, CTRL_TICK: 1, SPI_DONE: 2, SAMPLE_Q: 3, BUS_LOCK: 4, BUS_MTX: 5, RX_FIFO: 6, CFG_MTX: 7, SYSWQ: 8, HEAP: 9 } as const

/** Kernel calls and marks, named as the tracing hooks name them. */
export const API = [
  'k_timer expiry', 'k_sem_give', 'k_sem_take', 'k_msgq_put', 'k_msgq_get', 'k_fifo_put', 'k_fifo_get',
  'k_mutex_lock', 'k_mutex_unlock', 'k_work_submit', 'k_malloc', 'k_free', 'zprof param', 'deadline miss',
  'priority boost', 'priority restore',
] as const
export const AP = {
  EXPIRY: 0, SEM_GIVE: 1, SEM_TAKE: 2, MSGQ_PUT: 3, MSGQ_GET: 4, FIFO_PUT: 5, FIFO_GET: 6, MTX_LOCK: 7, MTX_UNLOCK: 8,
  WORK_SUBMIT: 9, MALLOC: 10, FREE: 11, PARAM: 12, MISS: 13, BOOST: 14, RESTORE: 15,
} as const
export const RESULT = ['ok', 'blocks', 'returned after wait', 'wakes', 'full', 'failed', 'staged', 'applied', 'rejected'] as const
export const RS = { OK: 0, BLOCKS: 1, WOKE: 2, WAKES: 3, FULL: 4, FAILED: 5, STAGED: 6, APPLIED: 7, REJECTED: 8 } as const

// ---------------------------------------------------------------- parameter registry (agent side)

export interface ParamDef {
  id: string
  label: string
  kind: 'f32' | 'u32' | 'bool' | 'enum'
  min: number
  max: number
  step: number
  def: number
  unit: string
  /** Thread that applies a staged value at its safe point. */
  owner: number
  safePoint: string
  options?: string[]
  note: string
}
export const PARAMS: ParamDef[] = [
  { id: 'ctrl.kp', label: 'Speed loop Kp', kind: 'f32', min: 0, max: 0.3, step: 0.005, def: 0.06, unit: '%/rpm', owner: CTRL, safePoint: 'start of the next ctrl_loop job', note: 'Proportional gain of the PI speed loop.' },
  { id: 'ctrl.ki', label: 'Speed loop Ki', kind: 'f32', min: 0, max: 4, step: 0.05, def: 1.6, unit: '%/rpm/s', owner: CTRL, safePoint: 'start of the next ctrl_loop job', note: 'Integral gain; the integrator is clamped while the output saturates.' },
  { id: 'ctrl.kd', label: 'Speed loop Kd', kind: 'f32', min: 0, max: 0.004, step: 0.0001, def: 0, unit: '%s/rpm', owner: CTRL, safePoint: 'start of the next ctrl_loop job', note: 'Derivative gain on the error.' },
  { id: 'ctrl.period_us', label: 'Control period', kind: 'u32', min: 500, max: 2000, step: 250, def: 1000, unit: 'us', owner: CTRL, safePoint: 'next ctrl_tmr expiry (k_timer_start)', note: 'ctrl_tmr period. The 500 us response deadline stays fixed.' },
  { id: 'sensor.decim', label: 'Sensor decimation', kind: 'u32', min: 1, max: 8, step: 1, def: 1, unit: '', owner: SENSOR, safePoint: 'next sensor_rx job', note: 'Forward every Nth SPI sample to sample_q.' },
  { id: 'storage.chunk', label: 'Storage write chunk', kind: 'u32', min: 128, max: 2048, step: 128, def: 256, unit: 'B', owner: STORAGE, safePoint: 'next storage job', note: 'Bytes written per bus hold: sets the critical section length.' },
  { id: 'storage.bus_mutex', label: 'Bus lock is a k_mutex', kind: 'bool', min: 0, max: 1, step: 1, def: 0, unit: '', owner: STORAGE, safePoint: 'next storage job with the bus idle (no holder, no waiters)', note: 'A/B flag compiled into this test build. 0: k_sem (no priority inheritance). 1: k_mutex.' },
  { id: 'log.level', label: 'Log level', kind: 'enum', min: 0, max: 4, step: 1, def: 3, unit: '', owner: ZPROF, safePoint: 'immediate (log_filter_set)', options: ['off', 'err', 'wrn', 'inf', 'dbg'], note: 'Runtime filter for every log source.' },
]
export type ParamState = 'sent' | 'staged' | 'applied' | 'rejected'
export interface ParamReq {
  seq: number
  id: string
  from: number
  to: number
  /** Target ms. */
  tSent: number
  tStaged: number
  tApplied: number
  /** When the ack reaches the host (target ms). */
  tAck: number
  state: ParamState
  reason: string
}

// ---------------------------------------------------------------- records

export interface ThreadSample {
  name: string
  prio: number
  state: 'running' | 'ready' | 'pending' | 'blocked' | 'suspended'
  cpuPct: number
  runPeakUs: number
  runAvgUs: number
  switchesPerS: number
  wakeP99Us: number
  stackSize: number
  stackUsed: number
  stackHwm: number
}
export interface Heartbeat {
  t: number
  seq: number
  cpuPct: number
  isrPct: number
  threads: ThreadSample[]
  irqs: { name: string; perS: number; pct: number; maxUs: number }[]
  ctxPerS: number
  irqPerS: number
  heap: { size: number; alloc: number; maxAlloc: number; largestFree: number; frag: number; failures: number; byOwner: number[] }
  slab: { blocks: number; used: number; maxUsed: number }
  /** net_rx backlog: rx_fifo depth against the net_buf count. */
  msgq: { max: number; used: number; peak: number }
  sampleQ: { max: number; used: number; peak: number; full: number }
  logBuf: { size: number; used: number; peak: number }
  rttUp: { size: number; used: number; peak: number }
  ctrl: { p50: number; p99: number; max: number; misses: number; overruns: number }
  bus: { kind: 'k_sem' | 'k_mutex'; blocks: number; inversions: number; maxBlockUs: number; maxInvUs: number }
  plant: { sp: number; pv: number; u: number }
  linkBps: number
  framesLost: number
  framesTotal: number
  selfPct: number
  rxBytesPerS: number
  sensorSps: number
  logErrPerS: number
  logWrnPerS: number
  eventsPerS: number
  uptimeMs: number
  bootCount: number
}

/** Dominant reason a job finished later than its own execution time alone would allow. */
export type Cause = 'clean' | 'isr' | 'preempt' | 'coop' | 'blocked' | 'inversion'
export interface Job {
  id: number
  thread: number
  /** Target ms. */
  release: number
  start: number
  end: number
  /** Microseconds: response (release to end), start latency, own execution. */
  resp: number
  lat: number
  exec: number
  /** Time lost to each IRQ / each thread while the job was pending (us). */
  isr: number[]
  pre: number[]
  /** Lock wait: object, holder thread, time the holder itself ran, time medium-priority threads ran instead. */
  lock: number
  holder: number
  holderRan: number
  inv: number
  invBy: number[]
  miss: boolean
  cause: Cause
}

/** Fixed-size ring of kernel events in typed arrays; ids are absolute (monotonic). */
export class EventRing {
  readonly cap: number
  readonly t: Float64Array
  readonly ctx: Int8Array
  readonly obj: Int8Array
  readonly api: Uint8Array
  readonly res: Uint8Array
  readonly peer: Int8Array
  readonly val: Float32Array
  readonly aux: Float32Array
  /** Total events ever written; the newest has id total - 1. */
  total = 0
  constructor(bits: number) {
    this.cap = 1 << bits
    this.t = new Float64Array(this.cap)
    this.ctx = new Int8Array(this.cap)
    this.obj = new Int8Array(this.cap)
    this.api = new Uint8Array(this.cap)
    this.res = new Uint8Array(this.cap)
    this.peer = new Int8Array(this.cap)
    this.val = new Float32Array(this.cap)
    this.aux = new Float32Array(this.cap)
  }
  push(t: number, ctx: number, obj: number, api: number, res: number, peer: number, val: number, aux: number) {
    const i = this.total & (this.cap - 1)
    this.t[i] = t; this.ctx[i] = ctx; this.obj[i] = obj; this.api[i] = api; this.res[i] = res; this.peer[i] = peer; this.val[i] = val; this.aux[i] = aux
    return this.total++
  }
  get oldest() { return Math.max(0, this.total - this.cap) }
  clone() {
    const c = new EventRing(Math.log2(this.cap))
    c.t.set(this.t); c.ctx.set(this.ctx); c.obj.set(this.obj); c.api.set(this.api); c.res.set(this.res); c.peer.set(this.peer); c.val.set(this.val); c.aux.set(this.aux)
    c.total = this.total
    return c
  }
  /** Ring slot of an absolute id, or -1 once evicted. */
  slot(id: number) { return id >= this.oldest && id < this.total ? id & (this.cap - 1) : -1 }
  /** First id whose time is >= t (binary search over the retained range). */
  lowerBound(t: number) {
    let lo = this.oldest, hi = this.total
    while (lo < hi) {
      const m = (lo + hi) >>> 1
      if (this.t[m & (this.cap - 1)] < t) lo = m + 1
      else hi = m
    }
    return lo
  }
}

/** Watch samples recorded by ctrl_loop in target time (the agent's watch block). */
export class WatchRing {
  readonly cap = 1 << 15
  readonly t = new Float64Array(this.cap)
  readonly sp = new Float32Array(this.cap)
  readonly pv = new Float32Array(this.cap)
  readonly w = new Float32Array(this.cap)
  readonly u = new Float32Array(this.cap)
  readonly e = new Float32Array(this.cap)
  readonly integ = new Float32Array(this.cap)
  total = 0
  push(t: number, sp: number, pv: number, w: number, u: number, e: number, integ: number) {
    const i = this.total & (this.cap - 1)
    this.t[i] = t; this.sp[i] = sp; this.pv[i] = pv; this.w[i] = w; this.u[i] = u; this.e[i] = e; this.integ[i] = integ
    this.total++
  }
  get oldest() { return Math.max(0, this.total - this.cap) }
  slot(id: number) { return id & (this.cap - 1) }
  lowerBound(t: number) {
    let lo = this.oldest, hi = this.total
    while (lo < hi) {
      const m = (lo + hi) >>> 1
      if (this.t[m & (this.cap - 1)] < t) lo = m + 1
      else hi = m
    }
    return lo
  }
}

// ---------------------------------------------------------------- simulator internals

type IntervalFn = (lane: number, t0: number, t1: number, state: number) => void
export interface IntervalLog { lane: Uint8Array; st: Uint8Array; t0: Float64Array; t1: Float64Array; w: number; n: number }
/** Frozen copy of an interval log, for views that hold a snapshot. */
export const cloneLog = (L: IntervalLog): IntervalLog => ({ lane: L.lane.slice(), st: L.st.slice(), t0: L.t0.slice(), t1: L.t1.slice(), w: L.w, n: L.n })
type Op =
  | { k: 'run'; us: number }
  | { k: 'pend'; o: number }
  | { k: 'lock'; o: number }
  | { k: 'unlock'; o: number }
  | { k: 'lockbus' }
  | { k: 'unlockbus' }
  | { k: 'put'; o: number }
  | { k: 'get'; o: number }
  | { k: 'fn'; f: () => void }
  | { k: 'done' }

/** Threads whose activations are tracked as jobs (release to completion). */
const TRACKED = new Set<number>([SENSOR, CTRL])
/** Threads that loop on a kernel object; the others are woken by timers. */
const PEND_THREADS = new Set<number>([SYSWQ, SENSOR, CTRL, NET])

interface Th {
  ready: boolean
  work: number
  readyAt: number
  readyStart: number
  runStart: number
  wake: boolean
  prog: Op[]
  pc: number
  /** Effective priority (raised by priority inheritance). */
  prio: number
  blockedOn: number
  blockT: number
  lockWait: boolean
  resume: { api: number; o: number; since: number } | null
  /** Work item length for sysworkq, packet length for net_rx. */
  item: number
  bus: number
  // window accumulators
  runUs: number
  sw: number
  runSegStart: number
  segPeak: number
  segSum: number
  segN: number
  wakeLat: number[]
  hwm: number
}

interface Obj {
  count: number
  depth: number
  peak: number
  winPeak: number
  owner: number
  heldSince: number
  maxHold: number
  waiters: number[]
  /** Give times (us) of counted signals, so an immediate take knows its job's release. */
  giveT: number[]
  /** Payloads: sample values for sample_q, packet sizes for rx_fifo, durations for sysworkq. */
  items: number[]
  ops: number
  blocks: number
  full: number
  maxWait: number
  winOps: number
  winBlocks: number
}

interface JobAcc extends Job { active: boolean }

export class TargetSim {
  private r = rng(7)
  /** Target time, microseconds since boot. */
  now = BOOT_OFFSET_MS * 1000
  private th: Th[] = THREADS.map((d) => ({
    ready: false, work: 0, readyAt: 0, readyStart: NaN, runStart: NaN, wake: false, prog: [], pc: 0,
    prio: d.prio, blockedOn: -1, blockT: 0, lockWait: false, resume: null, item: 0, bus: -1,
    runUs: 0, sw: 0, runSegStart: NaN, segPeak: 0, segSum: 0, segN: 0, wakeLat: [], hwm: d.base,
  }))
  private obj: Obj[] = OBJECTS.map((d) => ({
    count: d.kind === 'sem' && d.name === 'bus_lock' ? 1 : 0, depth: 0, peak: 0, winPeak: 0, owner: -1, heldSince: 0, maxHold: 0,
    waiters: [], giveT: [], items: [], ops: 0, blocks: 0, full: 0, maxWait: 0, winOps: 0, winBlocks: 0,
  }))
  private cur = IDLE
  private nextIrq = [0, 0, 0]
  private nextTick: number
  private nextCtrl: number
  private spiBase: number
  private ctrlPeriod = 1000
  private tick = 0
  /** ISR context: lane and entry time while a handler runs, -1 otherwise. */
  private isrLane = -1
  private isrT0 = -1
  private isrEvT = -1
  private irqUs = [0, 0, 0]
  private irqN = [0, 0, 0]
  private irqMax = [0, 0, 0]
  private switches = 0
  private pendingLogs = 0
  private rxBytes = 0
  private sensorN = 0
  private sensorSeq = 0
  private logErr = 0
  private logWrn = 0
  private ctrlResp: number[] = []
  private misses = 0
  private overruns = 0
  private winBusBlocks = 0
  private winInv = 0
  private winMaxBlock = 0
  private winMaxInv = 0
  private qPeak = 0
  private sqPeak = 0
  private slabMax = 0
  private logPeak = 0
  private rttPeak = 0
  private seq = 0
  private framesLost = 0
  private framesTotal = 0
  private nextHb: number
  private lastHb: number
  private lastEvTotal = 0
  private burstUntil = 0
  private nextBurst: number
  private transientUntil = 0
  private nextTransient: number
  private listeners: IntervalFn[] = []
  private hbListeners: ((h: Heartbeat) => void)[] = []
  private evListeners: ((ring: EventRing, id: number) => void)[] = []
  private jobListeners: ((j: Job) => void)[] = []
  private paramListeners: ((q: ParamReq) => void)[] = []
  private jobAcc: (JobAcc | null)[] = THREADS.map(() => null)
  private jobSeq = 0
  // plant and controller
  private plantT = 0
  private x1 = 48
  private speed = 1200
  private uOut = 48
  private uNext = 48
  private integ = 30
  private ePrev = 0
  private lastCtrlT = 0
  private lastMeas = 1200
  private sensorVal = 1200
  private spPrev = 1200
  // heap bookkeeping
  readonly heap = new HeapSim(24 * 1024)
  private netHeld: { s: number; until: number; long: boolean }[] = []
  private storageBuf = -1
  // parameters
  private pv: Record<string, number> = Object.fromEntries(PARAMS.map((p) => [p.id, p.def]))
  private staged = new Map<string, ParamReq>()
  private downlink: { q: ParamReq; arrive: number }[] = []
  private reqSeq = 0

  /** Rolling ctrl_loop response times (us) for the latency histogram, last ~10 s. */
  readonly respHistory: number[] = []
  readonly wakeHistory: number[] = []
  /**
   * Retained intervals (last ~15 s) in emission order, which is t1 order to within one ISR
   * length: views binary-search it by t1 instead of keeping their own copy.
   */
  readonly ilog: IntervalLog = { lane: new Uint8Array(1 << 18), st: new Uint8Array(1 << 18), t0: new Float64Array(1 << 18), t1: new Float64Array(1 << 18), w: 0, n: 0 }
  readonly heartbeats: Heartbeat[] = []
  readonly events = new EventRing(18)
  readonly watch = new WatchRing()
  /** Completed jobs, oldest first (last ~20 s of ctrl_loop and sensor_rx). */
  readonly jobs: Job[] = []
  /** Every parameter request, oldest first. */
  readonly audit: ParamReq[] = []
  /** Setpoint steps (target ms) for the scope trigger. */
  readonly steps: { t: number; from: number; to: number }[] = []

  constructor() {
    const t = this.now
    this.nextTick = t + 1000
    this.nextCtrl = t + 1000
    this.spiBase = t + 500
    this.nextIrq = [t + 1000, this.spiBase, t + expo(this.r, 1e6 / 350)]
    this.nextHb = t + 100_000
    this.lastHb = t
    this.plantT = t
    this.lastCtrlT = t
    this.nextBurst = t + 3_000_000
    this.nextTransient = t + 5_000_000
    const idle = this.th[IDLE]
    idle.ready = true
    idle.work = Infinity
    idle.runStart = t
    idle.runSegStart = t
    // Looping threads start parked on their trigger objects.
    for (const i of PEND_THREADS) {
      this.th[i].prog = this.gen(i)
      this.th[i].pc = 1
      this.th[i].blockedOn = (this.th[i].prog[0] as { o: number }).o
      this.th[i].blockT = t
      this.obj[this.th[i].blockedOn].waiters.push(i)
    }
    this.bootHeap()
  }

  // ---------------------------------------------------------------- subscriptions

  onInterval(fn: IntervalFn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn) } }
  onHeartbeat(fn: (h: Heartbeat) => void) { this.hbListeners.push(fn); return () => { this.hbListeners = this.hbListeners.filter((f) => f !== fn) } }
  onEvent(fn: (ring: EventRing, id: number) => void) { this.evListeners.push(fn); return () => { this.evListeners = this.evListeners.filter((f) => f !== fn) } }
  onJob(fn: (j: Job) => void) { this.jobListeners.push(fn); return () => { this.jobListeners = this.jobListeners.filter((f) => f !== fn) } }
  onParam(fn: (q: ParamReq) => void) { this.paramListeners.push(fn); return () => { this.paramListeners = this.paramListeners.filter((f) => f !== fn) } }

  /** Replay retained intervals (oldest first) into a new consumer. */
  replay(fn: IntervalFn) {
    const L = this.ilog, cap = L.lane.length
    const start = (L.w - L.n + cap) % cap
    for (let k = 0; k < L.n; k++) {
      const i = (start + k) % cap
      fn(L.lane[i], L.t0[i], L.t1[i], L.st[i])
    }
  }

  /** Live kernel object state for inspectors. */
  objectState(o: number) {
    const s = this.obj[o]
    return { count: s.count, depth: s.depth, peak: s.peak, owner: s.owner, waiters: [...s.waiters], ops: s.ops, blocks: s.blocks, full: s.full, maxWaitUs: s.maxWait, maxHoldUs: s.maxHold }
  }
  threadPrio(i: number) { return this.th[i].prio }
  threadBlockedOn(i: number) { return this.th[i].blockedOn }
  get busIsMutex() { return this.pv['storage.bus_mutex'] === 1 }
  get period() { return this.ctrlPeriod }
  param(id: string) { return this.pv[id] }

  // ---------------------------------------------------------------- emission

  private emit(lane: number, a: number, b: number, st: number) {
    if (b < a) return
    const L = this.ilog, cap = L.lane.length
    const t0 = a / 1000, t1 = b / 1000
    L.lane[L.w] = lane; L.st[L.w] = st; L.t0[L.w] = t0; L.t1[L.w] = t1
    L.w = (L.w + 1) % cap
    if (L.n < cap) L.n++
    for (const f of this.listeners) f(lane, t0, t1, st)
  }
  private emitMark(lane: number, t: number, st: number) { this.emit(lane, t, t, st) }

  /** Lane of the running context: the ISR lane inside a handler, else the current thread. */
  private ctxLane() { return this.isrLane >= 0 ? this.isrLane : laneOfThread(this.cur) }
  private ev(ctx: number, o: number, api: number, res: number, peer = -1, val = 0, aux = 0) {
    const t = this.isrLane >= 0 ? this.isrEvT : this.now
    const id = this.events.push(t / 1000, ctx, o, api, res, peer, val, aux)
    if (o >= 0) { this.obj[o].ops++; this.obj[o].winOps++ }
    for (const f of this.evListeners) f(this.events, id)
  }

  // ---------------------------------------------------------------- scheduler

  /** Close the running thread's interval at `now` (ISR entry or switch-out). */
  private closeRun(i: number) {
    const t = this.th[i]
    if (t.runStart === t.runStart && this.now > t.runStart) {
      this.emit(laneOfThread(i), t.runStart, this.now, ST_RUN0 + i)
      t.runUs += this.now - t.runStart
    }
    t.runStart = NaN
  }

  private switchTo(next: number) {
    const prev = this.cur
    if (next === prev) {
      if (!(this.th[prev].runStart === this.th[prev].runStart)) this.th[prev].runStart = this.now
      return
    }
    this.closeRun(prev)
    const p = this.th[prev]
    if (p.runSegStart === p.runSegStart) {
      const seg = this.now - p.runSegStart
      if (prev !== IDLE) { p.segSum += seg; p.segN++; if (seg > p.segPeak) p.segPeak = seg }
      p.runSegStart = NaN
    }
    if (p.ready && prev !== IDLE) p.readyStart = this.now
    const n = this.th[next]
    if (n.readyStart === n.readyStart && this.now > n.readyStart) this.emit(laneOfThread(next), n.readyStart, this.now, ST_READY)
    n.readyStart = NaN
    n.runStart = this.now
    n.runSegStart = this.now
    if (n.wake) {
      n.wake = false
      const lat = this.now - n.readyAt
      n.wakeLat.push(lat)
      if (next === CTRL) { this.wakeHistory.push(lat); if (this.wakeHistory.length > 10000) this.wakeHistory.splice(0, 2000) }
    }
    this.cur = next
    if (n.resume) {
      const rs = n.resume
      n.resume = null
      this.ev(laneOfThread(next), rs.o, rs.api, RS.WOKE, -1, this.now - rs.since)
    }
    const j = this.jobAcc[next]
    if (j && !(j.start === j.start)) j.start = this.now / 1000
    n.sw++
    this.switches++
  }

  private pick(): number {
    const c = this.cur
    if (c !== IDLE && THREADS[c].prio < 0 && this.th[c].ready) return c // cooperative: keeps the CPU
    let best = IDLE
    for (let i = 0; i < IDLE; i++) if (this.th[i].ready && this.th[i].prio < this.th[best].prio) best = i
    return best
  }

  /** Make a timer-driven thread runnable with a fresh program (skipped if it is still busy). */
  private wakeProg(i: number, prog: Op[]) {
    const t = this.th[i]
    if (t.ready || t.blockedOn >= 0) return
    t.prog = prog
    t.pc = 0
    t.ready = true
    t.readyAt = this.now
    t.readyStart = this.now
    t.wake = true
    t.work = 0
  }

  /** Run thread i's zero-time ops until it starts a run op, blocks, sleeps or yields. */
  private exec(i: number) {
    const t = this.th[i]
    for (let guard = 0; guard < 64; guard++) {
      if (t.pc >= t.prog.length) {
        if (PEND_THREADS.has(i)) { t.prog = this.gen(i); t.pc = 0; continue }
        t.ready = false // back to sleep until its timer
        return
      }
      const op = t.prog[t.pc]
      switch (op.k) {
        case 'run':
          t.pc++
          t.work = op.us < 0 ? t.item : op.us
          return
        case 'fn':
          t.pc++
          op.f()
          if (this.pick() !== i) return
          break
        case 'done':
          t.pc++
          this.endJob(i)
          break
        case 'pend':
          t.pc++
          if (!this.takeNow(i, op.o)) { this.block(i, op.o, false); return }
          break
        case 'lock':
        case 'lockbus': {
          t.pc++
          const o = op.k === 'lock' ? op.o : this.busIsMutex ? OB.BUS_MTX : OB.BUS_LOCK
          if (op.k === 'lockbus') t.bus = o
          if (!this.lockNow(i, o)) { this.block(i, o, true); return }
          break
        }
        case 'unlock':
        case 'unlockbus': {
          t.pc++
          const o = op.k === 'unlock' ? op.o : t.bus
          if (this.unlock(i, o) && this.pick() !== i) return
          break
        }
        case 'put':
          t.pc++
          if (this.put(op.o, this.sensorVal) && this.pick() !== i) return
          break
        case 'get':
          t.pc++
          this.drain(i, op.o)
          break
      }
    }
  }

  private bestWaiter(o: number) {
    const w = this.obj[o].waiters
    let best = -1
    for (const i of w) if (best < 0 || this.th[i].prio < this.th[best].prio) best = i
    return best
  }

  private block(i: number, o: number, isLock: boolean) {
    const t = this.th[i], s = this.obj[o]
    t.ready = false
    t.blockedOn = o
    t.blockT = this.now
    t.lockWait = isLock
    s.waiters.push(i)
    const holder = isLock ? s.owner : -1
    if (isLock) {
      s.blocks++
      s.winBlocks++
      const j = this.jobAcc[i]
      if (j) { j.lock = o; j.holder = holder }
    }
    const kind = OBJECTS[o].kind
    const api = kind === 'mutex' ? AP.MTX_LOCK : kind === 'msgq' ? AP.MSGQ_GET : kind === 'fifo' ? AP.FIFO_GET : kind === 'work' ? -1 : AP.SEM_TAKE
    if (api >= 0) this.ev(laneOfThread(i), o, api, RS.BLOCKS, holder >= 0 ? laneOfThread(holder) : -1)
    if (isLock && kind === 'mutex') this.inherit(o)
  }

  /** Hand the object to waiter w (it was given, put or unlocked to). */
  private unblock(w: number, api: number, releaseUs: number) {
    const t = this.th[w], s = this.obj[t.blockedOn]
    const o = t.blockedOn
    s.waiters.splice(s.waiters.indexOf(w), 1)
    const waited = this.now - t.blockT
    if (t.lockWait) {
      this.emit(laneOfThread(w), t.blockT, this.now, ST_BLOCKED)
      if (waited > s.maxWait) s.maxWait = waited
      if (OBJECTS[o].name.startsWith('bus')) { this.winBusBlocks++; if (waited > this.winMaxBlock) this.winMaxBlock = waited }
    }
    t.ready = true
    t.blockedOn = -1
    t.readyAt = this.now
    t.readyStart = this.now
    t.wake = true
    t.resume = { api, o, since: t.blockT }
    if (!t.lockWait && TRACKED.has(w)) this.startJob(w, releaseUs)
    t.lockWait = false
  }

  /** k_sem_take / k_msgq_get / k_fifo_get / work dequeue without waiting. */
  private takeNow(i: number, o: number): boolean {
    const s = this.obj[o], kind = OBJECTS[o].kind, ctx = laneOfThread(i)
    if (kind === 'sem') {
      if (s.count <= 0) return false
      s.count--
      this.ev(ctx, o, AP.SEM_TAKE, RS.OK, -1, s.count)
    } else if (kind === 'msgq' || kind === 'fifo' || kind === 'work') {
      if (s.depth <= 0) return false
      s.depth--
      this.th[i].item = s.items.shift() ?? 0
      if (kind !== 'work') this.ev(ctx, o, kind === 'msgq' ? AP.MSGQ_GET : AP.FIFO_GET, RS.OK, -1, s.depth)
    } else return false
    const rel = s.giveT.shift() ?? this.now
    if (TRACKED.has(i)) this.startJob(i, rel)
    return true
  }

  /** k_sem_give from any context; wakes the best waiter or counts up to the limit. */
  private give(o: number) {
    const s = this.obj[o], ctx = this.ctxLane()
    const w = this.bestWaiter(o)
    const relT = this.isrLane >= 0 ? this.isrT0 : this.now
    if (w >= 0) {
      this.ev(ctx, o, AP.SEM_GIVE, RS.WAKES, laneOfThread(w))
      this.unblock(w, AP.SEM_TAKE, relT)
      return true
    }
    if (s.count < Math.max(1, OBJECTS[o].cap)) { s.count++; s.giveT.push(relT) }
    this.ev(ctx, o, AP.SEM_GIVE, RS.OK, -1, s.count)
    return false
  }

  /** k_msgq_put / k_fifo_put / k_work_submit (no wait); returns true if it woke someone. */
  private put(o: number, item: number): boolean {
    const s = this.obj[o], kind = OBJECTS[o].kind, ctx = this.ctxLane()
    const api = kind === 'msgq' ? AP.MSGQ_PUT : kind === 'fifo' ? AP.FIFO_PUT : AP.WORK_SUBMIT
    const relT = this.isrLane >= 0 ? this.isrT0 : this.now
    const w = this.bestWaiter(o)
    if (w >= 0) {
      this.th[w].item = item
      this.ev(ctx, o, api, RS.WAKES, laneOfThread(w), s.depth)
      this.unblock(w, kind === 'msgq' ? AP.MSGQ_GET : kind === 'fifo' ? AP.FIFO_GET : -1, relT)
      if (kind === 'work') this.th[w].resume = null
      return true
    }
    const cap = OBJECTS[o].cap
    if (cap > 0 && s.depth >= cap) {
      s.full++
      this.ev(ctx, o, api, RS.FULL, -1, s.depth)
      return false
    }
    s.depth++
    s.items.push(item)
    s.giveT.push(relT)
    if (s.depth > s.peak) s.peak = s.depth
    if (s.depth > s.winPeak) s.winPeak = s.depth
    this.ev(ctx, o, api, RS.OK, -1, s.depth)
    return false
  }

  /** Drain a queue without waiting (ctrl_loop reads every queued sample, keeps the newest). */
  private drain(i: number, o: number) {
    const s = this.obj[o]
    let got = 0
    while (s.depth > 0) {
      s.depth--
      const v = s.items.shift()
      s.giveT.shift()
      if (v !== undefined) this.lastMeas = v
      got++
    }
    this.ev(laneOfThread(i), o, AP.MSGQ_GET, RS.OK, -1, 0, got)
  }

  private lockNow(i: number, o: number): boolean {
    const s = this.obj[o], ctx = laneOfThread(i)
    if (OBJECTS[o].kind === 'mutex') {
      if (s.owner >= 0 && s.owner !== i) return false
      s.owner = i
      s.heldSince = this.now
      this.ev(ctx, o, AP.MTX_LOCK, RS.OK)
      return true
    }
    if (s.count <= 0) return false
    s.count--
    s.owner = i
    s.heldSince = this.now
    this.ev(ctx, o, AP.SEM_TAKE, RS.OK, -1, s.count)
    return true
  }

  /** Release a lock; returns true if a waiter became ready. */
  private unlock(i: number, o: number): boolean {
    const s = this.obj[o], ctx = laneOfThread(i), mutex = OBJECTS[o].kind === 'mutex'
    const held = this.now - s.heldSince
    if (held > s.maxHold) s.maxHold = held
    s.owner = -1
    const t = this.th[i]
    if (mutex && t.prio !== THREADS[i].prio) {
      t.prio = THREADS[i].prio
      this.ev(ctx, o, AP.RESTORE, RS.OK, -1, t.prio)
    }
    const w = this.bestWaiter(o)
    if (w >= 0) {
      s.owner = w
      s.heldSince = this.now
      this.ev(ctx, o, mutex ? AP.MTX_UNLOCK : AP.SEM_GIVE, RS.WAKES, laneOfThread(w))
      this.unblock(w, mutex ? AP.MTX_LOCK : AP.SEM_TAKE, this.now)
      if (mutex) this.inherit(o)
      return true
    }
    if (!mutex) s.count = 1
    this.ev(ctx, o, mutex ? AP.MTX_UNLOCK : AP.SEM_GIVE, RS.OK, -1, mutex ? 0 : s.count)
    return false
  }

  /** Priority inheritance: the owner runs at the best waiter's priority (kernel/mutex.c adjust_owner_prio). */
  private inherit(o: number) {
    const s = this.obj[o]
    if (s.owner < 0) return
    const w = this.bestWaiter(o)
    if (w < 0) return
    const owner = this.th[s.owner]
    if (this.th[w].prio < owner.prio) {
      owner.prio = this.th[w].prio
      this.ev(laneOfThread(s.owner), o, AP.BOOST, RS.OK, laneOfThread(w), owner.prio)
    }
  }

  // ---------------------------------------------------------------- jobs

  private startJob(i: number, releaseUs: number) {
    const prev = this.jobAcc[i]
    if (prev) this.endJob(i)
    this.jobAcc[i] = {
      id: this.jobSeq++, thread: i, release: releaseUs / 1000, start: NaN, end: NaN, resp: 0, lat: 0, exec: 0,
      isr: [0, 0, 0], pre: new Array(THREADS.length).fill(0), lock: -1, holder: -1, holderRan: 0, inv: 0,
      invBy: new Array(THREADS.length).fill(0), miss: false, cause: 'clean', active: true,
    }
    if (this.cur === i) this.jobAcc[i]!.start = this.now / 1000
  }

  /** Attribute dt of CPU time (thread `runner`, or IRQ k when runner < 0) to every pending job. */
  private account(dt: number, runner: number, k: number) {
    if (runner === IDLE) return
    for (const i of TRACKED) {
      const j = this.jobAcc[i]
      if (!j) continue
      if (runner === i) { j.exec += dt; continue }
      if (runner < 0) { j.isr[k] += dt; continue }
      const t = this.th[i]
      if (t.lockWait && t.blockedOn >= 0) {
        const h = this.obj[t.blockedOn].owner
        if (runner === h) j.holderRan += dt
        else if (h >= 0 && THREADS[runner].prio > THREADS[i].prio && THREADS[runner].prio < THREADS[h].prio) { j.inv += dt; j.invBy[runner] += dt }
        else j.pre[runner] += dt
      } else j.pre[runner] += dt
    }
  }

  private endJob(i: number) {
    const j = this.jobAcc[i]
    if (!j) return
    this.jobAcc[i] = null
    const nowMs = this.now / 1000
    j.end = nowMs
    if (!(j.start === j.start)) j.start = nowMs
    j.resp = (j.end - j.release) * 1000
    j.lat = (j.start - j.release) * 1000
    const isr = j.isr[0] + j.isr[1] + j.isr[2]
    const coop = j.pre[SYSWQ]
    const pre = j.pre.reduce((a, b) => a + b, 0) - coop
    const delay = j.resp - j.exec
    if (delay < 40) j.cause = 'clean'
    else {
      const parts: [Cause, number][] = [['isr', isr], ['coop', coop], ['preempt', pre], ['blocked', j.holderRan], ['inversion', j.inv]]
      parts.sort((a, b) => b[1] - a[1])
      j.cause = parts[0][0]
      // Inversion wins whenever it is what pushed the job over its deadline, or a large share of the wait.
      if (j.inv > 0 && (j.resp > CTRL_BUDGET_US && j.resp - j.inv <= CTRL_BUDGET_US || j.inv >= 0.5 * j.holderRan)) j.cause = 'inversion'
    }
    if (j.inv > 0) { this.winInv++; if (j.inv > this.winMaxInv) this.winMaxInv = j.inv }
    if (i === CTRL) {
      this.ctrlResp.push(j.resp)
      this.respHistory.push(j.resp)
      if (this.respHistory.length > 10000) this.respHistory.splice(0, 2000)
      if (j.resp > CTRL_BUDGET_US) {
        j.miss = true
        this.misses++
        this.emitMark(laneOfThread(CTRL), this.now, ST_MISS)
        this.ev(laneOfThread(CTRL), -1, AP.MISS, RS.OK, -1, j.resp, j.id)
        this.logErr++
        this.pendingLogs++
      }
    }
    const { active: _a, ...rec } = j
    this.jobs.push(rec)
    if (this.jobs.length > 40000) this.jobs.splice(0, 8000)
    for (const f of this.jobListeners) f(rec)
  }

  // ---------------------------------------------------------------- thread programs

  /** Next loop iteration of a pend-driven thread (starts with its pend). */
  private gen(i: number): Op[] {
    const r = this.r
    switch (i) {
      case SENSOR:
        return [{ k: 'pend', o: OB.SPI_DONE }, { k: 'fn', f: () => this.sensorBody() }]
      case CTRL:
        return [{ k: 'pend', o: OB.CTRL_TICK }, { k: 'fn', f: () => this.ctrlBody() }]
      case NET:
        return [{ k: 'pend', o: OB.RX_FIFO }, { k: 'fn', f: () => this.netBody() }]
      case SYSWQ:
        return [{ k: 'pend', o: OB.SYSWQ }, { k: 'run', us: -1 }, { k: 'fn', f: () => { this.th[SYSWQ].item = 0 } }]
    }
    return [{ k: 'run', us: uniform(r, 10, 20) }]
  }

  private sensorBody() {
    const r = this.r, t = this.th[SENSOR]
    this.applyStaged(SENSOR)
    const fwd = ++this.sensorSeq % this.pv['sensor.decim'] === 0
    t.prog.push({ k: 'run', us: fwd ? uniform(r, 35, 60) : uniform(r, 9, 14) })
    t.prog.push({ k: 'fn', f: () => { this.plantTo(this.now); this.sensorVal = this.speed + gauss(r) * 2.5 } })
    if (fwd) t.prog.push({ k: 'put', o: OB.SAMPLE_Q })
    t.prog.push({ k: 'done' })
  }

  private ctrlBody() {
    const r = this.r, t = this.th[CTRL]
    this.applyStaged(CTRL)
    const transient = this.now < this.transientUntil
    t.prog.push(
      { k: 'get', o: OB.SAMPLE_Q },
      { k: 'run', us: Math.max(80, (transient ? 205 : 148) + gauss(r) * 12) },
      { k: 'fn', f: () => this.pidUpdate() },
      { k: 'lockbus' },
      { k: 'run', us: uniform(r, 25, 40) },
      { k: 'fn', f: () => this.actuate() },
      { k: 'unlockbus' },
      { k: 'done' },
    )
  }

  private netBody() {
    const r = this.r, t = this.th[NET]
    const bytes = t.item || 256
    t.prog.push({ k: 'fn', f: () => this.netAlloc(bytes) }, { k: 'run', us: Math.max(15, 30 + bytes / 1500 * 16 + gauss(r) * 5) }, { k: 'fn', f: () => this.netRelease(NET) })
  }

  private storageProg(): Op[] {
    return [{
      k: 'fn', f: () => {
        const r = this.r, t = this.th[STORAGE]
        this.applyStaged(STORAGE)
        const chunk = this.pv['storage.chunk']
        t.prog.push({ k: 'fn', f: () => this.storageAlloc() }, { k: 'run', us: uniform(r, 300, 600) })
        for (let n = 0; n < Math.ceil(2048 / chunk); n++) {
          t.prog.push({ k: 'lockbus' }, { k: 'run', us: (60 + chunk * 0.55) * uniform(r, 0.95, 1.1) }, { k: 'unlockbus' }, { k: 'run', us: uniform(r, 40, 90) })
        }
        t.prog.push({ k: 'fn', f: () => this.storageFree() }, { k: 'run', us: uniform(r, 200, 700) })
      },
    }]
  }

  private mainProg(): Op[] {
    const r = this.r
    return [
      { k: 'lock', o: OB.CFG_MTX },
      { k: 'run', us: uniform(r, 100, 200) },
      { k: 'fn', f: () => this.mainHeap() },
      { k: 'unlock', o: OB.CFG_MTX },
    ]
  }

  private zprofProg(heartbeat: boolean): Op[] {
    const r = this.r
    const p: Op[] = [{ k: 'run', us: uniform(r, 3, 6) }, { k: 'fn', f: () => this.pollDownlink() }]
    if (heartbeat) p.push({ k: 'run', us: uniform(r, 150, 230) })
    return p
  }

  // ---------------------------------------------------------------- ISRs

  private irq(k: number) {
    const r = this.r
    // ISR preempts whatever runs; the thread's lane shows a gap for the ISR.
    this.closeRun(this.cur)
    const t0 = this.now
    const dur = k === 0 ? uniform(r, 3, 5) : k === 1 ? uniform(r, 6, 9) : uniform(r, 8, 15)
    this.emit(k, t0, t0 + dur, ST_IRQ0 + k)
    this.irqUs[k] += dur
    this.irqN[k]++
    if (dur > this.irqMax[k]) this.irqMax[k] = dur
    this.now = t0 + dur
    this.isrLane = k
    this.isrT0 = t0
    this.isrEvT = t0 + dur * 0.55
    if (k === 0) this.clockIsr(t0)
    else if (k === 1) {
      // The SPI DMA is paced by the ADC's own clock, 40 ppm off: its phase walks against ctrl_tmr.
      // Jitter is around that clock, not accumulated into it.
      this.spiBase += 500.02
      this.nextIrq[1] = this.spiBase + gauss(r) * 1.5
      this.sensorN++
      this.give(OB.SPI_DONE)
    } else {
      const rate = t0 < this.burstUntil ? 4200 : 350
      this.nextIrq[2] = t0 + expo(r, 1e6 / rate)
      const bytes = r() < 0.6 ? 64 + Math.floor(r() * 200) : 400 + Math.floor(r() * 1100)
      this.rxBytes += bytes
      this.put(OB.RX_FIFO, bytes)
      if (r() < 0.05 * this.logScale()) this.pendingLogs++
      if (r() < 0.002) this.logWrn++
    }
    this.isrLane = -1
    this.account(dur, -1, k)
    this.switchTo(this.pick())
  }

  private clockIsr(t0: number) {
    const r = this.r
    if (t0 >= this.nextTick - 0.5) {
      this.tick++
      this.nextTick += 1000
      const tk = this.tick
      if (tk % 5 === 0) this.wakeProg(ZPROF, this.zprofProg(tk % 100 === 0))
      if (tk % 50 === 0) this.put(OB.SYSWQ, r() < 1 / 120 ? uniform(r, 380, 640) : uniform(r, 40, 90))
      if (tk % 250 === 0) this.wakeProg(STORAGE, this.storageProg())
      if (tk % 1000 === 0) this.wakeProg(MAIN, this.mainProg())
      if (tk % 10 === 0 && this.pendingLogs > 0) {
        this.wakeProg(LOGGING, [{ k: 'run', us: Math.min(600, 25 * this.pendingLogs) }])
        this.pendingLogs = 0
      }
    }
    if (t0 >= this.nextCtrl - 0.5) {
      this.nextCtrl += this.ctrlPeriod
      this.ev(0, OB.CTRL_TMR, AP.EXPIRY, RS.OK, -1, this.ctrlPeriod)
      if (this.jobAcc[CTRL] || this.th[CTRL].blockedOn !== OB.CTRL_TICK) {
        this.overruns++
        this.emitMark(laneOfThread(CTRL), t0, ST_OVERRUN)
      }
      this.give(OB.CTRL_TICK)
    }
    this.nextIrq[0] = Math.min(this.nextTick, this.nextCtrl)
  }

  private logScale() { return [0, 0.3, 0.6, 1, 3][this.pv['log.level']] ?? 1 }

  // ---------------------------------------------------------------- plant and controller

  /** Advance the motor model (current lag then mechanical lag) to tUs with the held output. */
  private plantTo(tUs: number) {
    const K = 25, T1 = 12_000, T2 = 90_000
    let dt = tUs - this.plantT
    while (dt > 0) {
      const h = Math.min(dt, 200)
      this.x1 += (this.uOut - this.x1) * (1 - Math.exp(-h / T1))
      this.speed += (K * this.x1 - this.speed) * (1 - Math.exp(-h / T2))
      dt -= h
    }
    this.plantT = tUs
  }

  private setpoint(tUs: number) {
    const base = Math.floor(tUs / 1_500_000) % 2 === 0 ? 1200 : 1800
    return base
  }

  private pidUpdate() {
    const kp = this.pv['ctrl.kp'], ki = this.pv['ctrl.ki'], kd = this.pv['ctrl.kd']
    const sp = this.setpoint(this.now)
    if (sp !== this.spPrev) {
      this.steps.push({ t: this.now / 1000, from: this.spPrev, to: sp })
      if (this.steps.length > 60) this.steps.shift()
      this.spPrev = sp
    }
    const dt = Math.max(1e-4, (this.now - this.lastCtrlT) / 1e6)
    this.lastCtrlT = this.now
    const e = sp - this.lastMeas
    this.integ += e * dt
    const d = (e - this.ePrev) / dt
    this.ePrev = e
    let u = kp * e + ki * this.integ + kd * d
    if (u > 100) { u = 100; this.integ -= e * dt } else if (u < 0) { u = 0; this.integ -= e * dt }
    this.uNext = u
  }

  /** The DAC write lands: the plant sees the new output from here on. */
  private actuate() {
    this.plantTo(this.now)
    this.uOut = this.uNext
    const sp = this.setpoint(this.now)
    this.watch.push(this.now / 1000, sp, this.lastMeas, this.speed, this.uOut, sp - this.lastMeas, this.integ)
  }

  // ---------------------------------------------------------------- heap traffic

  private heapEv(ctx: number, api: number, res: number, bytes: number, s: number) {
    this.ev(ctx, OB.HEAP, api, res, -1, bytes, s * 8)
  }
  private alloc(owner: number, bytes: number) {
    const s = this.heap.alloc(bytes, owner, this.now / 1000)
    this.heapEv(laneOfThread(owner), AP.MALLOC, s < 0 ? RS.FAILED : RS.OK, bytes, Math.max(0, s))
    return s
  }
  private release(owner: number, s: number) {
    const b = this.heap.block(s)
    if (!b) return
    this.heap.release(s)
    this.heapEv(laneOfThread(owner), AP.FREE, RS.OK, b.bytes, s)
  }

  /** Driver contexts and the config snapshots leaked before the page opened, scattered by temporaries. */
  private bootHeap() {
    const r = this.r, t = this.now / 1000
    for (const b of [384, 512, 96, 256, 1024, 128, 448, 160, 640, 96, 320, 200]) this.heap.alloc(b, MAIN, t - 11_520_000)
    const temps: number[] = []
    for (let k = 0; k < 26; k++) {
      temps.push(this.heap.alloc(64 + Math.floor(r() * 240), NET, t - 300_000))
      this.heap.alloc(56 + Math.floor(r() * 32), MAIN, t - 240_000 + k * 6000)
    }
    for (const s of temps) if (s >= 0) this.heap.release(s)
  }

  private netAlloc(bytes: number) {
    const r = this.r
    const s = this.alloc(NET, bytes)
    if (s < 0) return
    // Most buffers die in this job; a few wait for reassembly or for the application.
    const p = r()
    const long = bytes < 300 && p >= 0.9995
    const until = p < 0.97 ? 0 : long ? this.now + uniform(r, 1_000_000, 4_000_000) : this.now + uniform(r, 5_000, 40_000)
    this.netHeld.push({ s, until, long })
  }
  /** Free expired packet buffers: net_rx frees its own, the application (main) the long-lived ones. */
  private netRelease(by: number) {
    const keep: typeof this.netHeld = []
    for (const h of this.netHeld) {
      if (h.until <= this.now && h.long === (by === MAIN)) this.release(by, h.s)
      else keep.push(h)
    }
    this.netHeld = keep
  }
  private storageAlloc() { this.storageBuf = this.alloc(STORAGE, 1024) }
  private storageFree() { if (this.storageBuf >= 0) this.release(STORAGE, this.storageBuf); this.storageBuf = -1 }
  private leakN = 0
  private mainHeap() {
    // Config snapshot: one in ten is never freed (the leak the insights flag, about 8 B/s).
    const s = this.alloc(MAIN, 72)
    if (s >= 0 && ++this.leakN % 10 !== 0) this.release(MAIN, s)
    this.netRelease(MAIN)
  }

  // ---------------------------------------------------------------- parameter path

  /** Host side: queue a parameter write on the RTT down channel. */
  setParam(id: string, value: number): ParamReq {
    const q: ParamReq = {
      seq: ++this.reqSeq, id, from: this.pv[id] ?? NaN, to: value, tSent: this.now / 1000,
      tStaged: NaN, tApplied: NaN, tAck: NaN, state: 'sent', reason: '',
    }
    this.downlink.push({ q, arrive: this.now + uniform(this.r, 250, 700) })
    this.audit.push(q)
    if (this.audit.length > 500) this.audit.shift()
    this.notifyParam(q)
    return q
  }
  private notifyParam(q: ParamReq) { for (const f of this.paramListeners) f(q) }

  /** zprof thread: validate and stage commands that reached the down buffer. */
  private pollDownlink() {
    const ctx = laneOfThread(ZPROF)
    while (this.downlink.length && this.downlink[0].arrive <= this.now) {
      const { q } = this.downlink.shift()!
      const k = PARAMS.findIndex((p) => p.id === q.id)
      const d = PARAMS[k]
      const ok = d && q.to >= d.min && q.to <= d.max && (d.kind === 'f32' || Number.isInteger(q.to))
      if (!ok) {
        q.state = 'rejected'
        q.reason = d ? `outside ${d.min}..${d.max}` : 'unknown id'
        q.tAck = (this.now + uniform(this.r, 250, 700)) / 1000
        this.ev(ctx, -1, AP.PARAM, RS.REJECTED, -1, q.to, k)
        this.notifyParam(q)
        continue
      }
      q.state = 'staged'
      q.tStaged = this.now / 1000
      this.ev(ctx, -1, AP.PARAM, RS.STAGED, laneOfThread(d.owner), q.to, k)
      if (d.owner === ZPROF) this.applyParam(q)
      else this.staged.set(d.id, q)
      this.notifyParam(q)
    }
  }

  private busIdle() {
    const a = this.obj[OB.BUS_LOCK], b = this.obj[OB.BUS_MTX]
    return a.owner < 0 && b.owner < 0 && !a.waiters.length && !b.waiters.length
  }

  /** Owner thread at its safe point: apply what is staged for it. */
  private applyStaged(owner: number) {
    for (const [id, q] of this.staged) {
      const d = PARAMS.find((p) => p.id === id)!
      if (d.owner !== owner) continue
      if (id === 'storage.bus_mutex' && !this.busIdle()) continue
      this.staged.delete(id)
      this.applyParam(q)
    }
  }

  private applyParam(q: ParamReq) {
    const k = PARAMS.findIndex((p) => p.id === q.id)
    const d = PARAMS[k]
    q.from = this.pv[q.id]
    this.pv[q.id] = q.to
    q.state = 'applied'
    q.tApplied = this.now / 1000
    q.tAck = (this.now + uniform(this.r, 250, 700)) / 1000
    if (q.id === 'ctrl.period_us') this.ctrlPeriod = q.to
    this.ev(laneOfThread(d.owner), -1, AP.PARAM, RS.APPLIED, -1, q.to, k)
    this.notifyParam(q)
  }

  // ---------------------------------------------------------------- time

  /** Advance target time to `tEndUs`. */
  advance(tEndUs: number) {
    const r = this.r
    while (this.now < tEndUs) {
      if (this.now >= this.nextBurst) {
        this.burstUntil = this.now + 700_000
        this.nextBurst = this.now + uniform(r, 6e6, 10e6)
      }
      if (this.now >= this.nextTransient) {
        this.transientUntil = this.now + 300_000
        this.nextTransient = this.now + uniform(r, 4e6, 7e6)
      }
      const k = this.nextIrq[0] <= this.nextIrq[1] ? (this.nextIrq[0] <= this.nextIrq[2] ? 0 : 2) : this.nextIrq[1] <= this.nextIrq[2] ? 1 : 2
      const tIrq = this.nextIrq[k]
      const c = this.cur
      const tDone = c === IDLE ? Infinity : this.now + this.th[c].work
      const tNext = Math.max(this.now, Math.min(tIrq, tDone, this.nextHb, tEndUs))
      const dt = tNext - this.now
      if (c !== IDLE) this.th[c].work -= dt
      if (dt > 0) this.account(dt, c, -1)
      this.now = tNext
      // An ISR can carry time past the heartbeat or the next IRQ: those fire late, never get skipped.
      if (tNext >= this.nextHb) this.heartbeat()
      else if (tNext === tDone && tDone <= tIrq) this.opDone(c)
      else if (tNext >= tIrq) this.irq(k)
    }
  }

  private opDone(c: number) {
    this.th[c].work = 0
    this.exec(c)
    this.switchTo(this.pick())
  }

  private heartbeat() {
    const r = this.r
    // Close running intervals at the sample point so window sums are exact, then resume.
    const c = this.cur
    this.closeRun(c)
    this.th[c].runStart = this.now
    const win = this.now - this.lastHb
    this.lastHb = this.now
    this.nextHb += 100_000
    this.plantTo(this.now)
    const isrUs = this.irqUs.reduce((a, b) => a + b, 0)
    const busy = THREADS.reduce((a, _, i) => a + (i === IDLE ? 0 : this.th[i].runUs), 0) + isrUs
    const fifo = this.obj[OB.RX_FIFO], sq = this.obj[OB.SAMPLE_Q]
    const pk = fifo.winPeak
    this.qPeak = Math.max(this.qPeak, pk)
    this.sqPeak = Math.max(this.sqPeak, sq.winPeak)
    const slabUsed = Math.min(48, 4 + fifo.depth + this.netHeld.length + Math.floor(r() * 2))
    this.slabMax = Math.max(this.slabMax, slabUsed)
    const logUsed = Math.min(4096, 300 + this.pendingLogs * 96 + Math.floor(r() * 120))
    this.logPeak = Math.max(this.logPeak, logUsed)
    const evN = this.events.total - this.lastEvTotal
    this.lastEvTotal = this.events.total
    const linkB = this.switches * SWITCH_BYTES + this.irqN.reduce((a, b) => a + b, 0) * ISR_BYTES + evN * EVENT_BYTES + HEARTBEAT_BYTES
    const linkBps = (linkB * 1e6) / win
    const rttUsed = Math.min(16384, linkB * 0.04 + r() * 400)
    this.rttPeak = Math.max(this.rttPeak, rttUsed)
    const frames = Math.ceil(linkB / 240)
    this.framesTotal += frames
    if (linkBps > LINK_BUDGET_BPS * 0.6 && r() < 0.3) this.framesLost += 1
    const threads: ThreadSample[] = THREADS.map((d, i) => {
      const t = this.th[i]
      const lat = t.wakeLat.sort((a, b) => a - b)
      const used = i === NET ? d.base + Math.min(520, pk * 14) : d.base + Math.floor(gauss(r) * 6)
      t.hwm = Math.max(t.hwm, used)
      const s: ThreadSample = {
        name: d.name,
        prio: t.prio,
        state: i === c ? 'running' : t.ready ? 'ready' : t.lockWait ? 'blocked' : i === STORAGE && r() < 0.3 ? 'suspended' : 'pending',
        cpuPct: (t.runUs / win) * 100,
        runPeakUs: t.segPeak,
        runAvgUs: t.segN ? t.segSum / t.segN : 0,
        switchesPerS: (t.sw * 1e6) / win,
        wakeP99Us: lat.length ? quantile(lat, 0.99) : 0,
        stackSize: d.stack,
        stackUsed: used,
        stackHwm: t.hwm,
      }
      t.runUs = 0; t.sw = 0; t.segPeak = 0; t.segSum = 0; t.segN = 0; t.wakeLat = []
      return s
    })
    const resp = this.ctrlResp.sort((a, b) => a - b)
    const hp = this.heap
    const hb: Heartbeat = {
      t: this.now / 1000,
      seq: this.seq++,
      cpuPct: (busy / win) * 100,
      isrPct: (isrUs / win) * 100,
      threads,
      irqs: IRQS.map((name, k) => ({ name, perS: (this.irqN[k] * 1e6) / win, pct: (this.irqUs[k] / win) * 100, maxUs: this.irqMax[k] })),
      ctxPerS: (this.switches * 1e6) / win,
      irqPerS: (this.irqN.reduce((a, b) => a + b, 0) * 1e6) / win,
      heap: { size: hp.bytes, alloc: hp.used, maxAlloc: hp.peak, largestFree: hp.largestFree, frag: hp.fragmentation, failures: hp.failures, byOwner: hp.liveByOwner(THREADS.length) },
      slab: { blocks: 48, used: slabUsed, maxUsed: this.slabMax },
      msgq: { max: OBJECTS[OB.RX_FIFO].cap, used: fifo.depth, peak: this.qPeak },
      sampleQ: { max: OBJECTS[OB.SAMPLE_Q].cap, used: sq.depth, peak: this.sqPeak, full: sq.full },
      logBuf: { size: 4096, used: logUsed, peak: this.logPeak },
      rttUp: { size: 16384, used: rttUsed, peak: this.rttPeak },
      ctrl: { p50: quantile(resp, 0.5), p99: quantile(resp, 0.99), max: resp[resp.length - 1] ?? 0, misses: this.misses, overruns: this.overruns },
      bus: { kind: this.busIsMutex ? 'k_mutex' : 'k_sem', blocks: this.winBusBlocks, inversions: this.winInv, maxBlockUs: this.winMaxBlock, maxInvUs: this.winMaxInv },
      plant: { sp: this.setpoint(this.now), pv: this.speed, u: this.uOut },
      linkBps,
      framesLost: this.framesLost,
      framesTotal: this.framesTotal,
      selfPct: threads[ZPROF].cpuPct,
      rxBytesPerS: (this.rxBytes * 1e6) / win,
      sensorSps: (this.sensorN * 1e6) / win,
      logErrPerS: (this.logErr * 1e6) / win,
      logWrnPerS: (this.logWrn * 1e6) / win,
      eventsPerS: (evN * 1e6) / win,
      uptimeMs: this.now / 1000,
      bootCount: 37,
    }
    this.irqUs = [0, 0, 0]; this.irqN = [0, 0, 0]; this.irqMax = [0, 0, 0]
    this.switches = 0; this.rxBytes = 0; this.sensorN = 0; this.logErr = 0; this.logWrn = 0; this.ctrlResp = []
    this.winBusBlocks = 0; this.winInv = 0; this.winMaxBlock = 0; this.winMaxInv = 0
    for (const o of this.obj) { o.winPeak = o.depth; o.winOps = 0; o.winBlocks = 0 }
    this.heartbeats.push(hb)
    if (this.heartbeats.length > 900) this.heartbeats.splice(0, 300)
    for (const f of this.hbListeners) f(hb)
  }
}

/** One simulator for the page; it keeps running while views are swapped. */
let sim: TargetSim | null = null
let raf = 0
export function targetSim(): TargetSim {
  if (!sim) {
    sim = new TargetSim()
    const s = sim
    // Pre-roll 30 s so every panel has history on first paint.
    s.advance(s.now + 30_000_000)
    let last = performance.now()
    const loop = () => {
      const t = performance.now()
      // Cap catch-up after a hidden tab so we never simulate minutes in one frame.
      const dt = Math.min(100, t - last)
      last = t
      s.advance(s.now + dt * 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  }
  return sim
}
export function stopTargetSim() { cancelAnimationFrame(raf); sim = null }
