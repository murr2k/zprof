# SPDX-License-Identifier: Apache-2.0
"""What a decoded zprof stream says: per-thread CPU, interrupts, idle, wake
latency, drops, and two self-checks.

- Per-thread CPU from the trace is compared with the kernel's own execution
  cycles (THREAD_STATS records, once a second) over the same window. Both
  count a thread from its switch-in to its switch-out, interrupts included
  (Zephyr charges ISR time to the interrupted thread), so they must agree.
- The timestamp clock against the kernel's 64-bit cycle count, from the SYNC
  records: a ratio below 1 means the timestamp stops in sleep (WFI).
"""
from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import proto as P
from .elf import Elf
from .stream import EV_SESSION, SESSION_KINDS, Decoder, Hello

EXC_NAMES = {2: "NMI", 3: "HardFault", 4: "MemManage", 5: "BusFault", 6: "UsageFault",
             7: "SecureFault", 11: "SVCall", 12: "DebugMonitor", 14: "PendSV", 15: "SysTick"}


def irq_names_from_header(path: str | Path) -> dict[int, str]:
    """IRQ number -> name from a CMSIS device header (`Name_IRQn = N,`)."""
    out = {}
    for m in re.finditer(r"^\s*(\w+)_IRQn\s*=\s*(-?\d+)\s*,", Path(path).read_text(errors="replace"), re.M):
        n = int(m.group(2))
        if n >= 0:
            out[n] = m.group(1)
    return out


@dataclass
class ThreadUse:
    ptr: int
    intervals: list[tuple[int, int]] = field(default_factory=list)  # (t0, t1) on the CPU, when kept
    run: int = 0               # time on the CPU (interrupts included), always counted
    isr_in: int = 0            # interrupt time while this thread was the running one
    switches_in: int = 0
    wake_lat: list[int] = field(default_factory=list)


CLASS_NAMES = {P.EV_SEM: "k_sem", P.EV_MUTEX: "k_mutex", P.EV_MSGQ: "k_msgq", P.EV_QUEUE: "k_queue",
               P.EV_SLEEP: "sleep", P.EV_POLL: "k_poll", P.EV_TIMER: "k_timer", P.EV_WORK: "k_work"}
CALL_NAMES = {
    P.EV_SEM: {P.CALL_GIVE: "give", P.CALL_TAKE: "take", P.CALL_RESET: "reset"},
    P.EV_MUTEX: {P.CALL_LOCK: "lock", P.CALL_UNLOCK: "unlock"},
    P.EV_MSGQ: {P.CALL_PUT: "put", P.CALL_GET: "get", P.CALL_PUT_FRONT: "put_front", P.CALL_PURGE: "purge"},
    P.EV_QUEUE: {P.CALL_PUT: "put", P.CALL_GET: "get"},
    P.EV_SLEEP: {P.CALL_SLEEP: "sleep", P.CALL_MSLEEP: "msleep", P.CALL_USLEEP: "usleep"},
    P.EV_POLL: {P.CALL_POLL: "poll"},
    P.EV_TIMER: {P.CALL_EXPIRY: "expiry"},
    P.EV_WORK: {P.CALL_SUBMIT: "submit", P.CALL_SCHEDULE: "schedule", P.CALL_RESCHEDULE: "reschedule",
                P.CALL_CANCEL: "cancel"},
}
ISR_CTX = -1  # the context of an object call made from an interrupt
# Calls the target records with no ENTER (one EXIT record unless they block: BLOCK then
# EXIT), and calls recorded at their EXIT only; counted at the EXIT. Call numbers are
# per class: always test them with the class.
MAY_BLOCK = {(P.EV_SEM, P.CALL_TAKE), (P.EV_MUTEX, P.CALL_LOCK), (P.EV_MSGQ, P.CALL_PUT),
             (P.EV_MSGQ, P.CALL_PUT_FRONT), (P.EV_MSGQ, P.CALL_GET), (P.EV_QUEUE, P.CALL_GET)}
