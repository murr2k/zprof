# SPDX-License-Identifier: Apache-2.0
"""Schedulability from the trace (the model: docs/SCHEDULABILITY.md).

- Jobs per thread: a job starts when the thread is made ready after waiting on
  its release object (the wait queue, or its sleep, it spends the most time
  waiting on), and ends when it blocks there again. Inside a job: execution
  (net of interrupts), self-suspension (waits on anything else), the time it
  was ready while a lower-priority thread ran (blocking), and the response.
- Arrival curves per thread (its releases) and per interrupt (its entries):
  the densest bursts seen, eta(d) = the most events any window of length d held.
- Response-time analysis for fixed priorities with those curves, blocking,
  interrupts above every thread, Zephyr's cooperative threads (not preempted by
  other threads) and self-suspension (jitter J = R - C for a suspending thread
  above). Then how much each thread with a deadline can grow, the factor every
  execution time can scale by, a priority order that meets every deadline
  (Audsley), and recommendations, with limits from the thresholds file.

Measurement-based: execution times are the largest observed, arrivals the
densest observed. The verdict is "schedulable for the load observed".
"""
from __future__ import annotations

import json
import math
import statistics
from bisect import bisect_left, insort
from collections import Counter, deque
from dataclasses import dataclass, field, replace
from pathlib import Path

from . import proto as P
from . import thresholds as TH
from .analyze import BLOCKING
from .stream import EV_SESSION

INF = math.inf
SLEEP_KEY, OTHER_KEY = -1, -2      # a thread's k_sleep, and any other wait without a wait queue


# ---------------------------------------------------------------- arrival curves

class Arrivals:
    """The densest bursts of an event stream: dmin[k-1] is the shortest span that
    held k+1 consecutive events (k = 1..K, while shorter than the horizon). A gap in
    the record (dropped records) cuts the stream: no span bridges it."""
    K = 64

    def __init__(self, horizon: int):
        self.h = horizon
        self.dmin: list[int] = []
        self.recent: list[int] = []
        self.gaps: deque[int] = deque(maxlen=2048)   # recent intervals, for the period
        self.n = 0
        self.first: int | None = None
        self.last: int | None = None

    def add(self, t: int) -> None:
        rec = self.recent
        if rec:
            self.gaps.append(t - rec[-1])
        d, h = self.dmin, self.h
        k = 0
        for prev in reversed(rec):
            k += 1
            span = t - prev
            if span >= h:
                break
            if k > len(d):
                d.append(span)
            elif span < d[k - 1]:
                d[k - 1] = span
        rec.append(t)
        if len(rec) > self.K:
            del rec[0]
        self.n += 1
        if self.first is None:
            self.first = t
        self.last = t

    def cut(self) -> None:
        self.recent = []

    def curve(self, us: float) -> "Curve":
        known = self.h if len(self.dmin) < self.K else self.dmin[-1]
        return Curve([x * us for x in self.dmin], known * us, self.n)

    def period(self) -> tuple[bool, float | None]:
        """(periodic, period ticks): periodic when 80 % of the recent intervals are within
        25 % of their median (release jitter spreads them; events from outside spread them
        far more); else the shortest interval seen."""
        g = list(self.gaps)
        if len(g) < 20:
            return False, (self.dmin[0] if self.dmin else None)
        m = statistics.median(g)
        near = sum(1 for x in g if abs(x - m) <= 0.25 * m)
        if m > 0 and near >= 0.8 * len(g):
            return True, m
        return False, (self.dmin[0] if self.dmin else min(g))


