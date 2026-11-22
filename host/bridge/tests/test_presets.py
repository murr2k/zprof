# SPDX-License-Identifier: Apache-2.0
"""Capture presets: the control frame, the page's choice reaching the target on every
connection, the target's answer, and waits drawn from the scheduler's records alone."""
from __future__ import annotations

import json
import struct

from zprof_bridge import proto as P
from zprof_bridge.live import BLOCKED, WAITING, LiveSession
from zprof_bridge.presets import BY_ID, classes_frame, preset_of
from zprof_bridge.stream import Decoder

from test_live import decode_batch
from test_stream import A, B, HZ, SENDER, Enc

MTX = 0x34010100


def test_the_control_frame() -> None:
    f = classes_frame(BY_ID["timing"]["classes"])
    ch, _flags, _seq, n = struct.unpack_from("<BBHI", f)
    tag, ln, mask = struct.unpack_from("<HHI", f, 8)
    assert (ch, n, tag, ln) == (P.CH_CONTROL, 8, P.CT_CLASSES, 4)
    assert mask == 1 << (P.EV_MUTEX - P.OBJ_FIRST)
    assert preset_of(0) == "sched" and preset_of(0x12345) is None


def test_the_choice_goes_to_every_connection_and_the_answer_comes_back() -> None:
    sent: list[bytes] = []
    s = LiveSession(target="t")
    s.command({"type": "preset", "id": "sched"})      # chosen before the board is reachable
    s.link("up")
    s.attach(sent.append)
    assert sent == [classes_frame(0)]
    s.command({"type": "preset", "id": "timing"})
    assert sent[-1] == classes_frame(BY_ID["timing"]["classes"])
    # the target's answer: HT_CLASSES in a control frame after the hello
    e = Enc()
    e.hello()
    e.frame(P.CH_CONTROL, struct.pack("<HHI", P.HT_CLASSES, 4, BY_ID["timing"]["classes"]))
    s.feed(bytes(e.out))
    st = [json.loads(m) for m in s.updates() if isinstance(m, str) and '"status"' in m]
    assert st[-1]["preset"] == "timing" and st[-1]["want"] == BY_ID["timing"]["classes"]
    s.link("down", "cable out")
    s.link("up")
    s.attach(sent.append)                             # a new session: the choice again
    assert sent[-1] == classes_frame(BY_ID["timing"]["classes"])


def test_a_replay_cannot_be_told() -> None:
    s = LiveSession(source="replay")
    s.command({"type": "preset", "id": "sched"})
    assert s.want_classes is None


def test_waits_come_from_switch_out_and_ready() -> None:
    e = Enc()
    e.hello()
    ms = HZ // 1000
    r = Enc.rec
    tr = Enc.sync(0) + r(0, P.EV_SWITCH_OUT, 0, SENDER, 0) + r(0, P.EV_SWITCH_IN, 0, A)
    # B is known to wait on a mutex (a mutex call named it), A on a semaphore
    tr += r(1 * ms, P.EV_MUTEX, (P.CALL_LOCK << 4) | P.PH_BLOCK, MTX, A)
    tr += r(2 * ms, P.EV_SWITCH_OUT, P.THS_PENDING, A, 0x34010000) + r(2 * ms, P.EV_SWITCH_IN, 5, B)
    tr += r(3 * ms, P.EV_SWITCH_OUT, P.THS_PENDING, B, MTX) + r(3 * ms, P.EV_SWITCH_IN, 0, SENDER)
    tr += r(5 * ms, P.EV_READY, 0, A) + r(6 * ms, P.EV_READY, 0, B)
    tr += r(7 * ms, P.EV_SWITCH_OUT, P.THS_QUEUED, SENDER, 0) + r(7 * ms, P.EV_SWITCH_IN, 0, A)
    tr += r(1100 * ms, P.EV_SWITCH_OUT, 0, A, 0)
    e.frame(P.CH_TRACE, tr)
    s = LiveSession(target="t")
    s.feed(bytes(e.out))
    out = s.updates()
    names = [x["name"] for x in json.loads(next(m for m in out if isinstance(m, str) and '"hello"' in m))["lanes"]]
    got = {(round(a, 3), round(b, 3), names[ln], c) for m in out if isinstance(m, bytes) for a, b, ln, c in decode_batch(m)}
    assert (2.0, 5.0, "main", WAITING) in got     # a semaphore: rest
    assert (3.0, 6.0, "worker", BLOCKED) in got   # the mutex: contention
    # preempted (QUEUED) is not a wait
    assert not any(n == "zprof_sender" and c in (WAITING, BLOCKED) for _, _, n, c in got)
    assert Decoder  # the decoder handles the answer frame (test above)
