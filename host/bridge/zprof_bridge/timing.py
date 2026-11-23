# SPDX-License-Identifier: Apache-2.0
"""What the application tells the trace (zprof.h) and the heartbeat: metrics,
plots, prints, stack watermarks and marked spans, kept for the Timing view and
handed out as new data since the last look.

Times are ms of the target's clock since boot, like the timeline's.
"""
from __future__ import annotations

import re
from collections import deque

from . import proto as P
from .stream import EV_SESSION

KIND_NAMES = {P.KIND_COUNTER: "counter", P.KIND_GAUGE: "gauge", P.KIND_TIMER: "timer"}
_FMT = re.compile(r"%([-+ #0]*)(\d+)?(?:\.(\d+))?(hh|h|ll|l|z|j|t)?([diouxXc%])")


def cformat(fmt: str, args: tuple[int, ...]) -> str:
    """A C format with 32-bit integer arguments (zprof_print: no %s, no floats)."""
    it = iter(args)

    def one(m: re.Match) -> str:
        flags, width, prec, _len, conv = m.groups()
        if conv == "%":
            return "%"
        v = next(it, 0) & 0xFFFFFFFF
        if conv in "di":
            v = v - (1 << 32) if v & 0x80000000 else v
        if conv == "c":
            return chr(v & 0xFF)
        spec = f"%{flags or ''}{width or ''}{('.' + prec) if prec else ''}{'d' if conv in 'iu' else conv}"
        try:
            return spec % v
        except (TypeError, ValueError):
            return str(v)
    try:
        return _FMT.sub(one, fmt)
    except re.error:
        return fmt


class Series:
    """One series of (t ms, value), the last `keep` points, and the ones not yet handed out."""

    def __init__(self, keep: int):
        self.pts: deque[tuple[float, float]] = deque(maxlen=keep)
        self.new: list[tuple[float, float]] = []

    def add(self, t: float, v: float) -> None:
        self.pts.append((t, v))
        self.new.append((t, v))
        if len(self.new) > self.pts.maxlen:
            del self.new[: len(self.new) - self.pts.maxlen]


class TimingTracker:
    def __init__(self, hello, threads: dict, string_of, thread_name, keep: int = 1200):
        self.hello = hello
        self.threads = threads
        self.string_of = string_of            # rodata address -> text (the ELF)
        self.thread_name = thread_name
        self.keep = keep
        self.metrics: dict[str, Series] = {}
        self.metric_info: dict[str, dict] = {}
        self.plots: dict[str, Series] = {}
        self.spans: dict[str, Series] = {}    # marked jobs: (start ms, duration us); value 0 kept out
        self.span_info: dict[str, dict] = {}
        self.prints: deque = deque(maxlen=500)
        self.new_prints: list = []
        self.stacks: dict[str, dict] = {}
        self._names: dict[int, str] = {}
        self._open: dict[tuple[int, str], int] = {}
        self.cur: int | None = None
        self._isr = 0

    def _ms(self, t: int) -> float:
        return t * 1000.0 / (self.hello.ts_hz or 1)

    def _str(self, a: int) -> str:
        s = self._names.get(a)
        if s is None:
            s = self._names[a] = self.string_of(a) or f"{a:#010x}"
        return s

    def feed(self, recs) -> None:
        us = 1e6 / (self.hello.ts_hz or 1)
        for r in recs:
            rid = r.id
            if rid == P.EV_SWITCH_IN:
                self.cur = r.w[0]
            elif rid == P.EV_ISR_ENTER:
                self._isr += 1
            elif rid == P.EV_ISR_EXIT:
                self._isr = max(0, self._isr - 1)
            elif rid == P.EV_METRIC:
                info = self.hello.metrics.get(r.arg)
                if info is None:
                    continue
                name, kind, unit = info
                v = float(r.w[0])
                if kind == P.KIND_GAUGE and r.w[0] & 0x80000000:
                    v -= 4294967296.0                 # gauges are signed (a margin, a temperature)
                if kind == P.KIND_TIMER:
                    v, unit = v * us, "us"
                s = self.metrics.get(name)
                if s is None:
                    s = self.metrics[name] = Series(self.keep)
                    self.metric_info[name] = {"kind": KIND_NAMES.get(kind, "?"), "unit": unit}
                s.add(self._ms(r.t), v)
            elif rid == P.EV_PLOT:
                name = self._str(r.w[0])
                v = r.w[1] - (1 << 32) if r.w[1] & 0x80000000 else r.w[1]
                s = self.plots.get(name)
                if s is None:
                    s = self.plots[name] = Series(self.keep * 4)
                s.add(self._ms(r.t), float(v))
            elif rid in (P.EV_PRINT, P.EV_TRIGGER):
                text = (cformat(self._str(r.w[0]), tuple(r.w[1:4])) if rid == P.EV_PRINT
                        else f"TRIGGER {r.w[0] if r.w else 0}")
                who = "ISR" if self._isr else (self.thread_name(self.cur) if self.cur is not None else "?")
                item = (self._ms(r.t), who, text)
                self.prints.append(item)
                self.new_prints.append(item)
                if len(self.new_prints) > self.prints.maxlen:
                    del self.new_prints[: len(self.new_prints) - self.prints.maxlen]
            elif rid == P.EV_STACK:
                name = self.thread_name(r.w[0])
                unused, size = r.w[1], r.w[2]
                self.stacks[name] = {"used": size - unused, "size": size, "t_ms": self._ms(r.t)}
            elif rid in (P.EV_MARK_START, P.EV_MARK_STOP):
                if self._isr or self.cur is None:
                    continue
                key = (self.cur, self._str(r.w[0]))
                if rid == P.EV_MARK_START:
                    self._open[key] = r.t
                else:
                    t0 = self._open.pop(key, None)
                    if t0 is not None and (r.w[1] if len(r.w) > 1 else 1):
                        name = key[1]
                        s = self.spans.get(name)
                        if s is None:
                            s = self.spans[name] = Series(self.keep * 4)
                            self.span_info[name] = {"thread": self.thread_name(key[0])}
                        s.add(self._ms(t0), (r.t - t0) * us)
            elif rid == P.EV_OVERFLOW or rid == EV_SESSION:
                self._open.clear()        # a gap: no span bridges it
                self._isr = 0
                if rid == EV_SESSION:
                    self.cur = self.hello.sender or None

    @staticmethod
    def _pack(d: dict[str, Series], info: dict, new: bool) -> dict:
        out = {}
        for name, s in d.items():
            # a full snapshot leaves out the points the next incremental message
            # carries (the tail of pts), or a page would get them twice
            pts = s.new if new else list(s.pts)[: len(s.pts) - len(s.new)]
            if pts or not new:
                out[name] = {**info.get(name, {}), "t": [p[0] for p in pts], "v": [p[1] for p in pts]}
            if new:
                s.new = []
        return out

    def message(self, full: bool = False) -> dict | None:
        """The data since the last incremental call, or (full) everything kept, which
        a page that has just connected gets without taking the others' new data;
        None when nothing is new."""
        out = {
            "type": "timing", "full": full,
            "metrics": self._pack(self.metrics, self.metric_info, not full),
            "plots": self._pack(self.plots, {}, not full),
            "spans": self._pack(self.spans, self.span_info, not full),
            "prints": [list(p) for p in (list(self.prints)[: len(self.prints) - len(self.new_prints)]
                                         if full else self.new_prints)],
            "stacks": self.stacks,
        }
        if not full:
            self.new_prints = []
            if not (out["metrics"] or out["plots"] or out["spans"] or out["prints"]):
                return None
        return out
