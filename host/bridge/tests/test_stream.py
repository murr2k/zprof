# SPDX-License-Identifier: Apache-2.0
"""The bridge's decoder and analysis on synthetic streams from a Python encoder
of the same format (docs/PROTOCOL.md)."""
from __future__ import annotations

import struct

import pytest

from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis
from zprof_bridge.stream import EV_SESSION, Decoder, StreamError


def target_records(d: Decoder):
    """The records from the target (without the decoder's session markers)."""
    return [r for r in d.records if r.id != EV_SESSION]

HZ = 800_000_000
A, B, SENDER, IDLE = 0x34001000, 0x34002000, 0x34003000, 0x34004000


class Enc:
    def __init__(self) -> None:
        self.seq = {}
        self.out = bytearray(b"ZPRF" + struct.pack("<HH", P.PROTO_VERSION, 0))

    def frame(self, ch: int, payload: bytes) -> None:
        s = self.seq.get(ch, 0)
        self.seq[ch] = s + 1
        self.out += struct.pack("<BBHI", ch, 0, s & 0xFFFF, len(payload)) + payload

    @staticmethod
    def tlv(tag: int, v: bytes) -> bytes:
        return struct.pack("<HH", tag, len(v)) + v

    def hello(self) -> None:
        p = self.tlv(P.HT_KERNEL, b"4.4.0")
        p += self.tlv(P.HT_CLOCKS, struct.pack("<III", HZ, HZ, P.TS_SRC_DWT))
        p += self.tlv(P.HT_SENDER, struct.pack("<I", SENDER))
        for ptr, prio, name in ((A, 0, b"main"), (B, 5, b"worker"), (SENDER, 14, b"zprof_sender"),
                                (IDLE, 15, b"idle")):
            p += self.tlv(P.HT_THREAD, struct.pack("<IiIII", ptr, prio, 0, 0, 0) + name)
        p += self.tlv(P.HT_END, b"")
        self.frame(P.CH_CONTROL, p)

    @staticmethod
    def rec(ts: int, rid: int, arg: int = 0, *w: int) -> bytes:
        return struct.pack(f"<II{len(w)}I", ts & 0xFFFFFFFF, rid | (len(w) << 8) | (arg << 16), *w)

    @staticmethod
    def sync(ts: int, kc: int | None = None) -> bytes:
        """A SYNC: the kernel's 64-bit count at this stamp (default: equal, so times stay as written)."""
        kc = ts if kc is None else kc
        return Enc.rec(ts, P.EV_SYNC, 0, kc & 0xFFFFFFFF, kc >> 32, 0)


def run(e: Enc) -> Analysis:
    d = Decoder()
    data = bytes(e.out)
    for i in range(0, len(data), 7):  # arbitrary chunking, as TCP may deliver it
        d.feed(data[i:i + 7])
    return Analysis(d)


def test_ids_come_from_the_firmware_header() -> None:
    assert P.EV_SWITCH_IN == 0x01 and P.EV_OVERFLOW == 0x7F and P.FRAME_HDR == 8


def test_cpu_split_and_isr_and_latency() -> None:
    e = Enc()
    e.hello()
    ms = HZ // 1000
    r = Enc.rec
    t = 0
    tr = Enc.sync(0)
    tr += r(t, P.EV_SWITCH_OUT, 0, SENDER, 0)
    tr += r(t, P.EV_SWITCH_IN, 0, A)                      # A runs 6 ms with a 1 ms interrupt
    tr += r(t + 2 * ms, P.EV_ISR_ENTER, 33)
    tr += r(t + 2 * ms, P.EV_READY, 0, B)
    tr += r(t + 3 * ms, P.EV_ISR_EXIT, 33)
    tr += r(t + 6 * ms, P.EV_SWITCH_OUT, 0, A, 0)
    tr += r(t + 6 * ms, P.EV_SWITCH_IN, 5, B)             # B: ready at 2 ms, runs at 6 ms
    tr += r(t + 10 * ms, P.EV_SWITCH_OUT, 0, B, 0)
    tr += r(t + 10 * ms, P.EV_SWITCH_IN, 15, IDLE)
    tr += r(t + 20 * ms, P.EV_SWITCH_OUT, 0, IDLE, 0)
    tr += r(t + 20 * ms, P.EV_SWITCH_IN, 14, SENDER)
    e.frame(P.CH_TRACE, tr)
    an = run(e)
    a, b = an.threads[A], an.threads[B]
    assert sum(t1 - t0 for t0, t1 in a.intervals) == 6 * ms
    assert a.isr_in == 1 * ms
    assert an.irqs[33].count == 1 and an.irqs[33].total == 1 * ms
    assert b.wake_lat == [4 * ms]
    assert an.thread_name(B) == "worker"


def test_timestamps_unwrap_across_the_32_bit_wrap() -> None:
    e = Enc()
    e.hello()
    near = 2**32 - 100
    e.frame(P.CH_TRACE, Enc.sync(near) + Enc.rec(near, P.EV_IDLE) + Enc.rec(near + 300, P.EV_IDLE_EXIT))
    an = run(e)
    rs = target_records(an.d)
    assert rs[2].t - rs[1].t == 300
    assert an.wfi == 300


