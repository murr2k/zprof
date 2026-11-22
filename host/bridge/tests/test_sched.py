# SPDX-License-Identifier: Apache-2.0
"""Schedulability: the response-time analysis against known answers and against a
simulation, arrival curves, jobs from a synthetic trace, the priority order."""
from __future__ import annotations

import math
import random

from zprof_bridge import proto as P
from zprof_bridge import thresholds as TH
from zprof_bridge.sched import (Analyzer, Arrivals, JobTracker, Periodic, Task, Workload, analyze, build_model,
                                grow_room, scaling_factor, suggest_order)
from zprof_bridge.stream import Decoder

from test_stream import A, B, HZ, SENDER, Enc


def task(name, prio, c, t, d=None, coop=False, s=0.0, b=0.0) -> Task:
    return Task(key=name, name=name, kind="thread", prio=prio, coop=coop, c=c, curve=Periodic(t),
                s=s, b=b, d=d if d is not None else t, d_src="period", periodic=True, t=t)


def test_the_textbook_example() -> None:
    # Burns and Wellings: (T, C) = (7, 3), (12, 3), (20, 5), rate monotonic: R = 3, 6, 20
    ts = [task("a", 1, 3, 7), task("b", 2, 3, 12), task("c", 3, 5, 20)]
    an = Analyzer(ts)
    assert [an.R(t) for t in ts] == [3, 6, 20]
    a = scaling_factor(ts)
    assert 0.99 <= a <= 1.0          # c meets its deadline exactly: no headroom


def simulate(ts: list[tuple[int, int, int]]) -> list[int]:
    """Worst response of each (prio, C, T) under preemptive fixed priorities from a
    synchronous release (the critical instant), in unit steps over the hyperperiod."""
    hyper = 1
    for _, _, t in ts:
        hyper = hyper * t // math.gcd(hyper, t)
    left = [[] for _ in ts]          # remaining work of queued jobs (FIFO), with their release
    worst = [0] * len(ts)
    for now in range(2 * hyper):
        for i, (_, c, t) in enumerate(ts):
            if now % t == 0 and now < hyper:
                left[i].append([now, c])
        ready = [i for i in range(len(ts)) if left[i]]
        if ready:
            i = min(ready, key=lambda k: ts[k][0])
            left[i][0][1] -= 1
            if left[i][0][1] == 0:
                rel, _ = left[i].pop(0)
                worst[i] = max(worst[i], now + 1 - rel)
    return worst


