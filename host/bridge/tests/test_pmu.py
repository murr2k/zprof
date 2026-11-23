# SPDX-License-Identifier: Apache-2.0
"""PMU records: counts to the thread that switched out, wraps, a restart, figures."""
from __future__ import annotations

import struct

import pytest

from zprof_bridge import pmu
from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis, report
from zprof_bridge.stream import Decoder

from test_stream import A, B, HZ, SENDER, Enc

CACHE = pmu.PRESETS["cache"]   # instructions, I refills, D refills, back-end stall cycles


def hello(e: Enc, flags: int = P.PMU_F_SWITCH) -> None:
    p = Enc.tlv(P.HT_CLOCKS, struct.pack("<III", HZ, HZ, P.TS_SRC_DWT))
    p += Enc.tlv(P.HT_SENDER, struct.pack("<I", SENDER))
    p += Enc.tlv(P.HT_PMU, struct.pack("<HHHHII", *CACHE, flags, 0xCC))
    for ptr, prio, name in ((A, 0, b"main"), (B, 5, b"worker"), (SENDER, 14, b"zprof_sender")):
        p += Enc.tlv(P.HT_THREAD, struct.pack("<IiIII", ptr, prio, 0, 0, 0) + name)
    p += Enc.tlv(P.HT_END, b"")
    e.frame(P.CH_CONTROL, p)


def pmu_rec(ts: int, kind: int, *counts: int) -> bytes:
    return Enc.rec(ts, P.EV_PMU, kind, *[c & 0xFFFFFFFF for c in counts])


def decode(e: Enc) -> Analysis:
    d = Decoder()
    d.feed(bytes(e.out))
    return Analysis(d)


def test_counts_go_to_the_thread_that_switched_out() -> None:
    e = Enc()
    hello(e)
    ms = HZ // 1000
    r = Enc.rec
    base = 2**32 - 500                              # the instruction count wraps inside A's run
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, 0, SENDER, 0) + pmu_rec(0, P.PMU_SWITCH, base, 0, 0, 0)
    tr += r(0, P.EV_SWITCH_IN, 0, A)
    tr += r(4 * ms, P.EV_SWITCH_OUT, 0, A, 0) + pmu_rec(4 * ms, P.PMU_SWITCH, base + 4_000_000, 100, 20, 800_000)
    tr += r(4 * ms, P.EV_SWITCH_IN, 5, B)
    tr += r(6 * ms, P.EV_SWITCH_OUT, 0, B, 0) + pmu_rec(6 * ms, P.PMU_SWITCH, base + 4_400_000, 900, 20, 1_600_000)
    tr += r(6 * ms, P.EV_SWITCH_IN, 14, SENDER)
    e.frame(P.CH_TRACE, tr)
    an = decode(e)
    a, b = an.threads[A], an.threads[B]
    assert a.pmu == [4_000_000, 100, 20, 800_000]
    assert b.pmu == [400_000, 800, 0, 800_000]
    assert an.tracker.pmu_per_thread
    fa = pmu.figures(CACHE, a.pmu, a.run)           # A ran 4 ms = 3.2 M cycles
    assert fa["ipc"] == pytest.approx(4_000_000 / (4 * ms))
    assert fa["backend_stall_cycles_pct"] == pytest.approx(25.0)
    assert fa["icache_refills_pki"] == pytest.approx(0.025)
    fb = pmu.figures(CACHE, b.pmu, b.run)
    assert fb["backend_stall_cycles_pct"] == pytest.approx(50.0)
    assert "PMU      instructions, icache_refills" in report(an)


def test_a_restart_is_a_new_baseline_and_totals_only_without_switch_records() -> None:
    e = Enc()
    hello(e, flags=0)
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_IN, 0, A)
    tr += pmu_rec(10, P.PMU_BEAT, 1000, 0, 0, 0)
    tr += pmu_rec(20, P.PMU_BEAT, 3000, 0, 0, 0)     # +2000
    tr += pmu_rec(30, P.PMU_BASE, 0, 0, 0, 0)        # the host changed the events: no difference
    tr += pmu_rec(40, P.PMU_BEAT, 500, 0, 0, 0)      # +500
    e.frame(P.CH_TRACE, tr)
    an = decode(e)
    assert an.tracker.pmu_total[0] == 2500
    assert not an.tracker.pmu_per_thread and an.threads[A].pmu == [0, 0, 0, 0]
    assert "totals only" in report(an)


def test_the_control_frame() -> None:
    f = pmu.frame(pmu.PRESETS["helium"], True)
    ch, _, _, n = struct.unpack_from("<BBHI", f)
    tag, ln, *ev, flags = struct.unpack_from("<HHHHHHI", f, 8)
    assert ch == P.CH_CONTROL and tag == P.CT_PMU and ln == 12 and n == 16
    assert tuple(ev) == (0x0008, 0x0200, 0x02CC, 0x0024) and flags == P.PMU_F_SWITCH
    keep = pmu.frame(None, False)
    assert struct.unpack_from("<HHHHI", keep, 12) == (0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0)


def test_heartbeat_counts_become_timing_series() -> None:
    from zprof_bridge.timing import TimingTracker
    e = Enc()
    hello(e, flags=0)
    tr = Enc.sync(0) + pmu_rec(10, P.PMU_BEAT, 100, 0, 0, 0)
    tr += pmu_rec(20, P.PMU_SWITCH, 400, 1, 2, 3) + pmu_rec(30, P.PMU_BEAT, 1100, 5, 6, 7)
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    tt = TimingTracker(d.hello, d.threads, lambda a: None, lambda p: "?")
    tt.feed(d.records)
    s = tt.metrics["pmu.instructions"]
    assert [v for _, v in s.pts] == [1000.0]          # the switch record's share is in the beat's
    assert tt.metric_info["pmu.backend_stall_cycles"]["unit"] == "cycles"