EXIT_ONLY = {(P.EV_SEM, P.CALL_GIVE), (P.EV_MUTEX, P.CALL_UNLOCK)}
# SWITCH_OUT states in which the thread stopped being ready (not preempted)
BLOCKING = P.THS_PENDING | P.THS_SLEEPING | P.THS_SUSPENDED


@dataclass
class ObjUse:
    """One kernel object (or a thread's sleeps, keyed by the thread)."""
    cls: int
    obj: int
    calls: Counter = field(default_factory=Counter)   # call -> count
    blocks: int = 0
    waits: list[int] = field(default_factory=list)   # time blocked, per wait that blocked
    without: int = 0                                 # calls that returned without the object: a
                                                     # timeout, -EBUSY, an empty poll, a NULL get
    durations: list[int] = field(default_factory=list)  # timer expiry functions: their run time
    handler: int = 0                                 # work items: the handler
    last: int | None = None                          # the last count / fill / owner reported


@dataclass
class IrqUse:
    count: int = 0
    total: int = 0             # inclusive of nested interrupts
    worst: int = 0
    win_worst: int = 0         # worst since the live loop last reset it


class Tracker:
    """The scheduler's story one record at a time: who ran when, interrupts,
    wakeups, idle, drops. Batch analysis and the live bridge share it.

    `keep` stores every interval (batch); live use leaves it off, takes the
    intervals from the callbacks and reads the running totals.
    """

    def __init__(self, hello: Hello, keep: bool = True, on_run=None, on_isr=None, on_ready=None, on_wait=None,
                 on_block=None):
        self.hello = hello
        self.keep = keep
        self.on_run, self.on_isr, self.on_ready = on_run, on_isr, on_ready
        self.on_wait = on_wait  # (thread, (class, object), blocked from, until, holder or 0)
        # (thread, switched out at, made ready at, thread state, wait queue or 0): from the
        # scheduler's own records, so it needs no kernel-object class
        self.on_block = on_block
        self.mutexes: set[int] = set()  # k_mutex addresses seen (its wait queue is at offset 0)
        self._blocked: dict[int, tuple[int, int, int]] = {}  # thread -> (t, state, wait queue)
        self.objects: dict[tuple[int, int], ObjUse] = {}
        self._open: dict[int, list] = {}  # context -> [class, call, object, t_enter, t_block, holder]
        self.threads: dict[int, ThreadUse] = {}
        self.irqs: dict[int, IrqUse] = defaultdict(IrqUse)
        self.syncs: list[tuple[int, int]] = []   # (t, kernel cycles)
        self.stats: list[tuple[int, dict[int, int]]] = []  # (t, thread -> execution cycles)
        self.dropped = 0
        self.wfi = 0                              # time between IDLE and IDLE_EXIT
        self.isr_spans: list[tuple[int, int, int, int]] = []  # (irq, t0, t1, nesting depth), when kept
        self.wakes: list[tuple[int, int, int]] = []           # (thread, ready at, switched in at), when kept
        self.drops: list[tuple[int, int]] = []                # (t, records dropped)
        self.records = 0
        self.t0: int | None = None
        self.t1 = 0
        self.cur: int | None = hello.sender or None   # the sender runs when the session starts
        self._run_from: int | None = None
        self._stack: list[tuple[int, int]] = []
        self._ready_at: dict[int, int] = {}
        self._idle_at: int | None = None
        self._batch: dict[int, int] | None = None
        self._batch_t = 0
        self._last_stats = 0
        self._gap = (hello.ts_hz or 1) // 20  # 50 ms between batches of THREAD_STATS

    def use(self, ptr: int) -> ThreadUse:
        u = self.threads.get(ptr)
        if u is None:
            u = self.threads[ptr] = ThreadUse(ptr)
        return u

    def _ran(self, th: int, a: int, b: int) -> None:
        u = self.use(th)
        u.run += b - a
        if self.keep:
            u.intervals.append((a, b))
        if self.on_run:
            self.on_run(th, a, b)

    def feed(self, recs) -> None:
        for r in recs:
            rid, t = r.id, r.t
            if self.t0 is None:
                self.t0 = t
                self._run_from = t
            self.t1 = t
            if rid == EV_SESSION:
                # a new session (a reconnect): nothing in flight spans the gap; the sender runs
                self.cur, self._run_from = self.hello.sender or None, t
                self._stack.clear()
                self._ready_at.clear()
                self._blocked.clear()
                self._idle_at = None
                self._open.clear()
                continue
            self.records += 1
            if P.OBJ_FIRST <= rid <= P.OBJ_LAST:
                self._object(r, t)
                continue
            if rid == P.EV_SWITCH_IN:
                th = r.w[0]
                self.cur, self._run_from = th, t
                u = self.use(th)
                u.switches_in += 1
                tr = self._ready_at.pop(th, None)
                if tr is not None:
                    u.wake_lat.append(t - tr)
                    if self.keep:
                        self.wakes.append((th, tr, t))
                    if self.on_ready:
                        self.on_ready(th, tr, t)
            elif rid == P.EV_SWITCH_OUT:
                th = r.w[0]
                if self.cur == th and self._run_from is not None:
                    self._ran(th, self._run_from, t)
                self.cur = None
                st = r.arg
                if st & BLOCKING and not st & P.THS_QUEUED:
                    self._blocked[th] = (t, st, r.w[1] if len(r.w) > 1 else 0)
            elif rid == P.EV_ISR_ENTER:
                self._stack.append((r.arg, t))
            elif rid == P.EV_ISR_EXIT:
                if self._stack:
                    irq, te = self._stack.pop()
                    dt = t - te
                    if self.keep:
                        self.isr_spans.append((irq, te, t, len(self._stack)))
                    if self.on_isr:
                        self.on_isr(irq, te, t, len(self._stack))
                    iu = self.irqs[irq]
                    iu.count += 1
                    iu.total += dt
                    iu.worst = max(iu.worst, dt)
                    iu.win_worst = max(iu.win_worst, dt)
                    if not self._stack and self.cur is not None:
                        self.use(self.cur).isr_in += dt
            elif rid == P.EV_READY:
                self._ready_at.setdefault(r.w[0], t)
                b = self._blocked.pop(r.w[0], None)
                if b is not None and self.on_block:
                    self.on_block(r.w[0], b[0], t, b[1], b[2])
            elif rid == P.EV_IDLE:
                self._idle_at = t
            elif rid == P.EV_IDLE_EXIT:
                if self._idle_at is not None:
                    self.wfi += t - self._idle_at
                    self._idle_at = None
            elif rid == P.EV_SYNC:
                self.syncs.append((t, r.w[0] | (r.w[1] << 32)))
            elif rid == P.EV_OVERFLOW:
                self.dropped += r.w[0]
                self.drops.append((t, r.w[0]))
                self._blocked.clear()  # the wakeups may be among what was lost
            elif rid == P.EV_THREAD_STATS:
                # one batch per second, read thread by thread (an interrupt may land between)
                if self._batch is not None and t - self._last_stats > self._gap:
                    self.stats.append((self._batch_t, self._batch))
                    self._batch = None
                if self._batch is None:
                    self._batch, self._batch_t = {}, t
                self._batch[r.w[0]] = r.w[1] | (r.w[2] << 32)
                self._last_stats = t

    def _object(self, r, t: int) -> None:
        cls, call, phase = r.id, r.arg >> 4, r.arg & 0xF
        obj = r.w[0] if r.w else 0
        val = r.w[1] if len(r.w) > 1 else 0
        if cls == P.EV_MUTEX:
            self.mutexes.add(obj)
        ctx = ISR_CTX if self._stack else (self.cur if self.cur is not None else 0)
        # a thread's sleeps are its own "object"
        key = (cls, ctx if cls == P.EV_SLEEP else obj)
        u = self.objects.get(key)
        if u is None:
            u = self.objects[key] = ObjUse(cls, key[1])
        cc = (cls, call)
        if phase == P.PH_ENTER:
            if cc in MAY_BLOCK:      # an older recording's ENTER: the EXIT counts the call
                return
            u.calls[call] += 1
            if cls == P.EV_WORK and val:
                u.handler = val
            if cc in ((P.EV_SEM, P.CALL_RESET), (P.EV_MSGQ, P.CALL_PURGE)):
                u.last = val
            self._open[ctx] = [cls, call, obj, t, None, 0]
        elif phase == P.PH_BLOCK:
            # the wait starts; the value: a mutex's owner, else the timeout
            u.blocks += 1
            self._open[ctx] = [cls, call, obj, t, t, val if cls == P.EV_MUTEX else 0]
        elif phase == P.PH_EXIT:
            if cc in EXIT_ONLY:
                u.calls[call] += 1
                if cls == P.EV_SEM:
                    u.last = val     # the count after the give
                return
            if cc in MAY_BLOCK:
                u.calls[call] += 1
            o = self._open.pop(ctx, None)
            ret = val - (1 << 32) if val & 0x80000000 else val
            if cls in (P.EV_SEM, P.EV_MUTEX, P.EV_MSGQ, P.EV_POLL) and ret < 0:
                u.without += 1                           # a timeout (-EAGAIN), a refusal (-EBUSY, -ENOMSG)
            elif cls == P.EV_QUEUE and call == P.CALL_GET and val == 0:
                u.without += 1                           # k_queue_get returned NULL (timed out)
            # a sleep's return is the time left when it was woken early, not an error
            if o and o[0] == cls and o[2] == obj:
                if cls == P.EV_TIMER:
                    u.durations.append(t - o[3])
                elif o[4] is not None:
                    u.waits.append(t - o[4])
                    if self.on_wait and ctx not in (ISR_CTX, 0):
                        self.on_wait(ctx, key, o[4], t, o[5])

    def finish(self) -> None:
        """End of a recording: close the open batch and the running thread's interval."""
        if self._batch is not None:
            self.stats.append((self._batch_t, self._batch))
            self._batch = None
        if self.cur is not None and self._run_from is not None:
            self._ran(self.cur, self._run_from, self.t1)
            self._run_from = None


