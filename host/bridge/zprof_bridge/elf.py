# SPDX-License-Identifier: Apache-2.0
"""Names for target addresses, from the ELF of the running build.

The target sends pointers, never strings: interrupt handlers and their
arguments, thread entry points, wait queues, and later marker and print
format strings. This turns them into `symbol` or `symbol+offset`, and checks
that the ELF is the build on the board (the hello's build id against the
bytes of the ELF's `zprof_build_id`).
"""
from __future__ import annotations

import bisect
from pathlib import Path

from elftools.elf.elffile import ELFFile
from elftools.elf.sections import SymbolTableSection


class Elf:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._starts: list[int] = []
        self._syms: list[tuple[int, int, str]] = []  # (start, size, name)
        self.by_name: dict[str, tuple[int, int]] = {}
        with open(self.path, "rb") as f:
            elf = ELFFile(f)
            syms = []
            for sec in elf.iter_sections():
                if not isinstance(sec, SymbolTableSection):
                    continue
                for s in sec.iter_symbols():
                    kind = s["st_info"]["type"]
                    if kind not in ("STT_FUNC", "STT_OBJECT") or not s.name:
                        continue
                    addr = s["st_value"]
                    if kind == "STT_FUNC":
                        addr &= ~1  # Thumb bit
                    syms.append((addr, s["st_size"], s.name))
                    self.by_name.setdefault(s.name, (addr, s["st_size"]))
            self._segments = [
                (seg["p_vaddr"], seg["p_filesz"], seg.data())
                for seg in elf.iter_segments() if seg["p_type"] == "PT_LOAD"
            ]
        syms.sort()
        self._syms = syms
        self._starts = [s[0] for s in syms]

    def name(self, addr: int, exact_only: bool = False) -> str | None:
        """`symbol` or `symbol+0xoff` for an address inside a symbol, else None."""
        a = addr & ~1 if addr & 1 else addr
        i = bisect.bisect_right(self._starts, a) - 1
        while i >= 0:
            start, size, name = self._syms[i]
            if a == start:
                return name
            if a < start + max(size, 1):
                return None if exact_only else f"{name}+{a - start:#x}"
            if a - start > 0x10000:
                break
            i -= 1
        return None

    def read(self, addr: int, n: int) -> bytes | None:
        """Initial bytes at a load address (from the image, as flashed)."""
        for vaddr, size, data in self._segments:
            if vaddr <= addr and addr + n <= vaddr + size:
                return data[addr - vaddr: addr - vaddr + n]
        return None

    def check_build_id(self, build_id: bytes) -> str | None:
        """None if the ELF is the board's build, else why not."""
        if "zprof_build_id" not in self.by_name:
            return f"{self.path.name} has no zprof_build_id: not a zprof build"
        addr, _ = self.by_name["zprof_build_id"]
        mine = self.read(addr, 16)
        if mine is None:
            return "zprof_build_id is not in a loaded segment of the ELF"
        if mine != build_id:
            return f"{self.path.name} is another build (its id {mine.hex()}, the board's {build_id.hex()})"
        return None
