# SPDX-License-Identifier: Apache-2.0
"""Where the time goes inside a thread's work: spans (SPAN records: ZPROF_SPAN_* and
LVGL's profiler points, firmware/zprof/src/span.c) and PC samples (SAMPLE records,
src/sample.c). The control frames that turn them on, the decoding, and the summary's
sections: spans by name, PC samples by function, and the longest frames (between a
mark's START and STOP) with their spans and samples.

A span's duration is wall time on the target (preemption included); `on CPU` is
the part its thread actually ran, from the scheduler trace. `self` is a span's
time minus that of the spans recorded inside it (spans shorter than the shortest
kept count as self).
"""
from __future__ import annotations

import bisect
import struct
from collections import Counter, defaultdict
from dataclasses import dataclass

from . import proto as P


# ---------------------------------------------------------------- control

def spans_frame(on: bool, shortest_us: float = 20.0, deepest: int = 23) -> bytes:
    """CT_SPANS: record spans of at least `shortest_us`, no deeper than `deepest`."""
    v = struct.pack("<III", 1 if on else 0, int(round(shortest_us * 1000)), deepest)
    tlv = struct.pack("<HH", P.CT_SPANS, len(v)) + v
    return struct.pack("<BBHI", P.CH_CONTROL, 0, 0, len(tlv)) + tlv


def sample_frame(hz: int) -> bytes:
    """CT_SAMPLE: PC samples a second (0: off)."""
    v = struct.pack("<I", hz)
    tlv = struct.pack("<HH", P.CT_SAMPLE, len(v)) + v
    return struct.pack("<BBHI", P.CH_CONTROL, 0, 0, len(tlv)) + tlv


def spans_arg(s: str) -> tuple[float, int]:
    """--spans US[,DEPTH]: the shortest span kept (us) and the deepest level."""
    us, _, depth = s.partition(",")
    return float(us), int(depth) if depth else 23


# ---------------------------------------------------------------- decoding

@dataclass
class Span:
    t0: int          # begin, timestamp ticks
    t1: int          # end
    name: str
    depth: int       # nesting level in its thread (0: outermost kept)
    thread: int      # the thread it ran in
    cpu: int = 0     # ticks its thread ran inside it
    child: int = 0   # ticks of kept spans directly inside it


@dataclass
class Sample:
    t: int
    pc: int
    lr: int
    exc: int         # the interrupted exception (0: a thread)
    thread: int


class _Runs:
    """A thread's runs, sorted, for its time on the CPU inside a window in log time."""

    def __init__(self, intervals: list[tuple[int, int]]) -> None:
        self.iv = sorted(intervals)
        self.starts = [a for a, _ in self.iv]

    def within(self, t0: int, t1: int) -> int:
        i = max(0, bisect.bisect_right(self.starts, t0) - 1)
        n = 0
        while i < len(self.iv) and self.iv[i][0] < t1:
            a, b = self.iv[i]
            n += max(0, min(b, t1) - max(a, t0))
            i += 1
        return n


def _runs(an) -> dict[int, _Runs]:
    return {ptr: _Runs(u.intervals) for ptr, u in an.threads.items()}


def _strname(an, addr: int) -> str:
    s = an.elf.string(addr) if an.elf else None
    return s if s else f"{addr:#010x}"


def decode(an) -> tuple[list[Span], list[Sample]]:
    """The spans (with the thread that ran each, its time on the CPU and its kept
    children) and the samples of the analysed boot, in time order."""
    spans: list[Span] = []
    samples: list[Sample] = []
    cur = None
    recs = an.d.records[an.boot_from:] if an.boot_from else an.d.records
    names: dict[int, str] = {}
    for r in recs:
        if r.id == P.EV_SWITCH_IN and r.w:
            cur = r.w[0]
        elif r.id == P.EV_SPAN and len(r.w) >= 2:
            n = names.get(r.w[0])
            if n is None:
                n = names[r.w[0]] = _strname(an, r.w[0])
            spans.append(Span(r.t - r.w[1], r.t, n, r.arg, cur if cur is not None else 0))
        elif r.id == P.EV_SAMPLE and len(r.w) >= 3:
            samples.append(Sample(r.t, r.w[0], r.w[1], r.arg, r.w[2]))
    spans.sort(key=lambda s: (s.t0, -s.t1))
    runs = _runs(an)
    # on CPU: the thread's runs clipped to the span; children: the next level inside
    open_: dict[int, list[Span]] = defaultdict(list)
    for s in spans:
        rr = runs.get(s.thread)
        if rr:
            s.cpu = rr.within(s.t0, s.t1)
        st = open_[s.thread]
        while st and st[-1].t1 <= s.t0:
            st.pop()
        if st and s.t1 <= st[-1].t1:
            st[-1].child += s.t1 - s.t0
        st.append(s)
    return spans, samples


