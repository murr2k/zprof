# SPDX-License-Identifier: Apache-2.0
"""The protocol's numbers, read from the firmware's include/zprof/proto.h.

One source for both sides: every `#define ZPROF_<NAME> <number>` line of the
header becomes an attribute here (ZPROF_EV_SWITCH_IN -> EV_SWITCH_IN).
"""
from __future__ import annotations

import re
from pathlib import Path

HEADER = Path(__file__).resolve().parents[3] / "firmware" / "zprof" / "include" / "zprof" / "proto.h"

_DEF = re.compile(r"^#define\s+ZPROF_([A-Z0-9_]+)\s+(0x[0-9A-Fa-f]+|\d+)u?\b")


def load(path: Path = HEADER) -> dict[str, int]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = _DEF.match(line.strip())
        if m:
            out[m.group(1)] = int(m.group(2), 0)
    return out


_N = load()
globals().update(_N)

PROTO_VERSION: int
EV_NAMES = {v: k[3:] for k, v in _N.items() if k.startswith("EV_")}
MAGIC = b"ZPRF"
