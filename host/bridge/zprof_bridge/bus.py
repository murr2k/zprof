# SPDX-License-Identifier: Apache-2.0
"""The protocol analyzer's records (ETH_RX, ETH_TX, I2C, DISK; firmware/zprof/src/bus.c):
decoded, summed up as text, and the control frame that turns them on."""
from __future__ import annotations

import statistics
import struct
from collections import defaultdict

from . import proto as P

NAMES = {"eth": P.PROTO_ETH, "i2c": P.PROTO_I2C, "disk": P.PROTO_DISK}
SECTOR = 512


def mask(spec: str) -> int:
    """'eth,i2c,disk' or 'all' as a CT_PROTO mask."""
    if spec.strip() == "all":
        return P.PROTO_ETH | P.PROTO_I2C | P.PROTO_DISK
    m = 0
    for s in spec.split(","):
        s = s.strip()
        if s not in NAMES:
            raise ValueError(f"unknown bus {s!r} (eth, i2c, disk, all)")
        m |= NAMES[s]
    return m


def frame(m: int) -> bytes:
    v = struct.pack("<I", m)
    tlv = struct.pack("<HH", P.CT_PROTO, len(v)) + v
    return struct.pack("<BBHI", P.CH_CONTROL, 0, 0, len(tlv)) + tlv


def eth_bytes(r) -> bytes:
    """A frame record's bytes (its first 56, or fewer for a short frame)."""
    words = r.w[1:] if r.id == P.EV_ETH_TX else r.w
    return struct.pack(f"<{len(words)}I", *words)[: min(r.arg, P.ETH_SNAP)]


def flow(b: bytes) -> str:
    """'IPv4 TCP 192.0.2.10:80 > 192.0.2.20:51000', 'ARP', or the ethertype."""
    if len(b) < 14:
        return "short"
    et = b[12] << 8 | b[13]
    if et == 0x0806:
        return "ARP"
    if et != 0x0800 or len(b) < 34:
        return f"ethertype {et:#06x}"
    ihl = (b[14] & 0x0F) * 4
    proto = b[23]
    src, dst = ".".join(map(str, b[26:30])), ".".join(map(str, b[30:34]))
    l4 = 14 + ihl
    name = {6: "TCP", 17: "UDP", 1: "ICMP"}.get(proto, f"proto {proto}")
    if proto in (6, 17) and len(b) >= l4 + 4:
        sp, dp = b[l4] << 8 | b[l4 + 1], b[l4 + 2] << 8 | b[l4 + 3]
        return f"IPv4 {name} {src}:{sp} > {dst}:{dp}"
    return f"IPv4 {name} {src} > {dst}"


