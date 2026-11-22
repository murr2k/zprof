# SPDX-License-Identifier: Apache-2.0
"""Export a decoded session as Trace Event JSON for ui.perfetto.dev (or
chrome://tracing): the CPU as one track of who ran (the SystemView row), one
track per thread with its runs (priority and wake latency as arguments), one
track per interrupt, and a marker wherever the target dropped records.
Times are microseconds from the first record.
"""
from __future__ import annotations

import json
from pathlib import Path

from .analyze import Analysis

PID_CPU, PID_THREADS, PID_IRQS = 1, 2, 3


def export(an: Analysis, path: str | Path) -> dict[str, int]:
    hz = an.d.hello.ts_hz or 1
    t0 = an.t0

    def us(t: int) -> float:
        return round((t - t0) * 1e6 / hz, 3)

    ev: list[dict] = []

    def meta(pid: int, tid: int | None, name: str, sort: int | None = None) -> None:
        if tid is None:
            ev.append({"ph": "M", "pid": pid, "name": "process_name", "args": {"name": name}})
        else:
            ev.append({"ph": "M", "pid": pid, "tid": tid, "name": "thread_name", "args": {"name": name}})
            if sort is not None:
                ev.append({"ph": "M", "pid": pid, "tid": tid, "name": "thread_sort_index",
                           "args": {"sort_index": sort}})

    meta(PID_CPU, None, f"CPU ({an.d.hello.kernel or 'Zephyr'})")
    meta(PID_CPU, 1, "running")
    meta(PID_THREADS, None, "Threads")
    meta(PID_IRQS, None, "Interrupts")

    wake_of = {(th, tin): tin - tr for th, tr, tin in an.wakes}
    order = sorted(an.threads.values(), key=lambda u: -sum(b - a for a, b in u.intervals))
    n_slices = 0
    for i, u in enumerate(order, start=1):
        name = an.thread_name(u.ptr)
        t = an.d.threads.get(u.ptr)
        meta(PID_THREADS, i, name, sort=i)
        for a, b in u.intervals:
            args = {"prio": t.prio if t else None}
            w = wake_of.get((u.ptr, a))
            if w is not None:
                args["woken_after_us"] = round(w * 1e6 / hz, 3)
            ev.append({"ph": "X", "pid": PID_THREADS, "tid": i, "name": name, "ts": us(a),
                       "dur": round((b - a) * 1e6 / hz, 3), "args": args})
            ev.append({"ph": "X", "pid": PID_CPU, "tid": 1, "name": name, "ts": us(a),
                       "dur": round((b - a) * 1e6 / hz, 3)})
            n_slices += 2

    irq_tid: dict[int, int] = {}
    for irq, a, b, depth in an.isr_spans:
        tid = irq_tid.get(irq)
        if tid is None:
            tid = irq_tid[irq] = len(irq_tid) + 1
            meta(PID_IRQS, tid, an.irq_name(irq), sort=tid)
        ev.append({"ph": "X", "pid": PID_IRQS, "tid": tid, "name": an.irq_name(irq), "ts": us(a),
                   "dur": round((b - a) * 1e6 / hz, 3), "args": {"nesting": depth}})
        n_slices += 1

    for t, n in an.drops:
        ev.append({"ph": "i", "s": "g", "pid": PID_CPU, "tid": 1, "ts": us(t),
                   "name": f"{n} trace records dropped"})

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"traceEvents": ev, "displayTimeUnit": "ns",
                   "otherData": {"source": "zprof", "kernel": an.d.hello.kernel}}, f, separators=(",", ":"))
    return {"slices": n_slices, "threads": len(order), "interrupts": len(irq_tid), "drops": len(an.drops)}
