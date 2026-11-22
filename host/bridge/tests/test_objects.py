# SPDX-License-Identifier: Apache-2.0
"""Kernel-object records: counts, blocked waits, errors, timer runs, and the wait
handed to the live timeline."""
from __future__ import annotations

from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis, ISR_CTX, Tracker
from zprof_bridge.stream import Decoder

from test_stream import A, B, HZ, SENDER, Enc

SEM, MTX, TMR = 0x34010000, 0x34010100, 0x34010200
US = HZ // 1_000_000


def arg(call: int, phase: int) -> int:
    return (call << 4) | phase


def stream() -> Decoder:
    e = Enc()
    e.hello()
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, 0, SENDER, 0) + r(0, P.EV_SWITCH_IN, 0, A)
    # A takes the semaphore, blocks (no ENTER: the target writes none for calls
    # that may block); B gives it 40 us later (A woke after 50 us)
    tr += r(12 * US, P.EV_SEM, arg(P.CALL_TAKE, P.PH_BLOCK), SEM, 0xFFFFFFFF)
    tr += r(12 * US, P.EV_SWITCH_OUT, 0, A, SEM) + r(12 * US, P.EV_SWITCH_IN, 5, B)
    tr += r(52 * US, P.EV_SEM, arg(P.CALL_GIVE, P.PH_EXIT), SEM, 1)
    tr += r(55 * US, P.EV_SWITCH_OUT, 0, B, 0) + r(55 * US, P.EV_SWITCH_IN, 0, A)
    tr += r(62 * US, P.EV_SEM, arg(P.CALL_TAKE, P.PH_EXIT), SEM, 0)
    # a take that does not block: one EXIT record
    tr += r(65 * US, P.EV_SEM, arg(P.CALL_TAKE, P.PH_EXIT), SEM, 0)
    # A locks a mutex that times out: -EAGAIN (an older recording's ENTER is tolerated)
    tr += r(70 * US, P.EV_MUTEX, arg(P.CALL_LOCK, P.PH_ENTER), MTX, 100)
    tr += r(71 * US, P.EV_MUTEX, arg(P.CALL_LOCK, P.PH_BLOCK), MTX, B)
    tr += r(171 * US, P.EV_MUTEX, arg(P.CALL_LOCK, P.PH_EXIT), MTX, (-11) & 0xFFFFFFFF)
    # a timer expires in the tick interrupt: its function runs 3 us
    tr += r(200 * US, P.EV_ISR_ENTER, 0x8000 | 15)
    tr += r(201 * US, P.EV_TIMER, arg(P.CALL_EXPIRY, P.PH_ENTER), TMR, 0)
    tr += r(204 * US, P.EV_TIMER, arg(P.CALL_EXPIRY, P.PH_EXIT), TMR, 0)
    tr += r(205 * US, P.EV_ISR_EXIT, 0x8000 | 15)
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    return d


def test_counts_waits_errors_and_timer_runs() -> None:
    an = Analysis(stream())
    sem = an.objects[(P.EV_SEM, SEM)]
    assert sem.calls[P.CALL_TAKE] == 2 and sem.calls[P.CALL_GIVE] == 1   # counted at the exits
    assert sem.blocks == 1 and sem.waits == [50 * US] and sem.without == 0
    mtx = an.objects[(P.EV_MUTEX, MTX)]
    assert mtx.calls[P.CALL_LOCK] == 1                                   # the ENTER not counted
    assert mtx.blocks == 1 and mtx.waits == [100 * US] and mtx.without == 1   # the timeout
    tmr = an.objects[(P.EV_TIMER, TMR)]
    assert tmr.durations == [3 * US] and tmr.calls[P.CALL_EXPIRY] == 1


def test_short_names_keep_the_offset() -> None:
    from zprof_bridge.analyze import short_name
    s = short_name("_k_mem_slab_buf_tcp_conns_slab+0x1a4", 24)
    assert len(s) == 24 and s.endswith("~+0x1a4")


def test_waits_reach_the_live_timeline_with_the_holder() -> None:
    d = stream()
    got = []
    tr = Tracker(d.hello, keep=False, on_wait=lambda th, key, a, b, holder: got.append((th, key, a, b, holder)))
    tr.feed(d.records)
    assert (A, (P.EV_SEM, SEM), 12 * US, 62 * US, 0) in got
    assert (A, (P.EV_MUTEX, MTX), 71 * US, 171 * US, B) in got      # who held the mutex
    assert all(th != ISR_CTX for th, *_ in got)
