# SPDX-License-Identifier: Apache-2.0
"""What the target records, by task: capture presets, and the control frame that
sets them.

Thread switches, wakeups and interrupts are always recorded; a preset chooses
the kernel-object classes on top. The fewer classes, the fewer events: on the
N6 demo every class together doubles the stream, and a burst of network
traffic then overflows the ring (docs/PROTOCOL.md, CT_CLASSES).
"""
from __future__ import annotations

import struct

from . import proto as P


def bit(cls: int) -> int:
    return 1 << (cls - P.OBJ_FIRST)


ALL = (1 << (P.OBJ_LAST - P.OBJ_FIRST + 1)) - 1

PRESETS = [
    {"id": "sched", "title": "Scheduling", "classes": 0,
     "note": "Thread switches, wakeups and interrupts only: the least load. Enough for the CPU "
             "figures, wake latency and the schedulability analysis."},
    {"id": "timing", "title": "Timing", "classes": bit(P.EV_MUTEX),
     "note": "Scheduling plus mutexes: who held the lock a thread waited for, so blocking in "
             "the schedulability analysis names its cause."},
    {"id": "objects", "title": "Kernel objects", "classes": ALL,
     "note": "Every semaphore, mutex, queue, sleep, poll, timer and work item call: the most "
             "load; bursts of network traffic can overflow the ring."},
]
BY_ID = {p["id"]: p for p in PRESETS}


def preset_of(classes: int) -> str | None:
    """The preset a class mask is, if any."""
    return next((p["id"] for p in PRESETS if p["classes"] == classes), None)


def _frame(tlv: bytes) -> bytes:
    return struct.pack("<BBHI", P.CH_CONTROL, 0, 0, len(tlv)) + tlv


def classes_frame(classes: int) -> bytes:
    """A control frame asking the target to record these classes (it answers with HT_CLASSES)."""
    return _frame(struct.pack("<HHI", P.CT_CLASSES, 4, classes & ALL))


def capture_frame(ms: int) -> bytes:
    """Capture-then-upload for `ms` (0: until stopped or full); answered with HT_CAPTURE."""
    return _frame(struct.pack("<HHI", P.CT_CAPTURE, 4, ms & 0xFFFFFFFF))


def capture_stop_frame() -> bytes:
    return _frame(struct.pack("<HH", P.CT_CAPTURE_STOP, 0))


def recorder_frame(post_ms: int) -> bytes:
    """The flight recorder: armed with `post_ms` kept after a trigger (0: off);
    answered with HT_RECORDER. It records once this client leaves."""
    return _frame(struct.pack("<HHI", P.CT_RECORDER, 4, post_ms & 0xFFFFFFFF))
