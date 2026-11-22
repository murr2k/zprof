# SPDX-License-Identifier: Apache-2.0
"""The live session on a synthetic stream: lanes, timeline batches, statistics."""
from __future__ import annotations

import json
import struct

from zprof_bridge import proto as P
from zprof_bridge.live import DROP, ISR, READY, RUN, LiveSession

from test_stream import A, B, HZ, IDLE, SENDER, Enc


def decode_batch(b: bytes):
    assert b[:4] == b"ZIV1"
    n = struct.unpack_from("<I", b, 4)[0]
    t0 = struct.unpack_from(f"<{n}d", b, 8)
    t1 = struct.unpack_from(f"<{n}d", b, 8 + 8 * n)
    lane = struct.unpack_from(f"<{n}H", b, 8 + 16 * n)
    code = struct.unpack_from(f"<{n}B", b, 8 + 18 * n)
    return list(zip(t0, t1, lane, code))


def test_lanes_batches_and_stats() -> None:
    e = Enc()
    e.hello()
    ms = HZ // 1000
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, 0, SENDER, 0) + r(0, P.EV_SWITCH_IN, 0, A)
    tr += r(1 * ms, P.EV_ISR_ENTER, 33) + r(1 * ms, P.EV_READY, 0, B) + r(2 * ms, P.EV_ISR_EXIT, 33)
    tr += r(4 * ms, P.EV_SWITCH_OUT, 0, A, 0) + r(4 * ms, P.EV_SWITCH_IN, 5, B)
    tr += r(6 * ms, P.EV_SWITCH_OUT, 0, B, 0) + r(6 * ms, P.EV_SWITCH_IN, 15, IDLE)
    tr += r(7 * ms, P.EV_OVERFLOW, 0, 3, 0, 0, IDLE)
    tr += r(1000 * ms, P.EV_SWITCH_OUT, 0, IDLE, 0) + r(1000 * ms, P.EV_SWITCH_IN, 14, SENDER)
    e.frame(P.CH_TRACE, tr)

    s = LiveSession(target="test")
    s.feed(bytes(e.out))
    msgs = s.updates()
    hello = json.loads(msgs[0])
    assert hello["type"] == "hello"
    names = [x["name"] for x in hello["lanes"]]
    assert names[0] == "IRQ 33"                     # interrupts first
    assert names[1:3] == ["main", "worker"]          # then threads by priority
    ivs = decode_batch(msgs[1])
    lane = {n: i for i, n in enumerate(names)}
    got = {(round(a, 3), round(b, 3), names[ln], c) for a, b, ln, c in ivs}
    assert (0.0, 4.0, "main", RUN) in got
    assert (1.0, 2.0, "IRQ 33", ISR) in got
    assert (1.0, 4.0, "worker", READY) in got        # ready at 1 ms, ran at 4 ms
    assert (7.0, 7.0, "idle", DROP) in got
    stats = [json.loads(m) for m in msgs[2:] if isinstance(m, str)]
    assert stats and stats[0]["type"] == "stats"
    main = next(x for x in stats[0]["threads"] if x["name"] == "main")
    assert abs(main["cpu_pct"] - 0.4) < 1e-6           # 4 ms of the first second
    assert stats[0]["dropped"] == 3
    assert lane["worker"] == 2
    # nothing new: nothing to send
    assert s.updates() == []


def test_a_reconnect_keeps_the_page_and_a_reboot_starts_it_over() -> None:
    def session_bytes(sync_ts: int, up: int) -> bytes:
        e = Enc()
        e.hello()
        ms = HZ // 1000
        r = Enc.rec
        tr = Enc.sync(sync_ts, up) + r(sync_ts, P.EV_SWITCH_OUT, 0, SENDER, 0) + r(sync_ts, P.EV_SWITCH_IN, 0, A)
        tr += r(sync_ts + 1100 * ms, P.EV_SWITCH_OUT, 0, A, 0) + r(sync_ts + 1100 * ms, P.EV_SWITCH_IN, 15, IDLE)
        e.frame(P.CH_TRACE, tr)
        return bytes(e.out)

    s = LiveSession(target="test")
    s.link("up")
    s.feed(session_bytes(1000, 10 * HZ))
    first = s.updates()
    hello = json.loads(next(m for m in first if isinstance(m, str) and '"hello"' in m))
    s.link("down", "cable out")
    s.restart()
    s.link("up")
    s.feed(session_bytes(7, 20 * HZ))                # the same lanes, 10 s later on the target's clock
    again = s.updates()
    kinds = [json.loads(m)["type"] for m in again if isinstance(m, str)]
    assert "hello" not in kinds                       # the page keeps its timeline
    assert kinds.count("status") == 2                 # down, then up
    ivs = [iv for m in again if isinstance(m, bytes) for iv in decode_batch(m)]
    assert min(a for a, _, _, _ in ivs) >= 20_000     # ms of target time: after the gap
    st = [json.loads(m) for m in again if isinstance(m, str) and '"stats"' in m]
    assert st and all(x["secs"] < 1.5 for x in st)    # no statistics window spans the gap
    s.restart()
    s.feed(session_bytes(5, 2 * HZ))                  # clock went back: rebooted
    after = s.updates()
    hellos = [json.loads(m) for m in after if isinstance(m, str) and '"hello"' in m]
    assert hellos and hellos[0]["epoch"] == hello["epoch"] + 1
