# SPDX-License-Identifier: Apache-2.0
"""Fault records: the layout fault.c writes, the CRC, decoding in a hello, the text."""
from __future__ import annotations

import struct
import zlib

from zprof_bridge import fault
from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis, report
from zprof_bridge.stream import Decoder

from test_stream import A, HZ, Enc


def record(reason: int = 30, flags: int = 0, frames=(0x70001235, 0x70002001), name=b"crash") -> bytes:
    w = [P.FAULT_MAGIC, 48, 1, 2, 3, 4, 12345, reason, flags, A]
    head = struct.pack(f"<{len(w)}I", *w) + name.ljust(16, b"\0")
    r = [0, 1, 2, 3, 12, 0x70001001, 0x70001234, 0x01000000]
    callee = [4, 5, 6, 7, 8, 9, 10, 11, 0x34001F00]
    tail = r + callee + [0x34100000, 0xFFFFFFBC, 0x40000000, 0, 0, 0, len(frames)]
    tail += list(frames) + [0] * (8 - len(frames)) + [777]
    body = head + struct.pack(f"<{len(tail)}I", *tail)
    return body + struct.pack("<I", zlib.crc32(body) & 0xFFFFFFFF)


def test_the_record_parses_and_checks() -> None:
    v = record()
    assert len(v) == 48 * 4
    f = fault.parse(v)
    assert f and f.crc_ok and f.name == "crash" and f.thread == A
    assert f.pc == 0x70001234 and f.lr == 0x70001001 and f.frames == (0x70001235, 0x70002001)
    assert f.reason_name == "UsageFault: divide by zero" and not f.halted and f.ts == 777
    bad = bytearray(v)
    bad[100] ^= 1
    assert not fault.parse(bytes(bad)).crc_ok
    assert fault.parse(b"\0" * 192) is None


def test_reason_names_follow_zephyrs_numbering() -> None:
    assert fault.REASONS[3] == "kernel oops"
    assert fault.REASONS[16] == "MemManage"
    assert fault.REASONS[36] == "UsageFault: undefined instruction"


def test_a_fault_in_the_hello_reaches_the_report() -> None:
    e = Enc()
    p = Enc.tlv(P.HT_CLOCKS, struct.pack("<III", HZ, HZ, P.TS_SRC_DWT))
    p += Enc.tlv(P.HT_FAULT, record(reason=3, flags=P.FAULT_F_NOWALK | P.FAULT_F_RAN_ON, frames=()))
    p += Enc.tlv(P.HT_END, b"")
    e.frame(P.CH_CONTROL, p)
    e.frame(P.CH_TRACE, Enc.sync(0) + Enc.rec(10, P.EV_FAULT, 3, 0x70001234, A, P.FAULT_F_NOWALK))
    d = Decoder()
    got = []
    d.on_fault = got.append
    d.feed(bytes(e.out))
    assert len(got) == 1 and got[0].reason == 3
    text = report(Analysis(d))
    assert "FAULT    kernel oops in thread crash" in text and "the rest ran on" in text
    assert "trace    none" in text


def test_who_decided_what_followed() -> None:
    def after(flags: int) -> str:
        return fault.describe(fault.parse(record(flags=flags)))[0]
    assert after(P.FAULT_F_HALTED).endswith("zprof's handler halted the system")
    assert after(P.FAULT_F_RAN_ON).endswith("the rest ran on")
    assert after(0).endswith("the application's own handler decided what followed")