# ---------------------------------------------------------------- names for PCs

def func(an, pc: int) -> str:
    """The function a PC is in (from the ELF's functions), else its 256-byte block."""
    if an.elf:
        n = an.elf.function(pc)
        if n:
            return n
    return f"{pc & ~0xFF:#010x}~"


def caller(an, lr: int) -> str | None:
    """The function a stacked LR returns into, if it is a return address at all (a BL
    leaves bit 0 set; a non-leaf function's LR may hold anything)."""
    if not (lr & 1) or lr == 0xFFFFFFFF or not an.elf:
        return None
    return an.elf.function(lr)


def where(an, s: Sample) -> str:
    """The context a sample interrupted: a thread, or an interrupt or exception."""
    if s.exc == 0:
        return an.thread_name(s.thread)
    if s.exc >= 16:
        return "ISR " + an.irq_name(s.exc - 16)
    return "ISR " + an.irq_name(P.ISR_EXC | s.exc)


def _idle(an, s: Sample) -> bool:
    return s.exc == 0 and an.thread_name(s.thread) == "idle"


def _metric(an, name: str) -> int | None:
    idx = next((i for i, (n, _k, _u) in an.d.hello.metrics.items() if n == name), None)
    if idx is None:
        return None
    return sum(r.w[0] for r in an.d.records if r.id == P.EV_METRIC and r.arg == idx and r.w)


# ---------------------------------------------------------------- the summary

def _ms(an, ticks: int) -> float:
    return an.seconds(ticks) * 1e3


def _us(an, ticks: int) -> float:
    return an.seconds(ticks) * 1e6


def span_lines(an, spans: list[Span]) -> list[str]:
    h = an.d.hello
    kept, left = _metric(an, "zprof.spans"), _metric(an, "zprof.spans_left_out")
    head = f"spans    {len(spans):,} recorded"
    if h.spans[1] or h.spans[2]:
        head += f" (kept: at least {h.spans[1] / 1000:g} us, levels 0 to {h.spans[2]}"
        if left is not None:
            head += f"; {left:,} shorter or deeper left out on the target"
        head += ")"
    out = ["", head]
    if h.spans[3] and kept is not None and left is not None and an.t1 > an.t0:
        n = kept + left
        out.append(f"         their hooks: {n:,} spans x {_us(an, h.spans[3]) * 1000:.0f} ns (a begin and an end, "
                   f"timed alone by the target) = {100 * n * h.spans[3] / (an.t1 - an.t0):.2f} % of the CPU, "
                   "most of it in the frames that make the most spans. Not counted: what each call costs "
                   "the code around it (registers saved), which can be several times that; time frames "
                   "from a capture without --spans, and read spans for what a frame is made of")
    if not spans:
        return out
    by = defaultdict(list)
    for s in spans:
        by[(s.name, s.thread)].append(s)
    rows = []
    for (name, th), ss in by.items():
        wall = sum(s.t1 - s.t0 for s in ss)
        rows.append((wall, name, th, ss))
    rows.sort(key=lambda x: -x[0])
    out.append(f"  {'span':34s} {'thread':12s} {'count':>6s} {'total ms':>9s} {'on CPU':>7s} "
               f"{'self ms':>8s} {'mean us':>8s} {'max us':>8s}")
    for wall, name, th, ss in rows[:30]:
        cpu = sum(s.cpu for s in ss)
        self_ = sum(s.t1 - s.t0 - s.child for s in ss)
        mx = max(s.t1 - s.t0 for s in ss)
        out.append(f"  {name[:34]:34s} {an.thread_name(th)[:12]:12s} {len(ss):6d} {_ms(an, wall):9.2f} "
                   f"{100 * cpu / wall if wall else 0:6.1f}% {_ms(an, self_):8.2f} "
                   f"{_us(an, wall / len(ss)):8.1f} {_us(an, mx):8.1f}")
    if len(rows) > 30:
        out.append(f"  ({len(rows) - 30} more)")
    return out


