# SPDX-License-Identifier: Apache-2.0
"""The .zpr recording (docs/PROTOCOL.md section 5): a JSON header line, then
chunks of the stream as received, `u64 host_ns | u32 len | bytes`. Replay
feeds the bytes through the same decoder as a live session.
"""
from __future__ import annotations

import hashlib
import json
import struct
import time
from pathlib import Path
from typing import BinaryIO, Iterator

MAGIC = "ZPR1"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


class Writer:
    def __init__(self, path: str | Path, meta: dict):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.f: BinaryIO = open(self.path, "wb")
        head = {"magic": MAGIC, "host_start_ns": time.time_ns(), **meta}
        self.f.write((json.dumps(head) + "\n").encode())

    def chunk(self, data: bytes) -> None:
        if data:
            self.f.write(struct.pack("<QI", time.time_ns(), len(data)))
            self.f.write(data)

    def restart(self) -> None:
        """The connection broke and a new one begins: an empty chunk marks it, so a
        replay drops any half frame before the next session's preamble."""
        self.f.write(struct.pack("<QI", time.time_ns(), 0))
        self.f.flush()

    def close(self) -> None:
        self.f.close()


def feed_all(path: str | Path, d) -> dict:
    """Decode a whole recording into the decoder `d` (restart markers included); the header."""
    head, chunks = read(path)
    for _, data in chunks:
        if data:
            d.feed(data)
        else:
            d.restart()
    return head


def read(path: str | Path) -> tuple[dict, Iterator[tuple[int, bytes]]]:
    """The header and an iterator over (host_ns, bytes) chunks; an empty chunk is a
    restart marker (the connection broke there)."""
    f = open(path, "rb")
    head = json.loads(f.readline())
    if head.get("magic") != MAGIC:
        f.close()
        raise ValueError(f"{path}: not a zprof recording")

    def chunks() -> Iterator[tuple[int, bytes]]:
        with f:
            while True:
                h = f.read(12)
                if len(h) < 12:
                    return
                ns, n = struct.unpack("<QI", h)
                yield ns, f.read(n)

    return head, chunks()