@dataclass
class Analysis:
    d: Decoder
    elf: Elf | None = None
    irq_names: dict[int, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # The target's clock starts again at a reboot: one timeline is one boot, the last.
        recs = self.d.records
        reboot = SESSION_KINDS.index("reboot")
        last = max((i for i, r in enumerate(recs) if r.id == EV_SESSION and r.arg == reboot), default=0)
        self.boot_from = last
        tr = Tracker(self.d.hello)
        tr.feed(recs[last:] if last else recs)
        tr.finish()
        self.tracker = tr
        self.threads = tr.threads
        self.irqs = tr.irqs
        self.syncs = tr.syncs
        self.stats = tr.stats
        self.dropped = tr.dropped
        self.wfi = tr.wfi
        self.isr_spans = tr.isr_spans
        self.wakes = tr.wakes
        self.drops = tr.drops
        self.objects = tr.objects
        self.t0 = tr.t0 or 0
        self.t1 = tr.t1

    # ------------------------------------------------------------ names
    def thread_name(self, ptr: int) -> str:
        t = self.d.threads.get(ptr)
        if t and t.name:
            return t.name
        if self.elf:
            n = self.elf.name(ptr, exact_only=True)
            if n:
                return n
            if t and t.entry:
                e = self.elf.name(t.entry)
                if e:
                    return f"<{e}>"
        return f"{ptr:#010x}"

    def obj_name(self, key: tuple[int, int], u: ObjUse | None = None) -> str:
        """A kernel object by its symbol in the ELF (`symbol` or `symbol+0xoff` for one
        embedded in a struct), a work item by its handler, a thread's sleeps by the thread."""
        cls, obj = key
        if cls == P.EV_SLEEP:
            return "ISR" if obj == ISR_CTX else self.thread_name(obj)
        if cls == P.EV_WORK and u and u.handler and self.elf:
            h = self.elf.name(u.handler)
            if h:
                return h
        if self.elf and obj:
            n = self.elf.name(obj)
            if n:
                return n
        return f"{obj:#010x}"

    def irq_name(self, irq: int) -> str:
        if irq & P.ISR_EXC:
            return EXC_NAMES.get(irq & 0xFF, f"exception {irq & 0xFF}")
        chip = self.irq_names.get(irq)
        i = self.d.irqs.get(irq)
        sym = None
        if i and self.elf:
            sym = self.elf.name(i.handler)
            a = self.elf.name(i.arg, exact_only=True) if (sym and i.arg) else None
            if a:
                sym = f"{sym}({a})"
        if sym and chip:
            return f"{sym} ({chip})"
        return sym or chip or f"IRQ {irq}"

    # ------------------------------------------------------------ numbers
    def seconds(self, ticks: int) -> float:
        return ticks / (self.d.hello.ts_hz or 1)

    @staticmethod
    def clipped(intervals: list[tuple[int, int]], a: int, b: int) -> int:
        return sum(max(0, min(t1, b) - max(t0, a)) for t0, t1 in intervals)

    def ts_ratio(self) -> list[float]:
        """Timestamp ticks per kernel cycle (scaled to the same Hz) between SYNCs."""
        h = self.d.hello
        out = []
        for (ta, ka), (tb, kb) in zip(self.syncs, self.syncs[1:]):
            if kb > ka:
                out.append(((tb - ta) / (h.ts_hz or 1)) / ((kb - ka) / (h.kcyc_hz or 1)))
        return out

    def check_against_kernel(self) -> list[tuple[int, float, float]] | None:
        """(thread, trace %, kernel %) over the window between the first and last THREAD_STATS."""
        if len(self.stats) < 2:
            return None
        (ta, a), (tb, b) = self.stats[0], self.stats[-1]
        span = tb - ta
        kspan = span * (self.d.hello.kcyc_hz or 1) / (self.d.hello.ts_hz or 1)
        out = []
        for ptr in sorted(set(a) & set(b)):
            u = self.threads.get(ptr)
            trace = self.clipped(u.intervals, ta, tb) if u else 0
            out.append((ptr, 100.0 * trace / span, 100.0 * (b[ptr] - a[ptr]) / kspan))
        return out


def short_name(name: str, n: int) -> str:
    """Fit a name in n characters, keeping a `+0xoff` suffix (objects inside one
    big symbol differ only there)."""
    if len(name) <= n:
        return name
    base, plus, off = name.rpartition("+")
    if plus and off.startswith("0x") and len(off) + 2 < n:
        return base[: n - len(off) - 2] + "~+" + off
    return name[: n - 1] + "~"


def pct(x: float) -> str:
    return f"{x:6.2f}"


def report(an: Analysis) -> str:
    d, h = an.d, an.d.hello
    lines = []
    span = an.t1 - an.t0
    secs = an.seconds(span) or 1e-9
    src = {P.TS_SRC_DWT: "DWT cycle counter", P.TS_SRC_KCYCLE: "kernel cycles"}.get(h.ts_source, "?")
    lines.append(f"target   {h.kernel}, timestamps: {src} at {h.ts_hz / 1e6:.1f} MHz, ring {h.ring_bytes // 1024} KB")
    if an.elf:
        why = an.elf.check_build_id(h.build_id)
        lines.append(f"elf      {an.elf.path.name}: " + ("the board's build" if why is None else f"MISMATCH: {why}"))
    lines.append(f"window   {secs:.2f} s, {len(d.records)} records ({len(d.records) / secs:,.0f}/s), "
                 f"{d.bytes_in / secs / 1024:,.0f} KB/s on the wire, dropped {an.dropped}, frame gaps {d.seq_gaps}")
    r = an.ts_ratio()
    if r:
        lines.append(f"clock    timestamp/kernel cycles over {len(r)} SYNC intervals: "
                     f"{min(r):.6f} to {max(r):.6f}" +
                     ("  (the timestamp stops in sleep)" if min(r) < 0.999 else "  (runs through sleep)"))

    lines.append("")
    lines.append(f"{'thread':24s} {'prio':>4s} {'CPU %':>6s} {'net %':>6s} {'in/s':>7s} "
                 f"{'wake us':>8s} {'p99':>7s} {'max':>8s}")
    order = sorted(an.threads.values(), key=lambda u: -sum(b - a for a, b in u.intervals))
    for u in order:
        run = sum(b - a for a, b in u.intervals)
        if run == 0 and u.switches_in == 0:
            continue
        t = d.threads.get(u.ptr)
        lat = [an.seconds(x) * 1e6 for x in u.wake_lat]
        lat_s = (f"{statistics.mean(lat):8.1f} {sorted(lat)[int(0.99 * (len(lat) - 1))]:7.1f} {max(lat):8.1f}"
                 if lat else f"{'':8s} {'':7s} {'':8s}")
        mark = "  (zprof's sender)" if u.ptr == h.sender else ""
        lines.append(f"{an.thread_name(u.ptr)[:24]:24s} {t.prio if t else '':>4} "
                     f"{pct(100 * run / span)} {pct(100 * (run - u.isr_in) / span)} "
                     f"{u.switches_in / secs:7.0f} {lat_s}{mark}")
    lines.append(f"{'(in WFI)':24s} {'':>4s} {pct(100 * an.wfi / span)}")
    sender = an.threads.get(h.sender)
    if sender is not None:
        s_pct = 100 * sum(b - a for a, b in sender.intervals) / span
        hooks_pct = 100 * len(d.records) * h.hook_cost / span if h.hook_cost else 0.0
        lines.append(f"zprof's own cost: sender {s_pct:.2f} % + hooks {hooks_pct:.2f} % "
                     f"({len(d.records) / secs:,.0f} events/s x {an.seconds(h.hook_cost) * 1e9:.0f} ns) "
                     f"= {s_pct + hooks_pct:.2f} % of the CPU (the network stack's share not included)")

    lines.append("")
    lines.append(f"{'interrupt':36s} {'/s':>7s} {'CPU %':>6s} {'mean us':>8s} {'max us':>8s}")
    for irq, iu in sorted(an.irqs.items(), key=lambda kv: -kv[1].total):
        lines.append(f"{an.irq_name(irq)[:36]:36s} {iu.count / secs:7.0f} {pct(100 * iu.total / span)} "
                     f"{an.seconds(iu.total / iu.count) * 1e6:8.2f} {an.seconds(iu.worst) * 1e6:8.2f}")

    if an.objects:
        lines.append("")
        lines.append(f"{'kernel object':32s} {'class':8s} {'calls/s':>8s} {'blocks/s':>8s} "
                     f"{'wait us':>8s} {'max':>9s} {'without':>7s}  calls")
        def weight(kv):
            u = kv[1]
            return (-sum(u.waits) - sum(u.durations), -sum(u.calls.values()))
        for key, u in sorted(an.objects.items(), key=weight)[:25]:
            n = sum(u.calls.values())
            if not n and not u.blocks:
                continue
            spans = u.waits or u.durations
            mean = f"{an.seconds(statistics.mean(spans)) * 1e6:8.1f}" if spans else f"{'':8s}"
            worst = f"{an.seconds(max(spans)) * 1e6:9.1f}" if spans else f"{'':9s}"
            calls = " ".join(f"{CALL_NAMES.get(u.cls, {}).get(c, c)} {k}" for c, k in u.calls.most_common())
            lines.append(f"{short_name(an.obj_name(key, u), 32):32s} {CLASS_NAMES.get(u.cls, '?'):8s} {n / secs:8.0f} "
                         f"{u.blocks / secs:8.1f} {mean} {worst} {u.without:7d}  {calls}")
        lines.append("  (wait: blocked until the call returned; for k_timer, the expiry function's run time;"
                     " without: returned without the object: a timeout, -EBUSY, an empty poll)")

    chk = an.check_against_kernel()
    if chk:
        lines.append("")
        worst = max(abs(a - b) for _, a, b in chk)
        ta, tb = an.stats[0][0], an.stats[-1][0]
        lines.append(f"check    per-thread CPU, trace against the kernel's own counts over "
                     f"{an.seconds(tb - ta):.2f} s: worst difference {worst:.3f} points "
                     + ("(pass, < 0.5)" if worst < 0.5 else "(FAIL, >= 0.5)"))
        for ptr, a, b in sorted(chk, key=lambda x: -abs(x[1] - x[2]))[:5]:
            lines.append(f"         {an.thread_name(ptr)[:24]:24s} trace {pct(a)}  kernel {pct(b)}")
    return "\n".join(lines)
