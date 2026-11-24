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


_A2L: list[str | None] = []


def find_addr2line() -> str | None:
    """binutils' addr2line for the target: ZPROF_ADDR2LINE, else the Zephyr SDK's
    (ZEPHYR_SDK_INSTALL_DIR, or ~/zephyr-sdk-*), else one on the PATH."""
    if _A2L:
        return _A2L[0]
    import glob
    import os
    import shutil
    exe = "arm-zephyr-eabi-addr2line" + (".exe" if os.name == "nt" else "")
    cands = [os.environ.get("ZPROF_ADDR2LINE")]
    roots = [os.environ.get("ZEPHYR_SDK_INSTALL_DIR")] + sorted(glob.glob(os.path.expanduser("~/zephyr-sdk-*")), reverse=True)
    for r in filter(None, roots):
        cands += [os.path.join(r, "gnu", "arm-zephyr-eabi", "bin", exe), os.path.join(r, "arm-zephyr-eabi", "bin", exe)]
    cands.append(shutil.which(exe))
    _A2L.append(next((c for c in cands if c and os.path.isfile(c)), None))
    return _A2L[0]


class Elf:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lines_cache: dict[int, str | None] = {}
        self._sites: dict[int, str] = {}
        self._cu_rows: dict[int, list[tuple[int, str, int]]] = {}
        self._dwarf_loaded = False
        self._dwarf = self._aranges = None
        self._starts: list[int] = []
        self._syms: list[tuple[int, int, str]] = []  # (start, size, name)
        self.by_name: dict[str, tuple[int, int]] = {}
        funcs = []
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
                        funcs.append((addr, s["st_size"], s.name))
                    syms.append((addr, s["st_size"], s.name))
                    self.by_name.setdefault(s.name, (addr, s["st_size"]))
            self._segments = [
                (seg["p_vaddr"], seg["p_filesz"], seg.data())
                for seg in elf.iter_segments() if seg["p_type"] == "PT_LOAD"
            ]
        syms.sort()
        self._syms = syms
        self._starts = [s[0] for s in syms]
        # functions for code addresses (PC samples): one written in assembly without a
        # .size (LVGL's Helium blends) has size 0 and is taken to run to the next one
        funcs.sort()
        self._funcs: list[tuple[int, int, str]] = []
        for i, (a, n, name) in enumerate(funcs):
            if n == 0:
                nxt = next((b for b, _, _ in funcs[i + 1:] if b > a), a + 0x1000)
                n = min(nxt - a, 0x1000)
            self._funcs.append((a, a + n, name))
        self._fstarts = [f[0] for f in self._funcs]

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

    def function(self, addr: int) -> str | None:
        """The function a code address is in (functions only, zero-size ones running to
        the next), else None."""
        a = addr & ~1
        i = bisect.bisect_right(self._fstarts, a) - 1
        while i >= 0:
            start, end, name = self._funcs[i]
            if a < end:
                return name
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

    def call_sites(self, pcs) -> dict[int, str]:
        """Names for return addresses of calls (the call sites of blocking calls):
        `file.c:123 (function)`, through the calls the compiler inlined: the innermost
        frame outside a header (k_sem_take() is an inline wrapper in a generated header).
        binutils' addr2line -i does that walk; without it, the line table (when the
        line is not in a header), else `symbol+0xoff`. Cached."""
        todo = sorted({p for p in pcs if p and p not in self._sites})
        if todo:
            got = self._addr2line(todo)
            for p in todo:
                n = got.get(p)
                if n is None:
                    a = (p & ~1) - 2
                    ln = self.line(a)
                    fn = self.name(a) or f"{p:#010x}"
                    n = f"{ln} ({fn.split('+')[0]})" if ln and not ln.split(":")[0].endswith(".h") else fn
                self._sites[p] = n
        return {p: self._sites[p] for p in pcs if p}

    def _addr2line(self, pcs: list[int]) -> dict[int, str]:
        tool = find_addr2line()
        if not tool:
            return {}
        import subprocess
        try:
            res = subprocess.run([tool, "-e", str(self.path), "-f", "-i", "-a", *[hex((p & ~1) - 2) for p in pcs]],
                                 capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            return {}
        out: dict[int, str] = {}
        cur, frames = None, []

        def done():
            if cur is not None and frames:
                # innermost first: the first frame not in a header is the caller's own code
                # (past Zephyr's inline syscall wrappers, but inside its own inlined helpers)
                pick = next((fr for fr in frames if not fr[1].rpartition(":")[0].endswith(".h")), frames[-1])
                fn, loc = pick
                f, _, ln = loc.rpartition(":")
                if f and not f.startswith("??"):
                    out[cur] = f"{f.replace(chr(92), '/').rsplit('/', 1)[-1]}:{ln.split(' ')[0]} ({fn})"
        lines = res.stdout.splitlines()
        i = 0
        while i < len(lines):
            s = lines[i].strip()
            if s.startswith("0x") and (i + 1 >= len(lines) or not lines[i + 1].startswith("0x")):
                done()
                cur, frames = int(s, 16) + 2, []
                i += 1
                continue
            if i + 1 < len(lines):
                frames.append((s, lines[i + 1].strip()))
            i += 2
        done()
        # the queried address was p & ~1 - 2: map back to the pc as recorded
        by_q = {(p & ~1): p for p in pcs}
        return {by_q.get(k, k): v for k, v in out.items()}

    def line(self, addr: int) -> str | None:
        """`file.c:123` for a code address, from the DWARF line table (only the
        compilation unit that holds it is decoded, then kept); None without DWARF."""
        a = addr & ~1
        if a in self._lines_cache:
            return self._lines_cache[a]
        if not self._dwarf_loaded:
            self._dwarf_loaded = True
            self._dwarf_f = open(self.path, "rb")   # kept open: pyelftools reads lazily
            e = ELFFile(self._dwarf_f)
            self._dwarf = e.get_dwarf_info() if e.has_dwarf_info() else None
            self._aranges = self._dwarf.get_aranges() if self._dwarf else None
        out = None
        try:
            if self._aranges is not None:
                off = self._aranges.cu_offset_at_addr(a)
                if off is not None:
                    rows = self._cu_rows.get(off)
                    if rows is None:
                        rows = self._cu_rows[off] = self._line_rows(off)
                    i = bisect.bisect_right(rows, (a, "￿", 1 << 30)) - 1
                    if i >= 0 and rows[i][1]:
                        out = f"{rows[i][1]}:{rows[i][2]}"
        except Exception:  # noqa: BLE001  DWARF this reader does not handle: no line
            out = None
        self._lines_cache[a] = out
        return out

    def _line_rows(self, cu_off: int) -> list[tuple[int, str, int]]:
        cu = self._dwarf.get_CU_at(cu_off)
        lp = self._dwarf.line_program_for_CU(cu)
        if lp is None:
            return []
        files = lp["file_entry"]
        v5 = lp.header["version"] >= 5
        rows = []
        for ent in lp.get_entries():
            s = ent.state
            if s is None or s.end_sequence:
                continue
            k = s.file if v5 else s.file - 1
            name = files[k].name.decode("utf-8", "replace") if 0 <= k < len(files) else ""
            rows.append((s.address, name.replace("\\", "/").rsplit("/", 1)[-1], s.line))
        rows.sort()
        return rows

    def string(self, addr: int, limit: int = 64) -> str | None:
        """A NUL-terminated string in the image (a marker's name, a format)."""
        for vaddr, size, data in self._segments:
            if vaddr <= addr < vaddr + size:
                raw = data[addr - vaddr: min(vaddr + size, addr + limit) - vaddr]
                end = raw.find(b"\0")
                return raw[: end if end >= 0 else len(raw)].decode("utf-8", "replace")
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
