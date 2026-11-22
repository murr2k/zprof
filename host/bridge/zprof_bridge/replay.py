# SPDX-License-Identifier: Apache-2.0
"""Replay equals live: a recording decoded the way it arrived (the bridge's socket
reads, as recorded) and split into other pieces must give the same answers, and the
live trackers the same totals as the batch analysis.

  python -m zprof_bridge check rec.zpr

Compared: the record count; per thread its time on the CPU, interrupt time inside
it and switches; per interrupt its count, total and worst; the per-second
statistics; the jobs (count, worst execution, response, waits); and the Timing
view's series. Any difference fails.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import record
from .analyze import Analysis
from .elf import Elf
from .live import LiveSession
from .stream import Decoder


def _live(path: str | Path, chunk: int | None, elf: Elf | None) -> tuple[LiveSession, list[dict]]:
    s = LiveSession(elf, source="replay")
    stats: list[dict] = []
    for _, data in record.read(path)[1]:
        if not data:
            s.restart()
            continue
        pieces = [data] if chunk is None else [data[i:i + chunk] for i in range(0, len(data), chunk)]
        for p in pieces:
            s.feed(p)
            stats.extend(s.new_stats)
            s.new_stats.clear()
            s.retained.clear()
            s.pending.clear()
    if s.tr is not None:
        s.tr.finish()
    return s, stats


def _digest(s: LiveSession, stats: list[dict]) -> dict:
    tr, jt, tt = s.tr, s.jt, s.tt
    return {
        "records": tr.records,
        "dropped": tr.dropped,
        "threads": {p: (u.run, u.isr_in, u.switches_in) for p, u in sorted(tr.threads.items())},
        "irqs": {i: (u.count, u.total, u.worst) for i, u in sorted(tr.irqs.items())},
        "stats": hashlib.sha256(json.dumps(stats, sort_keys=True).encode()).hexdigest()[:16],
        "windows": len(stats),
        "jobs": {p: (j.jobs, j.c_max, j.r_max, j.s_max, j.inv_max) for p, j in sorted(jt.th.items())},
        "timing": {k: len(v.pts) for k, v in sorted({**tt.metrics, **tt.plots, **tt.spans}.items())},
    }


def check(path: str | Path, elf: Elf | None = None) -> tuple[bool, list[str]]:
    lines: list[str] = []
    ok = True
    ref_s, ref_stats = _live(path, None, elf)
    ref = _digest(ref_s, ref_stats)
    lines.append(f"as recorded: {ref['records']:,} records, {len(ref['threads'])} threads, "
                 f"{len(ref['irqs'])} interrupts, {ref['windows']} one-second windows, "
                 f"{sum(v[0] for v in ref['jobs'].values()):,} jobs")
    for chunk in (997, 65536):
        got = _digest(*_live(path, chunk, elf))
        diff = [k for k in ref if ref[k] != got[k]]
        ok &= not diff
        lines.append(f"in pieces of {chunk:,} bytes: " + ("the same" if not diff else f"DIFFERENT: {', '.join(diff)}"))
    # the live trackers against the batch analysis (which keeps every interval)
    d = Decoder()
    record.feed_all(path, d)
    if d.reboots:
        lines.append("batch: the recording spans a reboot; the batch analysis covers the last boot only (not compared)")
    else:
        an = Analysis(d, elf)
        bt = {p: (u.run, u.isr_in, u.switches_in) for p, u in sorted(an.threads.items())}
        bi = {i: (u.count, u.total, u.worst) for i, u in sorted(an.irqs.items())}
        same = bt == ref["threads"] and bi == ref["irqs"] and an.tracker.records == ref["records"]
        ok &= same
        lines.append("batch analysis: " + ("the same per-thread and per-interrupt totals" if same else "DIFFERENT totals"))
    lines.append("PASS" if ok else "FAIL")
    return ok, lines