class Anonymizer:
    """Stand-ins for the hosts in frames, stable within one export or summary: MACs as
    locally administered 02:00:00:00:xx:xx, IPv4 addresses from the documentation
    ranges (192.0.2.0/24, then 198.51.100.0/24, 203.0.113.0/24), in order of first
    appearance; broadcast and multicast kept. Ports, lengths, flags and times stay.
    Bytes past the headers (Ethernet, IPv4, ARP, TCP, UDP, ICMP) are zeroed: DHCP, STP
    and ICMP errors carry addresses in their payloads."""

    NETS = (bytes([192, 0, 2]), bytes([198, 51, 100]), bytes([203, 0, 113]))

    def __init__(self) -> None:
        self.macs: dict[bytes, bytes] = {}
        self.ips: dict[bytes, bytes] = {}

    def mac(self, m: bytes) -> bytes:
        if len(m) < 6 or m[0] & 1 or m == b"\0" * 6:
            return m                                   # broadcast, multicast, none
        if m not in self.macs:
            n = len(self.macs) + 1
            self.macs[m] = bytes([2, 0, 0, 0, (n >> 8) & 0xFF, n & 0xFF])
        return self.macs[m]

    def ip(self, a: bytes) -> bytes:
        if len(a) < 4 or a == b"\0" * 4 or a == b"\xff" * 4 or a[0] >= 224:
            return a
        if a not in self.ips:
            n = len(self.ips)
            self.ips[a] = self.NETS[(n // 254) % 3] + bytes([n % 254 + 1])
        return self.ips[a]

    def frame(self, b: bytes) -> bytes:
        b = bytearray(b)
        keep = min(len(b), 14)
        if len(b) >= 12:
            b[0:6], b[6:12] = self.mac(bytes(b[0:6])), self.mac(bytes(b[6:12]))
        et = b[12] << 8 | b[13] if len(b) >= 14 else 0
        if et == 0x0806 and len(b) >= 42:              # ARP: sender and target, hardware and IP
            b[22:28], b[28:32] = self.mac(bytes(b[22:28])), self.ip(bytes(b[28:32]))
            b[32:38], b[38:42] = self.mac(bytes(b[32:38])), self.ip(bytes(b[38:42]))
            keep = 42
        elif et == 0x0800 and len(b) >= 34:
            ihl = (b[14] & 0x0F) * 4
            b[26:30], b[30:34] = self.ip(bytes(b[26:30])), self.ip(bytes(b[30:34]))
            if 14 + ihl <= len(b):                     # the header checksum, made right again
                b[24:26] = b"\0\0"
                s = sum(struct.unpack(f">{ihl // 2}H", bytes(b[14:14 + ihl])))
                while s >> 16:
                    s = (s & 0xFFFF) + (s >> 16)
                b[24:26] = struct.pack(">H", ~s & 0xFFFF)
            l4 = 14 + ihl
            tcp = max(20, (b[l4 + 12] >> 4) * 4) if len(b) > l4 + 12 else 20   # its data offset, at least 20
            keep = l4 + {6: tcp, 17: 8, 1: 8}.get(b[23], 0)
        b[keep:] = b"\0" * (len(b) - keep)
        return bytes(b)


def _signed(v: int) -> int:
    return v - (1 << 32) if v & 0x80000000 else v


def report(an) -> list[str]:
    """The buses section of `summary`: I2C per device and address, disk transfers,
    Ethernet frames each way and the busiest flows."""
    recs = [r for r in an.d.records if r.id in (P.EV_ETH_RX, P.EV_ETH_TX, P.EV_I2C, P.EV_DISK)]
    if not recs:
        return []
    secs = an.seconds(an.t1 - an.t0) or 1e-9
    us = lambda ticks: an.seconds(ticks) * 1e6  # noqa: E731
    def name(a: int) -> str:
        """A device by its name: struct device starts with a pointer to it (rodata)."""
        if an.elf is None:
            return f"{a:#010x}"
        p = an.elf.read(a, 4)
        s = an.elf.string(struct.unpack("<I", p)[0]) if p and len(p) == 4 else None
        return s or an.elf.name(a) or f"{a:#010x}"
    out = ["", "buses"]

    i2c = defaultdict(list)
    for r in recs:
        if r.id == P.EV_I2C and len(r.w) >= 4:
            i2c[(r.w[0], r.arg)].append(r)
    if i2c:
        out.append(f"  {'I2C device':28s} {'addr':>6s} {'msgs/s':>7s} {'bytes/s':>8s} "
                   f"{'mean us':>8s} {'max us':>8s} {'errors':>6s}")
        for (dev, addr), rs in sorted(i2c.items(), key=lambda kv: -len(kv[1])):
            d = [us(r.w[2]) for r in rs]
            nbytes = sum(r.w[1] & 0xFFFF for r in rs)
            err = sum(1 for r in rs if _signed(r.w[3]) != 0)
            out.append(f"  {name(dev)[:28]:28s} {addr:#6x} {len(rs) / secs:7.1f} {nbytes / secs:8.0f} "
                       f"{statistics.mean(d):8.1f} {max(d):8.1f} {err:6d}")

    disk = [r for r in recs if r.id == P.EV_DISK and len(r.w) >= 5]
    if disk:
        out.append(f"  {'disk':28s} {'op':>6s} {'xfers/s':>7s} {'MB/s':>8s} {'mean us':>8s} {'max us':>8s} {'errors':>6s}")
        for op, label in ((0, "read"), (1, "write")):
            rs = [r for r in disk if r.arg == op]
            if not rs:
                continue
            d = [us(r.w[3]) for r in rs]
            mb = sum(r.w[2] for r in rs) * SECTOR / 1e6
            err = sum(1 for r in rs if _signed(r.w[4]) != 0)
            dn = (an.elf.string(rs[0].w[0]) if an.elf else None) or name(rs[0].w[0])
            out.append(f"  {dn[:28]:28s} {label:>6s} {len(rs) / secs:7.1f} {mb / secs:8.2f} "
                       f"{statistics.mean(d):8.0f} {max(d):8.0f} {err:6d}")

    eth = [r for r in recs if r.id in (P.EV_ETH_RX, P.EV_ETH_TX)]
    if eth:
        for rid, label in ((P.EV_ETH_RX, "received"), (P.EV_ETH_TX, "sent")):
            rs = [r for r in eth if r.id == rid]
            if rs:
                line = f"  Ethernet {label}: {len(rs) / secs:,.0f} frames/s, {sum(r.arg for r in rs) / secs / 1024:,.1f} KB/s"
                if rid == P.EV_ETH_TX:
                    d = [us(r.w[0] & 0x7FFFFFFF) for r in rs]
                    line += f", to transmit complete {statistics.mean(d):.0f} us mean, {max(d):.0f} max"
                out.append(line + "  (zprof's own stream left out)")
        flows = defaultdict(lambda: [0, 0])
        anon = getattr(an, "anonymize", None)
        for r in eth:
            b = eth_bytes(r)
            f = ("< " if r.id == P.EV_ETH_RX else "> ") + flow(anon.frame(b) if anon else b)
            flows[f][0] += 1
            flows[f][1] += r.arg
        out.append(f"  {'busiest flows (< in, > out)' + (', addresses anonymized' if anon else ''):60s} "
                   f"{'frames':>7s} {'KB':>8s}")
        for f, (n, b) in sorted(flows.items(), key=lambda kv: -kv[1][1])[:8]:
            out.append(f"  {f[:60]:60s} {n:7d} {b / 1024:8.1f}")
    return out