class Curve:
    """An arrival curve for the analysis, in microseconds: eta(d) events at most in
    any half-open window of length d, and dist(q) the least time q+1 events span."""

    def __init__(self, dmin_us: list[float], known_us: float, n: int):
        self.d, self.known, self.n = dmin_us, known_us, n
        self._eta_known = 1 + bisect_left(dmin_us, known_us) if n else 0

    def eta(self, w: float) -> int:
        if w <= 0 or not self.n:
            return 0
        if w <= self.known:
            return 1 + bisect_left(self.d, w)
        # beyond what was measured exactly: windows of `known` side by side (eta is subadditive)
        return math.ceil(w / self.known) * self._eta_known

    def dist(self, q: int) -> float:
        if q <= 0:
            return 0.0
        if q <= len(self.d):
            return self.d[q - 1]
        if self.d and len(self.d) == Arrivals.K:   # superadditive: spans of K back to back
            return (q // len(self.d)) * self.d[-1]
        return self.known                          # every longer span reached the horizon


class Periodic:
    """A strictly periodic arrival with release jitter (a what-if period)."""

    def __init__(self, t: float, j: float = 0.0):
        self.t, self.j = t, j

    def eta(self, w: float) -> int:
        return 0 if w <= 0 else math.ceil((w + self.j) / self.t)

    def dist(self, q: int) -> float:
        return max(0.0, q * self.t - self.j)


class Workload:
    """The most execution a thread did in any window of length g, for g on a grid
    doubling from G0 (measured: what it did, not arrivals times its worst job). Its
    run segments go in as work packed at the end of each segment (never less dense
    than it was); a gap in the record cuts it."""
    LEVELS = 19                           # 5 us .. 1.3 s

    def __init__(self, g0: int):
        self.grid = [g0 << k for k in range(self.LEVELS)]
        self.best = [0] * self.LEVELS
        self.q = [deque() for _ in self.grid]
        self.sum = [0] * self.LEVELS

    def add(self, s: int, e: int) -> None:
        w = e - s
        if w <= 0:
            return
        for k, g in enumerate(self.grid):
            dq = self.q[k]
            dq.append((s, e))
            tot = self.sum[k] + w
            lo = e - g
            while dq[0][1] <= lo:
                a, b = dq.popleft()
                tot -= b - a
            self.sum[k] = tot
            a0 = dq[0][0]
            v = tot - (lo - a0 if a0 < lo else 0)    # the leftmost segment may stick out of the window
            if v > self.best[k]:
                self.best[k] = v

    def cut(self) -> None:
        for dq in self.q:
            dq.clear()
        self.sum = [0] * self.LEVELS

    def curve(self, us: float) -> "WorkCurve":
        return WorkCurve([g * us for g in self.grid], [b * us for b in self.best])


class WorkCurve:
    """W(d), the most work in any window of length d, in us: exact on the grid, and
    between grid points from adjacent windows (W is subadditive: W(a + b) <= W(a) + W(b))
    and W(d) <= d."""

    def __init__(self, grid: list[float], best: list[float], scale: float = 1.0, per_job: float = 0.0,
                 arrivals=None):
        self.g, self.b, self.scale = grid, best, scale
        self.per_job, self.arrivals = per_job, arrivals   # every job longer by per_job (room to grow)

    def w(self, d: float) -> float:
        if d <= 0:
            return 0.0
        g, b = self.g, self.b
        n = int(d // g[-1])
        tot = n * b[-1]
        rem = d - n * g[-1]
        for k in range(len(g) - 2, -1, -1):
            if rem >= g[k]:
                tot += b[k]
                rem -= g[k]
        if rem > 0:
            tot += min(rem, b[0])
        tot *= self.scale
        if self.per_job:
            # the jobs released in the window, and one begun before it
            tot += (self.arrivals.eta(d) + 1) * self.per_job
        return min(tot, d)

    def scaled(self, f: float) -> "WorkCurve":
        return WorkCurve(self.g, self.b, self.scale * f, self.per_job * f, self.arrivals)

    def grown(self, x: float, arrivals) -> "WorkCurve":
        return WorkCurve(self.g, self.b, self.scale, self.per_job + x, arrivals)


# ---------------------------------------------------------------- jobs from the trace

@dataclass
class ThreadJobs:
    ptr: int
    arrivals: Arrivals
    work: Workload
    wait_by_key: Counter = field(default_factory=Counter)
    blocks: int = 0
    release: int | None = None        # a declared release object (its wait queue address)
    release_sym: str | None = None    # or its symbol ("sleep": the thread's k_sleep)
    is_release: dict = field(default_factory=dict)   # wait queue -> matches release_sym
    jobs: int = 0
    discarded: int = 0
    c: deque = field(default_factory=lambda: deque(maxlen=4096))   # net execution, ticks
    r: deque = field(default_factory=lambda: deque(maxlen=4096))   # response
    top: list = field(default_factory=list)   # the K largest job execution times, largest first
    c_max: int = 0
    r_max: int = 0
    s_max: int = 0
    inv_max: int = 0
    inv_by: int = 0                   # the lower-priority thread of the worst inversion
    seg_max: int = 0                  # longest net run without a switch (for cooperative blocking)
    seg_max_at: int = 0               # and when it ended
    c_max_at: int = 0                 # when the longest job ended
    # the job in progress
    in_job: bool = False
    rel: int = 0
    jc: int = 0
    js: int = 0
    jinv: int = 0
    jinv_by: Counter = field(default_factory=Counter)
    run_from: int | None = None
    seg_isr: int = 0                  # interrupt time (the tracker's running total) when the run began
    blocked: tuple[int, int] | None = None
    ready: bool = False
    ready_at: int = 0                 # when it became ready, and the interrupt total then
    ready_isr: int = 0

    def release_key(self) -> int | None:
        if self.release is not None:
            return self.release
        return max(self.wait_by_key, key=self.wait_by_key.__getitem__) if self.wait_by_key else None


@dataclass
class IrqJobs:
    irq: int
    arrivals: Arrivals
    work: Workload          # its exclusive run time: bursts of short entries, a rare long one
    c_max: int = 0          # exclusive of nested interrupts
    count: int = 0


class JobTracker:
    """Jobs and arrivals from the scheduler's records (any capture preset)."""
    WARMUP_BLOCKS = 10

    def __init__(self, hello, threads: dict, horizon_s: float = 1.0, release: dict[int, int] | None = None,
                 irqs: dict | None = None, release_by_name: dict[str, str] | None = None,
                 thread_name=None, obj_name=None):
        self.hello = hello
        self.threads_tab = threads             # the decoder's thread table (live: kept up to date)
        self.irqs_tab = irqs if irqs is not None else {}
        # declared release objects, by thread name and object symbol (the deadlines file)
        self.release_by_name = release_by_name or {}
        self.thread_name = thread_name or (lambda p: "")
        self.obj_name = obj_name or (lambda a: None)
        self.h = int(horizon_s * (hello.ts_hz or 1))
        self.g0 = max(1, int(5e-6 * (hello.ts_hz or 1)))    # the workload grid starts at 5 us
        self.release = release or {}           # thread -> declared release wait queue
        self.th: dict[int, ThreadJobs] = {}
        self.irqs: dict[int, IrqJobs] = {}
        self.cur: int | None = hello.sender or None
        self.ready: set[int] = set()
        self.prio_seen: dict[int, int] = {}
        self._stack: list[list[int]] = []      # [irq, t_enter, nested time]
        self.isr_total = 0                     # top-level interrupt time so far
        self._idle: dict[int, bool] = {}
        self.t0: int | None = None
        self.t1 = 0
        self.gaps = 0

    def job(self, ptr: int) -> ThreadJobs:
        j = self.th.get(ptr)
        if j is None:
            j = self.th[ptr] = ThreadJobs(ptr, Arrivals(self.h), Workload(self.g0), release=self.release.get(ptr),
                                          release_sym=self.release_by_name.get(self.thread_name(ptr)))
        return j

    def is_idle(self, ptr: int) -> bool:
        v = self._idle.get(ptr)
        if v is None:
            v = self._idle[ptr] = self.thread_name(ptr) == "idle"
        return v

    def _ends_job(self, j: ThreadJobs, key: int) -> bool:
        if j.release_sym is not None:
            m = j.is_release.get(key)
            if m is None:
                if key == SLEEP_KEY:
                    m = j.release_sym == "sleep"
                else:
                    n = self.obj_name(key) if key > 0 else None
                    m = bool(n) and n.split("+")[0] == j.release_sym
                j.is_release[key] = m
            return m
        rk = j.release_key()
        return rk is None or rk == key

    def prio(self, ptr: int) -> int:
        t = self.threads_tab.get(ptr)
        return t.prio if t else self.prio_seen.get(ptr, 0)

    def feed(self, recs) -> None:
        for r in recs:
            rid, t = r.id, r.t
            if self.t0 is None:
                self.t0 = t
            self.t1 = t
            if rid == P.EV_SWITCH_IN:
                th = r.w[0]
                self.prio_seen.setdefault(th, r.arg - 65536 if r.arg & 0x8000 else r.arg)
                self.cur = th
                j = self.job(th)
                j.run_from, j.seg_isr = t, self.isr_total
                if j.ready:
                    j.ready = False
                    self.ready.discard(th)
            elif rid == P.EV_SWITCH_OUT:
                self._out(r.w[0], t, r.arg, r.w[1] if len(r.w) > 1 else 0)
            elif rid == P.EV_READY:
                self._ready(r.w[0], t)
            elif rid == P.EV_ISR_ENTER:
                self._stack.append([r.arg, t, 0])
                q = self.irqs.get(r.arg)
                if q is None:
                    q = self.irqs[r.arg] = IrqJobs(r.arg, Arrivals(self.h), Workload(self.g0))
                q.arrivals.add(t)
                q.count += 1
            elif rid == P.EV_ISR_EXIT:
                if self._stack:
                    irq, te, nested = self._stack.pop()
                    dt = t - te
                    q = self.irqs.get(irq)
                    if q is not None:
                        ex = dt - nested
                        q.c_max = max(q.c_max, ex)
                        q.work.add(t - ex, t)
                    if self._stack:
                        self._stack[-1][2] += dt
                    else:
                        self.isr_total += dt
            elif rid == P.EV_OVERFLOW:
                self._gap()
            elif rid == EV_SESSION:
                self._gap()
                self.cur = self.hello.sender or None

    def _gap(self) -> None:
        """Records were lost (or the connection broke): nothing in flight can be trusted."""
        self.gaps += 1
        for j in self.th.values():
            if j.in_job:
                j.discarded += 1
            j.in_job, j.blocked, j.ready, j.run_from = False, None, False, None
            j.arrivals.cut()
            j.work.cut()
        for q in self.irqs.values():
            q.arrivals.cut()
            q.work.cut()
        self.ready.clear()
        self._stack.clear()

    def _out(self, th: int, t: int, state: int, wq: int) -> None:
        j = self.job(th)
        if j.run_from is not None:
            seg = max(0, t - j.run_from - (self.isr_total - j.seg_isr))
            if seg > j.seg_max:
                j.seg_max, j.seg_max_at = seg, t
            if j.in_job:
                j.jc += seg
            j.work.add(t - seg, t)
            # inversion: a ready thread of higher priority waited while this one ran, from
            # when it became ready (interrupts in between are not this thread's doing). The
            # idle thread "runs" only until the switch a wakeup has asked for.
            if self.ready and not self.is_idle(th):
                p = self.prio(th)
                for w in self.ready:
                    if self.prio(w) < p:
                        wj = self.th[w]
                        if not wj.in_job:
                            continue
                        if wj.ready_at > j.run_from:
                            ov = t - wj.ready_at - (self.isr_total - wj.ready_isr)
                        else:
                            ov = seg
                        if ov > 0:
                            wj.jinv += ov
                            wj.jinv_by[th] += ov
            j.run_from = None
        if self.cur == th:
            self.cur = None
        if state & BLOCKING and not state & P.THS_QUEUED:
            key = wq if (state & P.THS_PENDING and wq) else (SLEEP_KEY if state & P.THS_SLEEPING else OTHER_KEY)
            j.blocked = (t, key)
            j.blocks += 1
            if j.in_job and self._ends_job(j, key):
                self._finish(j, t)
        else:
            self._set_ready(j, t)

    def _set_ready(self, j: ThreadJobs, t: int) -> None:
        if not j.ready:
            j.ready, j.ready_at, j.ready_isr = True, t, self.isr_total
            self.ready.add(j.ptr)

    def _ready(self, th: int, t: int) -> None:
        j = self.job(th)
        if j.blocked is not None:
            tb, key = j.blocked
            j.blocked = None
            j.wait_by_key[key] += t - tb
            if j.in_job:
                j.js += t - tb
            else:
                self._start(j, t)
        elif not j.in_job:
            self._start(j, t)
        self._set_ready(j, t)

    def _start(self, j: ThreadJobs, t: int) -> None:
        j.in_job, j.rel, j.jc, j.js, j.jinv = True, t, 0, 0, 0
        j.jinv_by.clear()
        if j.blocks > self.WARMUP_BLOCKS:
            j.arrivals.add(t)

    def _finish(self, j: ThreadJobs, t: int) -> None:
        j.in_job = False
        if j.blocks <= self.WARMUP_BLOCKS:
            return
        r = t - j.rel
        j.jobs += 1
        j.c.append(j.jc)
        j.r.append(r)
        if j.jc > j.c_max:
            j.c_max, j.c_max_at = j.jc, t
        if len(j.top) < Arrivals.K or j.jc > j.top[-1]:
            insort(j.top, j.jc, key=lambda x: -x)
            del j.top[Arrivals.K:]
        j.r_max = max(j.r_max, r)
        j.s_max = max(j.s_max, j.js)
        if j.jinv > j.inv_max:
            j.inv_max = j.jinv
            j.inv_by = j.jinv_by.most_common(1)[0][0]


# ---------------------------------------------------------------- the model

@dataclass
class Task:
    key: str
    name: str
    kind: str                     # "thread" or "irq"
    prio: float                   # Zephyr priority (threads); NVIC priority (interrupts)
    coop: bool
    c: float                      # worst execution, us (threads net of interrupts, interrupts exclusive)
    curve: object                 # eta(w), dist(q)
    s: float = 0.0                # worst self-suspension in one job
    b: float = 0.0                # blocking used by the analysis
    b_meas: float = 0.0           # worst measured time ready while a lower-priority thread ran
    b_by: str = ""                # that thread
    d: float | None = None        # deadline, us
    d_src: str | None = None      # "declared" or "period"
    periodic: bool = False
    t: float | None = None        # period, or the shortest interval seen
    j: float = 0.0                # release jitter against the period
    jobs: int = 0
    discarded: int = 0
    c_mean: float = 0.0
    c_p99: float = 0.0
    r_meas: float = 0.0
    r_p99: float = 0.0
    rate: float = 0.0             # events a second over the observation
    sender: bool = False
    seg_max: float = 0.0
    c_top: list | None = None     # the largest job execution times seen, largest first (us)
    work: WorkCurve | None = None  # the most work seen in any window (us): its interference
    counts: bool = True           # its deadline enters the verdict (declared ones do when any are)
    per_period: bool = False      # a job is one declared period's work (no release object)
    c_max_at: float | None = None   # seconds into the observation: its longest job,
    seg_max_at: float | None = None  # and its longest run without a switch

    def own(self, q: int) -> float:
        """Execution of q of its own jobs: the q largest seen (each later one is no
        larger than the last of them), never more than q times the worst."""
        top = self.c_top
        if not top:
            return q * self.c
        if q <= len(top):
            return sum(top[:q])
        return sum(top) + (q - len(top)) * top[-1]


def _p99(xs) -> float:
    s = sorted(xs)
    return s[int(0.99 * (len(s) - 1))] if s else 0.0


def build_model(jt: JobTracker, names, deadlines: dict[str, dict] | None = None,
                irq_name=None) -> list[Task]:
    """Tasks from a JobTracker: threads that completed jobs (not idle), and interrupts."""
    h = jt.hello
    us = 1e6 / (h.ts_hz or 1)
    deadlines = deadlines or {}
    span = max(1, jt.t1 - (jt.t0 or jt.t1)) * us / 1e6
    tasks: list[Task] = []
    for ptr, j in jt.th.items():
        name = names(ptr)
        if j.jobs == 0 or name == "idle":
            continue
        periodic, per = j.arrivals.period()
        cv = j.arrivals.curve(us)
        jit = 0.0
        if periodic and per:
            jit = max([0.0] + [(k + 1) * per * us - x for k, x in enumerate(cv.d)])
        decl = deadlines.get(name)
        d, src = None, None
        if decl and decl.get("deadline_us"):
            d, src = float(decl["deadline_us"]), "declared"
        elif periodic and per and ptr != h.sender:   # zprof's own sender: the observer, no verdict
            d, src = per * us, "period"
        cs = list(j.c)
        task = Task(
            key=f"t:{ptr}", name=name, kind="thread", prio=jt.prio(ptr), coop=jt.prio(ptr) < 0,
            c=j.c_max * us, curve=cv, s=j.s_max * us, b_meas=j.inv_max * us,
            b_by=names(j.inv_by) if j.inv_by else "", d=d, d_src=src, periodic=periodic,
            t=per * us if per else None, j=jit, jobs=j.jobs, discarded=j.discarded,
            c_mean=statistics.mean(cs) * us if cs else 0.0, c_p99=_p99(cs) * us,
            r_meas=j.r_max * us, r_p99=_p99(j.r) * us, rate=j.arrivals.n / span,
            sender=ptr == h.sender, seg_max=j.seg_max * us,
            c_top=[x * us for x in j.top], work=j.work.curve(us),
            c_max_at=(j.c_max_at - jt.t0) * us / 1e6 if j.c_max_at else None,
            seg_max_at=(j.seg_max_at - jt.t0) * us / 1e6 if j.seg_max_at else None)
        if decl and decl.get("period_us"):
            # A loop that waits on more than one thing per cycle (sleeps, a display's
            # refresh) has no release object: a job is one declared period, and its work
            # the most the thread did in any window that long (no less than any cycle's).
            T = float(decl["period_us"])
            task.c = task.work.w(T)
            task.c_top, task.curve, task.t, task.periodic, task.per_period = None, Periodic(T), T, True, True
            task.s, task.j, task.c_mean, task.c_p99, task.r_meas, task.r_p99 = 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
        tasks.append(task)
    # the deadlines that make the verdict: the declared ones if there are any (a thread
    # that sleeps in a loop has a period, not necessarily a deadline), else every period
    if any(t.d_src == "declared" for t in tasks):
        for t in tasks:
            t.counts = t.d_src == "declared"
    # cooperative threads are not preempted by other threads: a lower-priority one that is
    # running blocks a higher one for up to its longest run
    for t in tasks:
        below = [u for u in tasks if u.coop and u.prio > t.prio] if t.coop else []
        longest = max(below, key=lambda u: u.seg_max, default=None)
        t.b = t.b_meas
        if longest is not None and longest.seg_max > t.b_meas:
            when = f", {longest.seg_max_at:.1f} s in" if longest.seg_max_at is not None else ""
            t.b, t.b_by = longest.seg_max, f"{longest.name} (its longest run{when})"
    for irq, q in jt.irqs.items():
        if not q.count:
            continue
        cv = q.arrivals.curve(us)
        tab = jt.irqs_tab.get(irq)
        nvic = tab.prio if tab is not None else 0   # system exceptions: not in the table
        periodic, per = q.arrivals.period()
        tasks.append(Task(key=f"i:{irq}", name=irq_name(irq) if irq_name else f"IRQ {irq}", kind="irq",
                          prio=nvic, coop=False, c=q.c_max * us, curve=cv, periodic=periodic,
                          t=per * us if per else None, jobs=q.count, rate=q.count / span,
                          work=q.work.curve(us)))
    return tasks


# ---------------------------------------------------------------- response-time analysis

QMAX = 2000
ITER_MAX = 20000


class Analyzer:
    """Worst response bounds (us) for a task set; lazily, so a sensitivity search only
    computes what its deadlines need."""

    def __init__(self, tasks: list[Task], cap: float = 10e6):
        self.tasks = tasks
        self.cap = cap
        irqs = [t for t in tasks if t.kind == "irq"]
        self.threads = [t for t in tasks if t.kind == "thread"]
        self.hp = {t.key: irqs + [u for u in self.threads if u is not t and u.prio <= t.prio]
                   for t in self.threads}
        self.memo: dict[str, float] = {}
        self._busy: set[str] = set()
        self.parts: dict[str, dict] = {}

    def _term(self, j: Task):
        """What a higher task can take from a window of length w. A measured thread: the
        most work it did in any window that long (its workload curve). Otherwise (an
        interrupt, a what-if period): its arrivals times its worst execution; a thread
        that suspends inside a job interferes as if released up to R - C late (sound for
        dynamic self-suspension), or, while that bound is being computed or has none,
        with its suspension counted as execution (also sound)."""
        if j.work is not None:
            return j.work.w
        c, jit = j.c, 0.0
        if j.s > 0 and j.kind == "thread":
            r = INF if j.key in self._busy else self.R(j)
            c, jit = (j.c + j.s, 0.0) if r == INF else (j.c, r - j.c)
        eta = j.curve.eta
        return lambda w: eta(w + jit) * c

    def R(self, i: Task) -> float:
        if i.key in self.memo:
            return self.memo[i.key]
        self._busy.add(i.key)
        try:
            r = self._response(i)
        finally:
            self._busy.discard(i.key)
        self.memo[i.key] = r
        return r

    def _response(self, i: Task) -> float:
        """The worst response over the jobs of a level-i busy period: job q completes
        once blocking, its own q jobs' work, one self-suspension and the interference
        are done (w_q); it was released no earlier than dist(q - 1) after the first."""
        terms = [(j, self._term(j)) for j in self.hp.get(i.key, [])]
        own_w = i.work.w if i.work is not None else None

        def interference(w: float) -> float:
            return sum(f(w) for _, f in terms)

        def own(q: int, w: float) -> float:
            x = i.own(q)
            return min(x, own_w(w)) if own_w is not None and q > 1 else x

        # the level-i busy period
        L = i.b + i.s + i.c
        for _ in range(ITER_MAX):
            L2 = i.b + i.s + own(max(1, i.curve.eta(L)), L) + interference(L)
            if L2 > self.cap:
                return INF
            if L2 <= L + 1e-9:
                break
            L = L2
        else:
            return INF
        worst, parts = 0.0, None
        for q in range(1, min(max(1, i.curve.eta(L)), QMAX) + 1):
            w = i.b + i.s + i.own(q)
            for _ in range(ITER_MAX):
                w2 = i.b + i.s + own(q, w) + interference(w)
                if w2 > self.cap:
                    return INF
                if w2 <= w + 1e-9:
                    break
                w = w2
            else:
                return INF
            r = w - i.curve.dist(q - 1)
            if r > worst:
                worst = r
                parts = {"c": own(q, w), "s": i.s, "b": i.b, "q": q,
                         "by": sorted(((j.name, v) for j, f in terms if (v := f(w)) > 0), key=lambda x: -x[1])}
        self.parts[i.key] = parts or {}
        return worst


def judged(tasks: list[Task]) -> list[Task]:
    """The threads whose deadlines make the verdict."""
    return [t for t in tasks if t.kind == "thread" and t.d is not None and t.counts]


def all_meet(tasks: list[Task]) -> bool:
    a = Analyzer(tasks)
    return all(a.R(t) <= t.d for t in judged(tasks))


def grow_room(tasks: list[Task], i: Task, steps: int = 12) -> float:
    """How much more execution (us) every job of thread i can take while it, and every
    thread that meets its deadline now, still meets it."""
    a0 = Analyzer(tasks)
    keep = [t for t in judged(tasks) if a0.R(t) <= t.d]
    if i not in keep:
        return 0.0

    def ok(extra: float) -> bool:
        def grown(t: Task) -> Task:
            # every job longer by `extra`: each window holds that much more per job in it
            return replace(t, c=t.c + extra, c_top=[x + extra for x in t.c_top] if t.c_top else None,
                           work=t.work.grown(extra, t.curve) if t.work is not None else None)
        trial = [grown(t) if t.key == i.key else t for t in tasks]
        by = {t.key: t for t in trial}
        a = Analyzer(trial)
        return all(a.R(by[t.key]) <= t.d for t in keep)
    lo, hi = 0.0, (i.d or i.t or 1000.0)
    if ok(hi):
        return hi
    for _ in range(steps):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if ok(mid) else (lo, mid)
    return lo


def scaling_factor(tasks: list[Task], steps: int = 14) -> float | None:
    """The factor every execution time (threads and interrupts) can be multiplied by
    with every deadline still met (above 1: headroom; below 1: already short)."""
    if not judged(tasks):
        return None

    def ok(a: float) -> bool:
        return all_meet([replace(t, c=t.c * a, b=t.b * a, c_top=[x * a for x in t.c_top] if t.c_top else None,
                                 work=t.work.scaled(a) if t.work is not None else None) for t in tasks])
    lo, hi = 0.0, 16.0
    if ok(hi):
        return hi
    for _ in range(steps):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if ok(mid) else (lo, mid)
    return lo


def suggest_order(tasks: list[Task]) -> dict[str, float] | None:
    """Audsley's optimal priority assignment over the threads with deadlines, within
    their own kind (cooperative and preemptible threads keep their semantics) and on
    the priority values they use now; the other threads stay where they are. None:
    no such order meets every deadline."""
    dl = judged(tasks)
    out: dict[str, float] = {}
    for coop in (True, False):
        group = [t for t in dl if t.coop == coop]
        if len(group) < 2:
            continue
        slots = sorted((t.prio for t in group), reverse=True)   # lowest priority first
        todo = {t.key: t for t in group}
        for p in slots:
            # longest deadline first: where it works, the result is deadline monotonic
            for cand in sorted(todo.values(), key=lambda t: -(t.d or 0)):
                trial = []
                for t in tasks:
                    if t.key == cand.key:
                        trial.append(replace(t, prio=p))
                    elif t.key in todo:
                        trial.append(replace(t, prio=p - 0.5))         # every other unassigned: above
                    elif t.key in out:
                        trial.append(replace(t, prio=out[t.key]))
                    else:
                        trial.append(t)
                if Analyzer(trial).R(next(x for x in trial if x.key == cand.key)) <= cand.d:
                    out[cand.key] = p
                    del todo[cand.key]
                    break
            else:
                return None
    return out


# ---------------------------------------------------------------- the analysis for the page

def liu_layland(n: int) -> float:
    return n * (2 ** (1 / n) - 1) if n else 1.0


def analyze(tasks: list[Task], th: dict, full: bool = True, overrides: dict | None = None,
            observed_s: float = 0.0, gaps: int = 0) -> dict:
    """Everything the Schedulability view shows. `overrides`: {task name: {prio, c_us,
    t_us, d_us}} for a what-if (a period replaces the measured arrivals with a strictly
    periodic one)."""
    if overrides:
        tasks = [_override(t, overrides.get(t.name)) for t in tasks]
    a = Analyzer(tasks)
    rows = []
    worst_slack, worst_task = INF, None
    for t in tasks:
        r = a.R(t) if t.kind == "thread" else None
        # utilisation: the most work in any second (threads), the densest second's entries
        # times the worst entry (interrupts)
        u = t.work.w(1e6) if t.work is not None else t.curve.eta(1e6) * t.c
        row = {
            "key": t.key, "name": t.name, "kind": t.kind, "prio": t.prio, "coop": t.coop,
            "periodic": t.periodic, "t_us": t.t, "j_us": t.j, "c_us": t.c, "c_mean_us": t.c_mean,
            "c_p99_us": t.c_p99, "s_us": t.s, "b_us": t.b, "b_meas_us": t.b_meas, "b_by": t.b_by,
            "d_us": t.d, "d_src": t.d_src, "counts": t.counts and t.d is not None, "per_period": t.per_period,
            "jobs": t.jobs, "discarded": t.discarded, "rate_s": t.rate,
            "u_pct": 100 * u / 1e6, "r_meas_us": t.r_meas or None,
            "r_p99_us": t.r_p99 or None, "sender": t.sender, "c_max_at": t.c_max_at,
            "r_us": None if r is None or r == INF else r, "bounded": r is None or r != INF,
        }
        if t.kind == "thread" and t.d is not None:
            slack = 100 * (t.d - r) / t.d if r != INF else -INF
            row["slack_pct"] = slack if slack != -INF else None
            row["status"] = TH.status(th, TH.metric_id("sched", t.name, "slack_pct"), slack if slack != -INF else -1e9)
            row["parts"] = a.parts.get(t.key, {})
            if t.counts and slack < worst_slack:
                worst_slack, worst_task = slack, t.name
        rows.append(row)
    dl = judged(tasks)
    miss = [r for r in rows if r.get("counts") and r.get("status") == "crit"]
    out = {
        "type": "sched", "rows": rows,
        "deadlines": len(dl), "misses": len(miss),
        "worst_slack_pct": None if worst_slack in (INF, -INF) else worst_slack, "worst_task": worst_task,
        "u_pct": sum(r["u_pct"] for r in rows),
        # Liu and Layland: periodic threads, worst job over period
        "u_rm_pct": 100 * sum(t.c / t.t for t in tasks if t.kind == "thread" and t.periodic and t.t),
        "ll_pct": 100 * liu_layland(len([t for t in tasks if t.kind == "thread" and t.periodic and t.t])),
        "observed_s": observed_s, "jobs": sum(t.jobs for t in tasks if t.kind == "thread"),
        "discarded": sum(t.discarded for t in tasks), "gaps": gaps,
        "whatif": bool(overrides), "full": full,
    }
    if full and dl:
        out["scale"] = scaling_factor(tasks)
        keys = {t.key for t in dl}
        for row, t in zip(rows, tasks):
            if t.key in keys:
                row["grow_us"] = grow_room(tasks, t)
        order = suggest_order(tasks)
        out["order"] = None if order is None else {
            t.name: order[t.key] for t in tasks if t.key in order and order[t.key] != t.prio}
        out["order_found"] = order is not None
    out["recs"] = recommend(tasks, rows, out, th)
    return out


def _override(t: Task, o: dict | None) -> Task:
    if not o:
        return t
    t2 = replace(t)
    if o.get("prio") is not None:
        t2.prio = float(o["prio"])
        if t.kind == "thread":
            t2.coop = t2.prio < 0      # Zephyr: a negative priority is a cooperative thread
            if t.coop and not t2.coop:
                t2.b = t.b_meas        # no longer blocked by cooperative threads below it
    if o.get("c_us") is not None and t.c > 0:
        f = float(o["c_us"]) / t.c        # every job and the workload in proportion
        t2.c = float(o["c_us"])
        t2.c_top = [x * f for x in t.c_top] if t.c_top else None
        t2.work = t.work.scaled(f) if t.work is not None else None
    if o.get("t_us"):
        # a strictly periodic release instead of the measured one: arrivals times the worst job
        t2.curve, t2.t, t2.periodic = Periodic(float(o["t_us"]), t.j), float(o["t_us"]), True
        t2.work, t2.c_top = None, None
        if t.d_src == "period":
            t2.d = float(o["t_us"])
    if o.get("d_us") is not None:
        t2.d, t2.d_src = (float(o["d_us"]) or None), "declared"
    return t2


# ---------------------------------------------------------------- recommendations

def recommend(tasks: list[Task], rows: list[dict], out: dict, th: dict) -> list[dict]:
    by = {t.name: t for t in tasks}
    recs: list[dict] = []
    close: list[str] = []
    for row in rows:
        t = by[row["name"]]
        if t.kind != "thread" or t.d is None:
            continue
        name = t.name
        st = row.get("status", "idle")
        if not t.counts:
            # a period without a declared deadline: worth knowing, not a fault
            if st in ("warn", "crit"):
                slack = "no bound" if row["r_us"] is None else f"{row['slack_pct']:.0f} % slack"
                close.append(f"{name} ({slack})")
            continue
        r = row["r_us"]
        parts = row.get("parts") or {}
        if st in ("warn", "crit"):
            top = (parts.get("by") or [])[:3]
            why = ", ".join(f"{n} {us:,.0f} us" for n, us in top)
            head = (f"{name} can miss its {t.d:,.0f} us deadline if the worst cases seen coincide" if r is None or r > t.d
                    else f"{name} has {row['slack_pct']:.0f} % slack")
            own_note = (f" (the most it did in any {t.t:,.0f} us window: one period's work, an upper bound)"
                        if t.per_period else "")
            recs.append({"level": st, "task": name, "title": head,
                         "detail": (f"Bound {'none' if r is None else f'{r:,.0f} us'}: its own work "
                                    f"{parts.get('c', t.c):,.0f} us{own_note}"
                                    + (f", waits inside the job {parts.get('s', 0):,.0f} us" if parts.get("s") else "")
                                    + (f", blocking {parts.get('b', 0):,.0f} us" if parts.get("b") else "")
                                    + (f"; most of the rest from {why}" if why else "") + "."),
                         "advice": _advice(t, top, by)})
        # blocking: the time ready while a lower-priority thread ran
        bp = 100 * t.b / t.d
        bst = TH.status(th, TH.metric_id("sched", name, "blocking_pct"), bp)
        if bst in ("warn", "crit") and t.b > 0:
            src = (t.b_by or "a lower-priority cooperative thread").split(" (")[0]
            u = by.get(src)
            when = (f", {u.seg_max_at:.1f} s into the observation; it usually runs "
                    f"{u.c_p99:,.0f} us a job (99th percentile)") if u is not None and u.seg_max_at is not None else ""
            recs.append({"level": bst, "task": name,
                         "title": f"{name} is blocked up to {t.b:,.0f} us ({bp:.0f} % of its deadline)",
                         "detail": (f"{src} is cooperative and below it: once running, it is not preempted, for up to "
                                    f"{t.b:,.0f} us (its longest run{when})" if t.b > t.b_meas else
                                    f"Measured: up to {t.b_meas:,.0f} us ready while {src} ran") + ".",
                         "advice": f"Shorten {src}'s longest run (split it, yield), make it preemptible, or "
                                   f"protect the shared data so {name} does not wait for it."})
        # load from threads above it that run on events from outside (no period)
        spor = sum(us for n, us in parts.get("by", []) if n in by and by[n].kind == "thread" and not by[n].periodic)
        sp = 100 * spor / t.d
        sst = TH.status(th, TH.metric_id("sched", name, "sporadic_pct"), sp)
        if sst in ("warn", "crit"):
            names = [n for n, _ in parts.get("by", []) if n in by and by[n].kind == "thread" and not by[n].periodic][:3]
            recs.append({"level": sst, "task": name,
                         "title": f"Threads without a period above {name} can take {sp:.0f} % of its deadline",
                         "detail": f"{', '.join(names)}: their load comes from outside (network, commands) and "
                                   f"has no bound but the bursts seen.",
                         "advice": "Rate-limit their input, or run them below the threads with deadlines."})
        # the model against what was measured
        if r is not None and t.r_meas > r * 1.01:
            recs.append({"level": "warn", "task": name,
                         "title": f"{name} took longer than its bound: {t.r_meas:,.0f} us measured, {r:,.0f} us bound",
                         "detail": "The model misses a cause: interrupts locked, the scheduler locked, or a wait "
                                   "inside the job it counts as the release.",
                         "advice": "Mark the job with zprof markers, or declare its release object in the deadlines file."})
    if close:
        recs.append({"level": "info", "task": "",
                     "title": f"Close to or past their period, with no deadline declared: {', '.join(close)}",
                     "detail": "Periodic threads analysed against their period for information; not in the verdict.",
                     "advice": "Declare a deadline in the deadlines file for any whose period is a requirement."})
    if out.get("order"):
        moves = ", ".join(f"{n} {by[n].prio:g} -> {p:g}" for n, p in out["order"].items())
        level = "warn" if out.get("misses") or any(r.get("status") == "warn" for r in rows) else "info"
        recs.append({"level": level, "task": "",
                     "title": "A priority order that meets every deadline" if level == "warn"
                     else "Priorities differ from deadline monotonic order",
                     "detail": f"Audsley's assignment on the same priority values: {moves}.",
                     "advice": "Try it in the what-if first; cooperative and preemptible threads keep their kind."
                     if level == "warn" else "Every deadline is met as it is: no change needed."})
    elif out.get("order_found") is False:
        recs.append({"level": "crit", "task": "", "title": "No priority order meets every deadline",
                     "detail": "With the execution times and bursts observed, reordering the threads with "
                               "deadlines is not enough.",
                     "advice": "Reduce the work of the threads with the least slack, or of the interrupts above them."})
    n = len([t for t in tasks if t.kind == "thread" and t.periodic and t.t])
    if out["u_rm_pct"] > out["ll_pct"] and n:
        recs.append({"level": "info", "task": "",
                     "title": f"Periodic utilisation {out['u_rm_pct']:.0f} % is above the Liu and Layland bound "
                              f"({out['ll_pct']:.0f} % for {n} periodic threads)",
                     "detail": "The bound is sufficient, not necessary; the response-time analysis decides.",
                     "advice": ""})
    if out["discarded"]:
        recs.append({"level": "info", "task": "",
                     "title": f"{out['discarded']} jobs left out: records were lost under them",
                     "detail": f"{out['gaps']} gaps in the record. A lighter capture preset loses fewer.",
                     "advice": ""})
    order = {"crit": 0, "warn": 1, "info": 2}
    recs.sort(key=lambda x: order.get(x["level"], 3))
    return recs


def _advice(t: Task, top: list[tuple[str, float]], by: dict[str, Task]) -> str:
    if not top:
        return f"Reduce {t.name}'s own work ({t.c:,.0f} us worst)."
    n, us = top[0]
    src = by.get(n)
    if src is None:
        return ""
    if src.kind == "irq":
        return (f"The interrupt {n} runs up to {src.c:,.0f} us each time: move its work to a thread "
                f"if it can wait, or check why it fires so often.")
    if not src.periodic:
        below = f"move it below {t.name}"
        if src.coop and not t.coop:
            # a cooperative thread is above every preemptible one: below means preemptible
            below = f"make it preemptible and give it a priority below {t.name}"
            if n.startswith(("rx_q[", "tx_q[")):
                below += (" (Zephyr's network traffic-class threads: CONFIG_NET_TC_THREAD_PREEMPTIVE, "
                          "their priorities with CONFIG_NET_TC_THREAD_PRIO_CUSTOM)")
        return f"{n} runs on events from outside above {t.name} ({us:,.0f} us of the bound): rate-limit its input, or {below}."
    if src.d is not None and t.d is not None and src.d > t.d:
        return (f"{n} has a longer deadline ({src.d:,.0f} us) but runs above {t.name}: "
                f"deadline monotonic order puts it below.")
    return f"{n} takes {us:,.0f} us of the bound: shorten its work or split it."


# ---------------------------------------------------------------- text report

def _us(x) -> str:
    return "" if x is None else (f"{x:,.0f}" if x >= 100 else f"{x:.1f}")


def sched_report(out: dict) -> str:
    L = []
    sc = out.get("scale")
    L.append(f"observed {out['observed_s']:.1f} s, {out['jobs']:,} jobs ({out['discarded']} left out at "
             f"{out['gaps']} gaps); {out['deadlines']} threads with deadlines, {out['misses']} can miss; "
             f"worst slack {out['worst_slack_pct'] if out['worst_slack_pct'] is None else round(out['worst_slack_pct'])} % "
             f"({out['worst_task']}); every execution time can scale by {'' if sc is None else f'{sc:.2f}'}")
    L.append(f"utilisation {out['u_pct']:.0f} % (each thread's busiest second, summed); periodic threads "
             f"{out['u_rm_pct']:.0f} % against the Liu and Layland bound {out['ll_pct']:.0f} %")
    L.append("")
    L.append(f"{'thread':22s} {'prio':>5s} {'kind':5s} {'T us':>8s} {'J':>6s} {'C max':>7s} {'C p99':>7s} "
             f"{'S':>6s} {'B':>6s} {'D':>7s} {'R bound':>8s} {'R meas':>7s} {'slack':>6s} {'grow':>6s}  jobs")
    rows = sorted(out["rows"], key=lambda r: (r["kind"] != "thread", r["d_us"] is None, r["prio"]))
    for r in rows:
        if r["kind"] != "thread":
            continue
        kind = ("coop " if r["coop"] else "") + ("per" if r["periodic"] else "spor")
        slack = "" if r.get("slack_pct") is None else f"{r['slack_pct']:.0f}%"
        L.append(f"{r['name'][:22]:22s} {r['prio']:>5g} {kind:5s} {_us(r['t_us']):>8s} {_us(r['j_us']):>6s} "
                 f"{_us(r['c_us']):>7s} {_us(r['c_p99_us']):>7s} {_us(r['s_us']):>6s} {_us(r['b_us']):>6s} "
                 f"{_us(r['d_us']):>7s} {('none' if not r['bounded'] else _us(r['r_us'])):>8s} "
                 f"{_us(r['r_meas_us']):>7s} {slack:>6s} {_us(r.get('grow_us')):>6s}  {r['jobs']}"
                 + ("  (zprof)" if r["sender"] else "") + (f"  [{r['status']}]" if r.get("status") not in (None, "ok") else ""))
    L.append("")
    L.append(f"{'interrupt':36s} {'/s':>7s} {'C max us':>9s} {'U %':>6s}")
    for r in sorted((r for r in out["rows"] if r["kind"] == "irq"), key=lambda r: -r["u_pct"])[:12]:
        L.append(f"{r['name'][:36]:36s} {r['rate_s']:7.0f} {_us(r['c_us']):>9s} {r['u_pct']:6.2f}")
    if out.get("recs"):
        L.append("")
        for x in out["recs"]:
            L.append(f"[{x['level']}] {x['title']}")
            if x.get("detail"):
                L.append(f"        {x['detail']}")
            if x.get("advice"):
                L.append(f"        -> {x['advice']}")
    return "\n".join(L)


# ---------------------------------------------------------------- deadlines file

def load_deadlines(path: str | Path | None) -> dict[str, dict]:
    """{thread name: {"deadline_us": .., "release": symbol or "sleep", "why": ..}}"""
    if not path:
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8")).get("threads", {})


def releases(deadlines: dict[str, dict]) -> dict[str, str]:
    return {n: d["release"] for n, d in deadlines.items() if d.get("release")}