def sample_lines(an, samples: list[Sample]) -> list[str]:
    h = an.d.hello
    secs = an.seconds(an.t1 - an.t0) or 1e-9
    rate = len(samples) / secs
    cost = an.seconds(h.sample[1]) * 1e6 if h.sample[1] else None   # the handler's mean run
    head = f"PC samples  {len(samples):,} ({rate:,.0f}/s"
    if h.sample[0]:
        head += f", {h.sample[0]:,} Hz asked"
    head += ")"
    if cost is not None:
        head += f", handler {cost:.2f} us each: {rate * cost / 1e4:.2f} % of the CPU"
    out = ["", head]
    if not samples:
        return out
    busy = [s for s in samples if not _idle(an, s)]
    out.append(f"  {len(samples) - len(busy):,} in idle ({100 * (len(samples) - len(busy)) / len(samples):.1f} %); "
               "below, the rest. Samples due in irq_lock() land where it ends.")
    by_f: dict[str, list[Sample]] = defaultdict(list)
    for s in busy:
        by_f[func(an, s.pc)].append(s)
    out.append(f"  {'function':40s} {'samples':>7s} {'%':>6s}  where (mostly)          called from (leaf, by LR)")
    n = len(busy) or 1
    for f, ss in sorted(by_f.items(), key=lambda kv: -len(kv[1]))[:30]:
        w, wn = Counter(where(an, s) for s in ss).most_common(1)[0]
        callers = Counter(c for c in (caller(an, s.lr) for s in ss) if c)
        frm = ""
        if callers:
            c, cn = callers.most_common(1)[0]
            if c != f and cn * 2 >= len(ss):
                frm = c
        out.append(f"  {f[:40]:40s} {len(ss):7d} {100 * len(ss) / n:6.2f}  "
                   f"{w[:18]:18s} {100 * wn / len(ss):3.0f}%  {frm[:28]}")
    return out


def _marks(an) -> list[tuple[str, int, int, int]]:
    """Jobs between marks: (name, thread, start, stop), stops with value 0 left out."""
    out = []
    open_: dict[tuple[int, int], int] = {}
    cur = None
    recs = an.d.records[an.boot_from:] if an.boot_from else an.d.records
    for r in recs:
        if r.id == P.EV_SWITCH_IN and r.w:
            cur = r.w[0]
        elif r.id == P.EV_MARK_START and r.w and cur is not None:
            open_[(cur, r.w[0])] = r.t
        elif r.id == P.EV_MARK_STOP and r.w and cur is not None:
            t0 = open_.pop((cur, r.w[0]), None)
            if t0 is not None and (r.w[1] if len(r.w) > 1 else 1):
                out.append((_strname(an, r.w[0]), cur, t0, r.t))
        elif r.id in (P.EV_OVERFLOW,):
            open_.clear()
    return out


def _inside(spans: list[Span], th: int, t0: int, t1: int) -> list[Span]:
    return [s for s in spans if s.thread == th and s.t0 >= t0 and s.t1 <= t1]


def frame_jobs(an, spans: list[Span], mark: str = "frame", with_span: str | None = None) -> list[tuple]:
    """A mark's jobs (name, thread, start, stop); with `with_span`, only those holding a
    span of that name (the demo's switch span: a screen's first frame)."""
    jobs = [j for j in _marks(an) if j[0] == mark]
    if with_span:
        hits = [s for s in spans if s.name == with_span]
        jobs = [j for j in jobs if any(s.thread == j[1] and s.t0 >= j[2] and s.t1 <= j[3] for s in hits)]
    return jobs