def test_overflow_reanchors_after_a_long_gap() -> None:
    e = Enc()
    e.hello()
    kc0 = 10**12
    gap = 3 * 2**32 + 1000                          # three wraps and a bit: plain unwrap would miss
    tr = Enc.rec(5000, P.EV_SYNC, 0, kc0 & 0xFFFFFFFF, kc0 >> 32, 0)
    kc1 = kc0 + gap
    tr += Enc.rec(5000 + gap, P.EV_OVERFLOW, 0, 7, kc1 & 0xFFFFFFFF, kc1 >> 32, A)
    e.frame(P.CH_TRACE, tr)
    an = run(e)
    rs = target_records(an.d)
    assert rs[1].t - rs[0].t == gap
    assert an.dropped == 7


def test_check_against_the_kernels_counts() -> None:
    e = Enc()
    e.hello()
    s = HZ  # one second
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_THREAD_STATS, 0, A, 0, 0) + r(0, P.EV_SWITCH_OUT, 0, SENDER, 0)
    tr += r(0, P.EV_SWITCH_IN, 0, A) + r(s // 4, P.EV_SWITCH_OUT, 0, A, 0)   # A: 25 % of the second
    tr += r(s // 4, P.EV_SWITCH_IN, 14, SENDER)
    tr += r(s, P.EV_THREAD_STATS, 0, A, s // 4, 0)
    e.frame(P.CH_TRACE, tr)
    chk = run(e).check_against_kernel()
    (ptr, trace, kernel), = chk
    assert ptr == A and trace == pytest.approx(25.0) and kernel == pytest.approx(25.0)


def test_a_frame_gap_is_counted() -> None:
    e = Enc()
    e.hello()
    e.frame(P.CH_TRACE, Enc.sync(0) + Enc.rec(1, P.EV_IDLE))
    e.seq[P.CH_TRACE] += 1                          # a frame lost
    e.frame(P.CH_TRACE, Enc.rec(2, P.EV_IDLE_EXIT))
    assert run(e).d.seq_gaps == 1


def test_not_a_zprof_stream() -> None:
    with pytest.raises(StreamError):
        Decoder().feed(b"HTTP/1.1 200 OK\r\n")


def test_records_wait_for_the_first_sync_and_take_target_time() -> None:
    e = Enc()
    e.hello()
    # the session's own stamps start at 5000; the target has been up 3 s (kernel cycles)
    up = 3 * HZ
    e.frame(P.CH_TRACE, Enc.rec(4000, P.EV_IDLE) + Enc.sync(5000, up) + Enc.rec(6000, P.EV_IDLE_EXIT))
    d = Decoder()
    d.feed(bytes(e.out))
    assert [r.t for r in target_records(d)] == [up - 1000, up, up + 1000]   # held, then anchored
    assert d.records[0].id == EV_SESSION                                    # the session marker first


def test_a_reconnect_continues_the_timeline_and_a_reboot_is_seen() -> None:
    kinds = []
    d = Decoder()
    d.on_session = kinds.append
    first = Enc()
    first.hello()
    first.frame(P.CH_TRACE, Enc.sync(100, 10 * HZ) + Enc.rec(200, P.EV_IDLE))
    d.feed(bytes(first.out) + b"\x02\x00\x07")      # a half frame when the link broke
    d.restart()
    again = Enc()                                   # new session: its stamps are unrelated
    again.hello()
    again.frame(P.CH_TRACE, Enc.sync(9, 12 * HZ) + Enc.rec(19, P.EV_IDLE_EXIT))
    d.feed(bytes(again.out))
    assert kinds == ["first", "reconnect"] and d.sessions == 2
    assert d.records[-1].t == 12 * HZ + 10           # on the target's clock, after the first session
    # a thread running when the link broke is not credited with the gap
    e2 = Enc()
    e2.hello()
    tr = Enc.sync(0, 0) + Enc.rec(0, P.EV_SWITCH_OUT, 0, SENDER, 0) + Enc.rec(0, P.EV_SWITCH_IN, 0, A)
    e2.frame(P.CH_TRACE, tr)
    d2 = Decoder()
    d2.feed(bytes(e2.out))
    d2.restart()
    e3 = Enc()
    e3.hello()
    e3.frame(P.CH_TRACE, Enc.sync(0, 5 * HZ) + Enc.rec(HZ // 1000, P.EV_SWITCH_OUT, 0, A, 0))
    d2.feed(bytes(e3.out))
    an = Analysis(d2)
    assert A in an.threads and an.threads[A].intervals == []   # its run across the 5 s gap is not counted
    rebooted = Enc()                                 # in-band, no restart(): a preamble at a frame boundary
    rebooted.hello()
    rebooted.frame(P.CH_TRACE, Enc.sync(50, 1 * HZ))
    d.feed(bytes(rebooted.out))
    assert kinds[-1] == "reboot" and d.reboots == 1
