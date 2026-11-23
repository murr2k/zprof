# SPDX-License-Identifier: Apache-2.0
"""Ethernet frame records as a pcapng file for Wireshark: one interface
(LINKTYPE_ETHERNET, snaplen 56: headers, not payloads), each frame at the target's
time, placed on the host's clock when the recording says when it began, with its
direction (pcapng: draft-ietf-opsawg-pcapng; blocks SHB, IDB, EPB)."""
from __future__ import annotations

import struct
from pathlib import Path

from . import proto as P
from .bus import eth_bytes

LINKTYPE_ETHERNET = 1
OPT_END, IF_TSRESOL, EPB_FLAGS = 0, 9, 2
INBOUND, OUTBOUND = 1, 2


def _block(btype: int, body: bytes) -> bytes:
    body += b"\0" * (-len(body) % 4)
    n = len(body) + 12
    return struct.pack("<II", btype, n) + body + struct.pack("<I", n)


def _opt(code: int, v: bytes) -> bytes:
    return struct.pack("<HH", code, len(v)) + v + b"\0" * (-len(v) % 4)


def write(path: str | Path, records, ts_hz: int, t0_ns: int = 0, t_first: int | None = None,
          anonymize=None) -> int:
    """The frames among `records` (ETH_RX, ETH_TX); timestamps in ns: t0_ns plus the
    time since t_first (the recording's first record), or the target's time since
    boot when t0_ns is 0; with `anonymize` (bus.Anonymizer) the hosts replaced by
    stand-ins. Returns the number of frames written."""
    hz = ts_hz or 1
    frames = [r for r in records if r.id in (P.EV_ETH_RX, P.EV_ETH_TX)]
    if t_first is None:
        t_first = frames[0].t if frames else 0
    with open(path, "wb") as f:
        f.write(_block(0x0A0D0D0A, struct.pack("<IHHq", 0x1A2B3C4D, 1, 0, -1)))
        idb = struct.pack("<HHI", LINKTYPE_ETHERNET, 0, P.ETH_SNAP)
        idb += _opt(IF_TSRESOL, bytes([9])) + _opt(OPT_END, b"")
        f.write(_block(1, idb))
        for r in frames:
            data = eth_bytes(r)
            if anonymize is not None:
                data = anonymize.frame(data)
            ns = (t0_ns + (r.t - t_first) * 1_000_000_000 // hz) if t0_ns else r.t * 1_000_000_000 // hz
            body = struct.pack("<IIIII", 0, ns >> 32, ns & 0xFFFFFFFF, len(data), r.arg) + data
            body += b"\0" * (-len(data) % 4)
            body += _opt(EPB_FLAGS, struct.pack("<I", INBOUND if r.id == P.EV_ETH_RX else OUTBOUND))
            body += _opt(OPT_END, b"")
            f.write(_block(6, body))
    return len(frames)


def read(path: str | Path) -> list[tuple[int, int, bytes, int]]:
    """A pcapng file written by `write`, back: (ns, original length, data, flags) per
    frame. For tests and a quick check without Wireshark."""
    b = Path(path).read_bytes()
    out, at = [], 0
    while at + 12 <= len(b):
        btype, n = struct.unpack_from("<II", b, at)
        if btype == 6:
            _, hi, lo, cap, orig = struct.unpack_from("<IIIII", b, at + 8)
            data = b[at + 28: at + 28 + cap]
            o = at + 28 + cap + (-cap % 4)
            flags = 0
            while o < at + n - 4:
                code, ln = struct.unpack_from("<HH", b, o)
                if code == EPB_FLAGS:
                    flags = struct.unpack_from("<I", b, o + 4)[0]
                if code == OPT_END:
                    break
                o += 4 + ln + (-ln % 4)
            out.append(((hi << 32) | lo, orig, data, flags))
        at += n
    return out
