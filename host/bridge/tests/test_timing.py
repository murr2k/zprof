# SPDX-License-Identifier: Apache-2.0
"""Metrics (with their dictionary), plots, prints, stack watermarks, marked spans and
the capture status, as the Timing view gets them."""
from __future__ import annotations

import struct

from zprof_bridge import proto as P
from zprof_bridge.live import LiveSession
from zprof_bridge.timing import cformat

from test_stream import A, HZ, SENDER, Enc

FMT, MARGIN, FRAME = 0x70001000, 0x70001040, 0x70001080
STRINGS = {FMT: "seek to %u ms, err %d", MARGIN: "frame.margin_us", FRAME: "frame"}


class FakeElf:
    def string(self, a):
        return STRINGS.get(a)

    def name(self, a, exact_only=False):
        return None

    def call_sites(self, pcs):
        return {}

    path = type("p", (), {"name": "fake.elf"})()

    def check_build_id(self, b):
        return None


def test_c_formats() -> None:
    assert cformat("%u ms, %d, %04x, %%, %c", (5, 0xFFFFFFFF, 0xAB, ord("z"))) == "5 ms, -1, 00ab, %, z"
    assert cformat("%5lu|%-3d|", (42, 7)) == "   42|7  |"


def test_metrics_plots_prints_spans_and_capture() -> None:
    e = Enc()
    e.hello()
    dict_ = b"".join(struct.pack("<HHHBB", P.HT_METRIC, 4 + len(n) + 1 + len(u), i, k, 0) + n + b"\0" + u
                     for i, (n, k, u) in enumerate([(b"gfx.frames", P.KIND_GAUGE, b"frames"),
                                                   (b"busy", P.KIND_TIMER, b"")]))
    e.frame(P.CH_CONTROL, dict_)
    us = HZ // 1_000_000
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, 0, SENDER, 0) + r(0, P.EV_SWITCH_IN, 0, A)
    for k in range(20):
        t = k * 16_667 * us
        tr += r(t, P.EV_MARK_START, 0, FRAME, 0)
        tr += r(t + 6000 * us, P.EV_PLOT, 0, MARGIN, (10_000 - k) & 0xFFFFFFFF)
        tr += r(t + 6000 * us, P.EV_MARK_STOP, 0, FRAME, 1 if k % 4 else 0)   # every 4th: an idle slot
        if k % 6 == 0:
            tr += r(t + 7000 * us, P.EV_METRIC, 0, 100 + k) + r(t + 7000 * us, P.EV_METRIC, 1, 800 * us)
    tr += r(400_000 * us, P.EV_PRINT, 0, FMT, 1234, 0xFFFFFFFE, 0)
    tr += r(400_000 * us, P.EV_STACK, 0, A, 1000, 4096)
    e.frame(P.CH_TRACE, tr)
    e.frame(P.CH_CONTROL, struct.pack("<HHIIII", P.HT_CAPTURE, 16, P.CAP_RECORDING, 65536, 4 << 20, 2500))

    s = LiveSession(FakeElf(), target="t")
    s.feed(bytes(e.out))
    # nothing handed out yet: a page connecting now gets the points with the next update
    early = s.tt.message(full=True)
    assert early["plots"]["frame.margin_us"]["v"] == [] and early["prints"] == []
    m = s.tt.message()
    assert m["metrics"]["gfx.frames"]["v"] == [100, 106, 112, 118] and m["metrics"]["gfx.frames"]["unit"] == "frames"
    assert m["metrics"]["busy"]["v"][0] == 800 and m["metrics"]["busy"]["unit"] == "us"   # ticks to us
    assert m["plots"]["frame.margin_us"]["v"][:2] == [10_000, 9_999]
    sp = m["spans"]["frame"]
    assert len(sp["v"]) == 15 and all(abs(v - 6000) < 1e-6 for v in sp["v"])          # idle slots left out
    assert m["prints"][0][2] == "seek to 1234 ms, err -2" and m["prints"][0][1] == "main"
    assert m["stacks"]["main"] == {"used": 3096, "size": 4096, "t_ms": 400.0}
    st = [x for x in map(__import__("json").loads, [u for u in s.updates() if isinstance(u, str)]) if x["type"] == "status"]
    assert st[-1]["capture"] == {"state": P.CAP_RECORDING, "bytes": 65536, "capacity": 4 << 20, "ms": 2500}
    assert s.tt.message() is None
    # after that, a full message has everything, and neither takes nor repeats what comes next
    full = s.tt.message(full=True)
    assert len(full["plots"]["frame.margin_us"]["v"]) == 20 and len(full["prints"]) == 1
    def more(payload: bytes) -> None:          # the same connection, its next frame
        at = len(e.out)
        e.frame(P.CH_TRACE, payload)
        s.feed(bytes(e.out[at:]))
    more(r(500_000 * us, P.EV_PLOT, 0, MARGIN, 42))
    assert len(s.tt.message(full=True)["plots"]["frame.margin_us"]["v"]) == 20
    assert s.tt.message()["plots"]["frame.margin_us"]["v"] == [42]
    more(r(600_000 * us, P.EV_METRIC, 0, 0xFFFFFFF6))     # gauges are signed
    assert s.tt.message()["metrics"]["gfx.frames"]["v"] == [-10]