def test_against_a_simulation() -> None:
    rnd = random.Random(7)
    checked = 0
    for _ in range(300):
        n = rnd.randint(2, 4)
        ts = []
        for p in range(n):
            t = rnd.choice([4, 5, 6, 8, 10, 12, 15, 20])
            ts.append((p, rnd.randint(1, max(1, t // 2)), t))
        if sum(c / t for _, c, t in ts) > 0.98:
            continue
        model = [Task(key=str(i), name=str(i), kind="thread", prio=p, coop=False, c=c, curve=Periodic(t),
                      d=None, periodic=True, t=t) for i, (p, c, t) in enumerate(ts)]
        an = Analyzer(model)
        assert [an.R(m) for m in model] == simulate(ts), ts   # exact, also where R > T
        checked += 1
    assert checked > 150


def test_arrival_curves_from_events() -> None:
    a = Arrivals(horizon=10_000)
    rnd = random.Random(1)
    times = [k * 100 + rnd.randint(0, 20) for k in range(300)]   # period 100, jitter up to 20
    for t in times:
        a.add(t)
    c = a.curve(1.0)
    for w in (1, 50, 81, 100, 150, 250, 999, 5000, 20_000):
        exact = max(sum(1 for x in times if s <= x < s + w) for s in times)
        assert c.eta(w) >= exact                       # never fewer than seen (a bound)
        if w <= Arrivals.K * 80:
            assert c.eta(w) == exact                   # and exact within what it measured
    periodic, per = a.period()
    assert periodic and 90 <= per <= 110
    a.cut()                                            # a gap: no span bridges it
    a.add(times[-1] + 1)
    assert a.curve(1.0).eta(2) == 1


def test_workload_curves_bound_what_was_done() -> None:
    rnd = random.Random(3)
    wl = Workload(g0=5)
    segs, t = [], 0
    for _ in range(400):
        t += rnd.randint(1, 300)
        w = rnd.randint(1, 60)
        segs.append((t, t + w))
        wl.add(t, t + w)
        t += w
    c = wl.curve(1.0)

    def exact(d: float) -> float:      # the most work in any window [e - d, e] ending at a segment end
        return max(sum(max(0, b - max(a, e - d)) for a, b in segs if b <= e) for _, e in segs)
    for k, g in enumerate(wl.grid[:9]):
        assert wl.best[k] == exact(g)                   # exact on the grid
    for d in (7, 33, 101, 444, 1234, 5000, 50_000):
        assert exact(d) <= c.w(d) <= d                  # a bound between grid points, never above d


def test_a_what_if_priority_changes_the_kind() -> None:
    from zprof_bridge.sched import _override
    rx = task("rx", -1, 2, 10, coop=True, b=5)
    rx.b_meas = 1.0
    moved = _override(rx, {"prio": 4})
    assert not moved.coop and moved.prio == 4 and moved.b == 1.0   # preemptible: no cooperative blocking
    assert _override(rx, {"prio": -3}).coop


def test_priority_order_and_room_to_grow() -> None:
    # the short-deadline task below the long one misses; swapped, both meet
    ts = [task("long", 1, 4, 10), task("short", 2, 2, 5)]
    assert Analyzer(ts).R(ts[1]) == 6 > 5
    order = suggest_order(ts)
    assert order == {"short": 1, "long": 2}
    ok = [Task(**{**t.__dict__, "prio": order[t.key]}) for t in ts]
    an = Analyzer(ok)
    assert an.R(ok[1]) == 2 and an.R(ok[0]) == 8
    one = [task("x", 1, 4, 10)]
    assert abs(grow_room(one, one[0]) - 6) < 0.01


def test_cooperative_blocking_and_suspension() -> None:
    # a suspending task above makes the one below worse (its jitter), never better
    plain = [task("hi", 1, 2, 10), task("lo", 2, 3, 20)]
    susp = [task("hi", 1, 2, 10, s=4), task("lo", 2, 3, 20)]
    assert Analyzer(susp).R(susp[1]) >= Analyzer(plain).R(plain[1])
    blocked = [task("hi", 1, 2, 10, b=3)]
    assert Analyzer(blocked).R(blocked[0]) == 5


def _trace() -> Decoder:
    """A (prio 0) runs a job every 1 ms on a semaphore, waits 50 us on a second object
    inside it; B (prio 5, lower) runs between and once keeps A waiting 30 us."""
    e = Enc()
    e.hello()
    us = HZ // 1_000_000
    r = Enc.rec
    SEM, DMA = 0x34010000, 0x34010040
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, P.THS_PENDING, SENDER, 0x34020000)
    t = 10 * us
    for k in range(40):
        t0 = t + k * 1000 * us
        tr += r(t0, P.EV_READY, 0, A)                                   # released
        if k == 30:                                                     # B runs while A is ready
            tr += r(t0, P.EV_SWITCH_IN, 5, B) + r(t0 + 30 * us, P.EV_SWITCH_OUT, P.THS_PENDING, B, 0x34030000)
            tr += r(t0 + 30 * us, P.EV_SWITCH_IN, 0, A)
        else:
            tr += r(t0, P.EV_SWITCH_IN, 0, A)
        start = t0 + (30 * us if k == 30 else 0)
        tr += r(start + 100 * us, P.EV_SWITCH_OUT, P.THS_PENDING, A, DMA)   # waits inside the job
        tr += r(start + 150 * us, P.EV_READY, 0, A) + r(start + 150 * us, P.EV_SWITCH_IN, 0, A)
        tr += r(start + 250 * us, P.EV_SWITCH_OUT, P.THS_PENDING, A, SEM)   # done: waits for the next
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    return d


def test_jobs_from_marks() -> None:
    """A (the UI loop) marks frames: STOP(1) at a hand-over, START right after; an idle
    slot ends with STOP(0). One frame waits 2 ms inside (a DMA)."""
    e = Enc()
    e.hello()
    us = HZ // 1_000_000
    r = Enc.rec
    FRAME = 0x70001000
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, P.THS_PENDING, SENDER, 0x34020000) + r(0, P.EV_SWITCH_IN, 0, A)
    tr += r(0, P.EV_MARK_START, 0, FRAME, 0)
    t = 0
    for k in range(30):
        if k % 3 == 2:                                              # an idle slot: 300 us of work, sleep
            tr += r(t + 300 * us, P.EV_MARK_STOP, 0, FRAME, 0)
            tr += r(t + 300 * us, P.EV_SWITCH_OUT, P.THS_SLEEPING, A, 0)
            tr += r(t + 4300 * us, P.EV_READY, 0, A) + r(t + 4300 * us, P.EV_SWITCH_IN, 0, A)
            t += 4300 * us
            tr += r(t, P.EV_MARK_START, 0, FRAME, 0)
            continue
        work = 9000 if k == 4 else 5000
        if k == 7:                                                  # waits 2 ms inside the frame
            tr += r(t + 1000 * us, P.EV_SWITCH_OUT, P.THS_PENDING, A, 0x34010040)
            tr += r(t + 3000 * us, P.EV_READY, 0, A) + r(t + 3000 * us, P.EV_SWITCH_IN, 0, A)
            t += 2000 * us
        tr += r(t + work * us, P.EV_MARK_STOP, 0, FRAME, 1)           # handed over
        tr += r(t + work * us, P.EV_SWITCH_OUT, P.THS_SLEEPING, A, 0)  # present() waits for the blanking
        t += 16_667 * us
        tr += r(t, P.EV_READY, 0, A) + r(t, P.EV_SWITCH_IN, 0, A) + r(t, P.EV_MARK_START, 0, FRAME, 0)
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    names = {A: "main", B: "worker", SENDER: "zprof_sender"}
    jt = JobTracker(d.hello, d.threads, thread_name=lambda p: names.get(p, ""), job_marks={"main": "frame"},
                    mark_name=lambda a: "frame" if a == FRAME else None)
    jt.feed(d.records)
    j = jt.th[A]
    assert j.jobs == 20 and j.idle_marks == 10          # idle slots make no jobs
    assert j.c_max == 9000 * us                          # the heavy frame, nothing of the idle slot before it
    assert j.s_max == 2000 * us and j.r_max == 9000 * us
    dl = {"main": {"deadline_us": 16667, "period_us": 16667, "job": "frame"}}
    m = next(x for x in build_model(jt, lambda p: names.get(p, hex(p)), dl) if x.name == "main")
    assert m.marks == "frame" and not m.per_period and m.periodic and m.t == 16667 and abs(m.c - 9000) < 1
    out = analyze([m], TH.load())
    assert out["rows"][0]["r_us"] == 9000 + 2000       # own work and the wait inside


def test_event_loop_shapes_from_call_sites() -> None:
    """A waits for its events at one call site and, in one event of ten, on a mutex
    inside the handler; B sleeps at two places in turn (a sequential loop)."""
    from zprof_bridge.sched import loop_shape
    e = Enc()
    e.hello()
    us = HZ // 1_000_000
    r = Enc.rec
    SEM, MTX, S1, S2, S3, S4 = 0x34010000, 0x34010100, 0x70002001, 0x70002101, 0x70003001, 0x70003101
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, P.THS_PENDING, SENDER, 0x34020000)
    t = 0
    for k in range(60):
        tr += r(t, P.EV_READY, 0, A) + r(t, P.EV_SWITCH_IN, 0, A)
        if k % 10 == 3:
            tr += r(t + 10 * us, P.EV_SWITCH_OUT, P.THS_PENDING, A, MTX, S2)      # waits inside the handler
            tr += r(t + 30 * us, P.EV_READY, 0, A) + r(t + 30 * us, P.EV_SWITCH_IN, 0, A)
        tr += r(t + 50 * us, P.EV_SWITCH_OUT, P.THS_PENDING, A, SEM, S1)          # back to its one event wait
        tr += r(t + 60 * us, P.EV_READY, 0, B) + r(t + 60 * us, P.EV_SWITCH_IN, 5, B)
        tr += r(t + 80 * us, P.EV_SWITCH_OUT, P.THS_SLEEPING, B, 0, S3 if k % 2 else S4)
        t += 1000 * us
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    jt = JobTracker(d.hello, d.threads, thread_name=lambda p: {A: "main", B: "worker"}.get(p, ""))
    jt.feed(d.records)
    names = {S1: "a.c:10 (a)", S2: "a.c:20 (a)", S3: "b.c:30 (b)", S4: "b.c:40 (b)"}

    def sites(pcs):
        return {p: names[p] for p in pcs}
    obj = {SEM: "events", MTX: "lock"}.get
    a = loop_shape(jt.th[A], obj, sites)
    assert a["shape"] == "ao-inside" and abs(a["inside_pct"] - 10) < 2.5
    assert a["points"][0][0] == "events at a.c:10 (a)" and a["inside_by"][0][0] == "lock at a.c:20 (a)"
    b = loop_shape(jt.th[B], obj, sites)
    assert b["shape"] == "multi" and b["wait_points"] == 2


def test_jobs_from_a_trace() -> None:
    d = _trace()
    jt = JobTracker(d.hello, d.threads, irqs=d.irqs)
    jt.feed(d.records)
    j = jt.th[A]
    assert j.release_key() == 0x34010000                 # the semaphore: most time waited there
    assert j.jobs >= 25
    us = HZ // 1_000_000
    assert j.c_max == 200 * us                            # 100 + 100 us of work
    assert j.s_max == 50 * us                             # the wait inside the job
    assert j.r_max == 280 * us                            # 30 us blocked + 250 us
    assert j.inv_max == 30 * us and j.inv_by == B
    names = {A: "main", B: "worker", SENDER: "zprof_sender"}
    model = build_model(jt, lambda p: names.get(p, hex(p)))
    a = next(m for m in model if m.name == "main")
    assert a.periodic and abs(a.t - 1000) < 1 and a.d == a.t and a.d_src == "period"
    out = analyze(model, TH.load(), full=True)
    row = next(x for x in out["rows"] if x["name"] == "main")
    assert row["r_us"] >= row["r_meas_us"] - 1e-6        # the bound covers what was measured
    assert row["status"] == "ok"
