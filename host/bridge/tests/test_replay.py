# SPDX-License-Identifier: Apache-2.0
"""Replay equals live: the same bytes in any pieces give the same statistics windows,
the same totals, and the batch analysis agrees."""
from __future__ import annotations

import json

from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis
from zprof_bridge.live import LiveSession
from zprof_bridge.stream import Decoder

from test_stream import A, B, HZ, SENDER, Enc


def stream() -> bytes:
    e = Enc()
    e.hello()
    us = HZ // 1_000_000
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, P.THS_PENDING, SENDER, 0x34020000)
    t = 0
    for k in range(3000):                       # 3 s of a thread released every ms, interrupts between
        tr += r(t, P.EV_ISR_ENTER, 33) + r(t + 5 * us, P.EV_READY, 0, A) + r(t + 8 * us, P.EV_ISR_EXIT, 33)
        tr += r(t + 9 * us, P.EV_SWITCH_IN, 0, A)
        tr += r(t + (200 + k % 50) * us, P.EV_SWITCH_OUT, P.THS_PENDING, A, 0x34010000)
        tr += r(t + 300 * us, P.EV_READY, 0, B) + r(t + 300 * us, P.EV_SWITCH_IN, 5, B)
        tr += r(t + 450 * us, P.EV_SWITCH_OUT, P.THS_SLEEPING, B, 0)
        if k % 250 == 0:
            tr += Enc.sync(t + 460 * us, (t + 460 * us) * 1000 // HZ)
        t += 1000 * us
    e.frame(P.CH_TRACE, tr)        # frames hold whole records (the pieces below cut anywhere)
    return bytes(e.out)


def live(data: bytes, piece: int) -> tuple[list[dict], dict]:
    s = LiveSession(target="t")
    stats = []
    for i in range(0, len(data), piece):
        s.feed(data[i:i + piece])
        stats += s.new_stats
        s.new_stats.clear()
    s.tr.finish()
    return stats, {p: (u.run, u.isr_in, u.switches_in) for p, u in s.tr.threads.items()}


def test_any_pieces_give_the_same_answers() -> None:
    data = stream()
    ref_stats, ref_tot = live(data, len(data))
    assert len(ref_stats) == 2                       # whole seconds of target time
    for piece in (1, 7, 997, 65536):
        stats, tot = live(data, piece)
        assert json.dumps(stats, sort_keys=True) == json.dumps(ref_stats, sort_keys=True), piece
        assert tot == ref_tot
    d = Decoder()
    d.feed(data)
    an = Analysis(d)
    assert {p: (u.run, u.isr_in, u.switches_in) for p, u in an.threads.items()} == ref_tot