def profile_lines(an, spans: list[Span], samples: list[Sample], jobs: list[tuple], label: str,
                  rows: int = 25) -> list[str]:
    """What the selected frames are made of, per frame on average: the spans inside
    them by name (self time adds up without counting a span twice), and the
    functions sampled in them."""
    k = len(jobs)
    if not k:
        return []
    mean = sum(j[3] - j[2] for j in jobs) / k
    worst = max(j[3] - j[2] for j in jobs)
    out = ["", f"{label}: {k} frames, {_ms(an, mean):.2f} ms mean, {_ms(an, worst):.2f} ms the longest; "
               "per frame on average:"]
    agg: dict[str, list[float]] = defaultdict(lambda: [0, 0, 0])
    for _, th, t0, t1 in jobs:
        for s in _inside(spans, th, t0, t1):
            a = agg[s.name]
            a[0] += 1
            a[1] += s.t1 - s.t0
            a[2] += s.t1 - s.t0 - s.child
    if agg:
        out.append(f"  {'span':40s} {'count':>6s} {'total us':>9s} {'self us':>8s}")
        for name, (n, wall, self_) in sorted(agg.items(), key=lambda kv: -kv[1][2])[:rows]:
            out.append(f"  {name[:40]:40s} {n / k:6.1f} {_us(an, wall / k):9.0f} {_us(an, self_ / k):8.0f}")
    inside = [s for s in samples if not _idle(an, s) and any(t0 <= s.t <= t1 for _, _, t0, t1 in jobs)]
    if inside:
        out.append(f"  sampled in them ({len(inside)} samples):")
        for f, c in Counter(func(an, s.pc) for s in inside).most_common(rows):
            out.append(f"  {f[:40]:40s} {100 * c / len(inside):6.1f} %")
    return out


def frame_lines(an, spans: list[Span], samples: list[Sample], n: int = 3, mark: str = "frame",
                shortest_us: float = 100.0, max_lines: int = 40, with_span: str | None = None) -> list[str]:
    """The n longest jobs of a mark (the demo's frames) with the spans wholly inside
    them, as a tree, and the functions sampled in them. A mark set inside a span (the
    demo's frame ends in LVGL's flush) leaves the spans around it out."""
    jobs = frame_jobs(an, spans, mark, with_span)
    if not jobs or not (spans or samples) or n <= 0:
        return []
    jobs.sort(key=lambda j: -(j[3] - j[2]))
    which = f"'{mark}' jobs" + (f" holding a '{with_span}' span" if with_span else "")
    out = ["", f"the {min(n, len(jobs))} longest of {len(jobs):,} {which}, with their spans "
               f"(at least {shortest_us:g} us) and samples"]
    for name, th, t0, t1 in jobs[:n]:
        out.append(f"  {_ms(an, t1 - t0):6.2f} ms at {an.seconds(t0):.3f} s ({an.thread_name(th)})")
        shown = [s for s in spans if s.thread == th and s.t0 >= t0 and s.t1 <= t1
                 and _us(an, s.t1 - s.t0) >= shortest_us]
        top = min((s.depth for s in shown), default=0)
        for s in shown[:max_lines]:
            out.append(f"    {'  ' * min(s.depth - top, 12)}{s.name[:44]:44s} {_us(an, s.t1 - s.t0):7.0f} us"
                       f"  self {_us(an, s.t1 - s.t0 - s.child):6.0f}")
        if len(shown) > max_lines:
            out.append(f"    ({len(shown) - max_lines} more spans)")
        inside = [s for s in samples if t0 <= s.t <= t1 and not _idle(an, s)]
        if inside:
            top = Counter(func(an, s.pc) for s in inside).most_common(6)
            out.append("    sampled: " + ", ".join(f"{f} {c}" for f, c in top) + f"  (of {len(inside)})")
    return out


def report(an) -> list[str]:
    """The summary's sections; nothing if the recording has neither spans nor samples.
    Options from `an.prof_opts` (summary's --frames, --frames-with, --frame-us)."""
    h = an.d.hello
    opts = getattr(an, "prof_opts", {}) or {}
    spans, samples = decode(an)
    out: list[str] = []
    if spans or h.spans[0]:
        out += span_lines(an, spans)
    if samples or h.sample[0]:
        out += sample_lines(an, samples)
    with_span = opts.get("frames_with")
    if with_span:
        out += profile_lines(an, spans, samples, frame_jobs(an, spans, "frame", with_span),
                             f"frames holding a '{with_span}' span")
    out += frame_lines(an, spans, samples, n=opts.get("frames", 3), shortest_us=opts.get("frame_us", 100.0),
                       with_span=with_span)
    return out
