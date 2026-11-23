# SPDX-License-Identifier: Apache-2.0
"""The protocol analyzer: frame bytes from records, flows, the summary, pcapng."""
from __future__ import annotations

import struct

import pytest

from zprof_bridge import bus, pcapng
from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis, report
from zprof_bridge.stream import Decoder

from test_stream import HZ, Enc

# Ethernet + IPv4 + TCP headers, documentation addresses only (RFC 5737, locally
# administered MACs): 192.0.2.10:80 > 192.0.2.20:51000
FRAME = (bytes.fromhex("020000000002020000000001" "08004500") + bytes(7) + bytes([6]) + bytes(2)
         + bytes([192, 0, 2, 10, 192, 0, 2, 20]) + struct.pack(">HH", 80, 51000) + bytes(16))


def words(b: bytes) -> list[int]:
    b = b[:56].ljust(56, b"\0")
    return list(struct.unpack("<14I", b))


def stream() -> Decoder:
    e = Enc()
    e.hello()
    ms = HZ // 1000
    tr = Enc.sync(0)
    tr += Enc.rec(1 * ms, P.EV_ETH_RX, 60, *words(FRAME))
    tr += Enc.rec(2 * ms, P.EV_ETH_TX, 1514, 40 * HZ // 1_000_000, *words(FRAME))
    tr += Enc.rec(3 * ms, P.EV_I2C, 0x5D, 0x34001000, (2 << 16) | 4, 120 * HZ // 1_000_000, 0, 0x04030201, 0)
    tr += Enc.rec(4 * ms, P.EV_I2C, 0x5D, 0x34001000, 1, 60 * HZ // 1_000_000, (-5) & 0xFFFFFFFF, 0, 0)
    tr += Enc.rec(5 * ms, P.EV_DISK, 0, 0x70010000, 2048, 64, 3 * ms, 0)
    tr += Enc.rec(1000 * ms, P.EV_DISK, 1, 0x70010000, 4096, 8, 2 * ms, 0)
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    return d


def test_masks_and_the_control_frame() -> None:
    assert bus.mask("eth,disk") == P.PROTO_ETH | P.PROTO_DISK and bus.mask("all") == 7
    with pytest.raises(ValueError):
        bus.mask("usb")
    tag, ln, m = struct.unpack_from("<HHI", bus.frame(6), 8)
    assert (tag, ln, m) == (P.CT_PROTO, 4, 6)


def test_frames_flows_and_the_summary() -> None:
    d = stream()
    rx = next(r for r in d.records if r.id == P.EV_ETH_RX)
    assert bus.eth_bytes(rx) == FRAME.ljust(56, b"\0")   # 54 bytes of headers, zero-padded as kept
    assert bus.flow(FRAME) == "IPv4 TCP 192.0.2.10:80 > 192.0.2.20:51000"
    text = report(Analysis(d))
    assert "buses" in text and "0x5d" in text
    i2c = next(l for l in text.splitlines() if " 0x5d " in l)
    assert i2c.split()[-1] == "1"                      # one message failed (-5)
    assert "read" in text and "write" in text
    assert "Ethernet sent" in text and "to transmit complete 40 us mean" in text


def test_pcapng_round_trip(tmp_path) -> None:
    d = stream()
    p = tmp_path / "x.pcapng"
    n = pcapng.write(p, d.records, HZ, t0_ns=1_700_000_000_000_000_000, t_first=0)
    got = pcapng.read(p)
    assert n == 2 and len(got) == 2
    (ns0, orig0, data0, f0), (ns1, orig1, data1, f1) = got
    assert data0 == FRAME.ljust(56, b"\0") and orig0 == 60 and f0 == pcapng.INBOUND
    assert orig1 == 1514 and f1 == pcapng.OUTBOUND and len(data1) == 56
    assert ns0 == 1_700_000_000_000_000_000 + 1_000_000 and ns1 - ns0 == 1_000_000
    raw = p.read_bytes()
    assert raw[:4] == b"\x0a\x0d\x0d\x0a" and len(raw) % 4 == 0


def test_anonymize_replaces_hosts_and_keeps_the_rest() -> None:
    a = bus.Anonymizer()
    out = a.frame(FRAME.ljust(56, b"\0"))
    assert out[0:6] == bytes([2, 0, 0, 0, 0, 1]) and out[6:12] == bytes([2, 0, 0, 0, 0, 2])
    assert bus.flow(out) == "IPv4 TCP 192.0.2.1:80 > 192.0.2.2:51000"     # ports and protocol kept
    hdr = out[14:34]                                   # a valid IPv4 header checksum again
    s = sum(struct.unpack(">10H", hdr))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    assert s == 0xFFFF
    assert a.frame(FRAME)[0:6] == out[0:6]             # stable within one anonymizer
    arp = bytes.fromhex("ffffffffffff" "020000000009" "0806") + bytes(8) + bytes.fromhex("020000000009") \
        + bytes([10, 1, 2, 3]) + bytes(6) + bytes([10, 1, 2, 4])
    o = a.frame(arp)
    assert o[0:6] == b"\xff" * 6 and o[28:32] == bytes([192, 0, 2, 3]) and o[38:42] == bytes([192, 0, 2, 4])
    stp = bytes.fromhex("0180c2000000" "020000000009" "0026") + bytes(range(1, 39))
    assert a.frame(stp)[14:] == bytes(38)              # not IP or ARP: past the header, zeroed
