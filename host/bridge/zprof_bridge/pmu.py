# SPDX-License-Identifier: Apache-2.0
"""The Armv8.1-M PMU events zprof counts (four at a time: HT_PMU, CT_PMU) and how
to show them. Event numbers are Arm's (CMSIS pmu_armv8.h, ARM_PMU_*)."""
from __future__ import annotations

import struct

from . import proto as P

# event -> (short name, kind): "inst" instructions, "cycles" a count of cycles (shown
# as a share of the thread's run time), "events" anything else (per 1000 instructions)
EVENTS: dict[int, tuple[str, str]] = {
    0x0008: ("instructions", "inst"),
    0x0001: ("icache_refills", "events"),
    0x0003: ("dcache_refills", "events"),
    0x0004: ("dcache_accesses", "events"),
    0x0039: ("dcache_read_misses", "events"),
    0x0013: ("mem_accesses", "events"),
    0x0019: ("bus_accesses", "events"),
    0x0009: ("exceptions", "events"),
    0x0011: ("cycles", "cycles"),
    0x0023: ("frontend_stall_cycles", "cycles"),
    0x0024: ("backend_stall_cycles", "cycles"),
    0x003C: ("stall_cycles", "cycles"),
    0x0200: ("mve_instructions", "mve"),
    0x0204: ("mve_fp_instructions", "mve"),
    0x0228: ("mve_mac_instructions", "mve"),
    0x02CC: ("mve_stall_cycles", "cycles"),
}

PRESETS: dict[str, tuple[int, int, int, int]] = {
    # the target's default: where the time goes on an XIP part with caches
    "cache": (0x0008, 0x0001, 0x0003, 0x0024),
    # Helium (MVE): how much of the work is vector, and what it waits for
    "helium": (0x0008, 0x0200, 0x02CC, 0x0024),
}


def name(ev: int) -> str:
    return EVENTS.get(ev, (f"event_{ev:#06x}", "events"))[0]


def kind(ev: int) -> str:
    return EVENTS.get(ev, ("", "events"))[1]


def frame(events: tuple[int, ...] | None, per_thread: bool) -> bytes:
    """CT_PMU in a control frame: the events (None: keep), per-thread counts on or off."""
    ev = tuple(events) if events else (0xFFFF,) * 4
    v = struct.pack("<HHHHI", *ev, P.PMU_F_SWITCH if per_thread else 0)
    tlv = struct.pack("<HH", P.CT_PMU, len(v)) + v
    return struct.pack("<BBHI", P.CH_CONTROL, 0, 0, len(tlv)) + tlv


def figures(events: tuple[int, ...], counts: list[int], run_cycles: int) -> dict[str, float]:
    """A thread's (or a window's) counts as figures: IPC, events per 1000 instructions,
    cycle counts as a share of the run time, MVE instructions as a share of all."""
    out: dict[str, float] = {}
    inst = next((c for e, c in zip(events, counts) if kind(e) == "inst"), None)
    for e, c in zip(events, counts):
        k, n = kind(e), name(e)
        if k == "inst":
            if run_cycles:
                out["ipc"] = c / run_cycles
        elif k == "cycles":
            if run_cycles:
                out[n + "_pct"] = 100.0 * c / run_cycles
        elif k == "mve":
            if inst:
                out[n + "_pct"] = 100.0 * c / inst
        elif inst:
            out[n + "_pki"] = 1000.0 * c / inst
    return out


SHORT = {"instructions": "inst", "icache_refills": "I$", "dcache_refills": "D$",
         "dcache_accesses": "D$ access", "dcache_read_misses": "D$ rd miss", "mem_accesses": "mem acc",
         "bus_accesses": "bus acc", "exceptions": "exc", "cycles": "cycles",
         "frontend_stall_cycles": "FE stall", "backend_stall_cycles": "BE stall", "stall_cycles": "stall",
         "mve_instructions": "MVE", "mve_fp_instructions": "MVE FP", "mve_mac_instructions": "MVE MAC",
         "mve_stall_cycles": "MVE stall"}


def label(key: str) -> str:
    """A figure's column heading: IPC, 'BE stall %', 'I$ refill/ki'."""
    if key == "ipc":
        return "IPC"
    for suffix, unit in (("_pct", " %"), ("_pki", "/ki")):
        if key.endswith(suffix):
            n = key[: -len(suffix)]
            return SHORT.get(n, n) + unit
    return key
