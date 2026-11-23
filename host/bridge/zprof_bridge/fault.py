# SPDX-License-Identifier: Apache-2.0
"""A fault record from the target (HT_FAULT, firmware/zprof/src/fault.c): parsed,
checked and described, with the code addresses named from the ELF."""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

from . import proto as P

WORDS = 48

# Zephyr's k_fatal_error_reason (fatal_types.h), then the Arm ones from K_ERR_ARCH_START
# (arch/arm/arch.h, v4.4.0)
REASONS = {0: "CPU exception", 1: "spurious interrupt", 2: "stack overflow (stack check)",
           3: "kernel oops", 4: "kernel panic"}
_ARM = ["MemManage", "MemManage: stacking", "MemManage: unstacking", "MemManage: data access",
        "MemManage: instruction access", "MemManage: FP lazy state",
        "BusFault", "BusFault: stacking", "BusFault: unstacking", "BusFault: precise data bus",
        "BusFault: imprecise data bus", "BusFault: instruction bus", "BusFault: FP lazy state",
        "UsageFault", "UsageFault: divide by zero", "UsageFault: unaligned access",
        "UsageFault: stack overflow", "UsageFault: no coprocessor", "UsageFault: illegal EXC_RETURN",
        "UsageFault: illegal EPSR", "UsageFault: undefined instruction",
        "SecureFault", "SecureFault: entry point", "SecureFault: integrity signature",
        "SecureFault: exception return", "SecureFault: attribution unit", "SecureFault: transition",
        "SecureFault: lazy state preservation", "SecureFault: lazy state error"]
REASONS.update({16 + i: n for i, n in enumerate(_ARM)})


@dataclass
class Fault:
    build_id: bytes
    uptime_ms: int
    reason: int
    flags: int
    thread: int
    name: str
    r: tuple          # r0-r3, r12, lr, pc, xpsr
    callee: tuple     # r4-r11, psp
    msp: int
    exc_return: int
    hfsr: int
    mmfar: int
    bfar: int
    sfar: int
    frames: tuple
    ts: int
    crc_ok: bool

    @property
    def pc(self) -> int:
        return self.r[6]

    @property
    def lr(self) -> int:
        return self.r[5]

    @property
    def reason_name(self) -> str:
        return REASONS.get(self.reason, f"reason {self.reason}")

    @property
    def halted(self) -> bool:
        return bool(self.flags & P.FAULT_F_HALTED)


def parse(v: bytes) -> Fault | None:
    """The record, or None when it is not one (a wrong magic or length)."""
    if len(v) < WORDS * 4:
        return None
    w = struct.unpack_from(f"<{WORDS}I", v)
    if w[0] != P.FAULT_MAGIC or w[1] != WORDS:
        return None
    name = v[40:56].split(b"\0", 1)[0].decode("utf-8", "replace")
    crc = zlib.crc32(v[: (WORDS - 1) * 4]) & 0xFFFFFFFF
    nframes = min(w[37], 8)
    return Fault(build_id=v[8:24], uptime_ms=w[6], reason=w[7], flags=w[8], thread=w[9], name=name,
                 r=tuple(w[14:22]), callee=tuple(w[22:31]), msp=w[31], exc_return=w[32],
                 hfsr=w[33], mmfar=w[34], bfar=w[35], sfar=w[36], frames=tuple(w[38:38 + nframes]),
                 ts=w[46], crc_ok=crc == w[47])


def describe(f: Fault, elf=None) -> list[str]:
    """The fault as text: what, where, the call trace named from the ELF."""
    where = "an interrupt" if f.flags & P.FAULT_F_ISR else f"thread {f.name or '?'} ({f.thread:#010x})"
    after = ("zprof's handler halted the system" if f.halted
             else "the kernel ended the thread; the rest ran on" if f.flags & P.FAULT_F_RAN_ON
             else "the application's own handler decided what followed")
    out = [f"FAULT    {f.reason_name} in {where}, {f.uptime_ms / 1000:.3f} s after boot: {after}"]
    if not f.crc_ok:
        out.append("         (the record's CRC does not match: it may be damaged)")
    if elf is not None:
        why = elf.check_build_id(f.build_id)
        if why is not None:
            out.append(f"         (ELF mismatch: {why}; the names below may be wrong)")

    def at(addr: int) -> str:
        if elf is None:
            return f"{addr:#010x}"
        a = addr & ~1
        ln, fn = elf.line(a), elf.name(a)
        return f"{addr:#010x} {fn or '?'}" + (f" ({ln})" if ln else "")

    out.append(f"pc       {at(f.pc)}")
    out.append(f"lr       {at(f.lr)}")
    frames = list(f.frames)
    if elf is not None:
        # the unwinder can run past a thread's entry into unused stack (0xaaaaaaaa,
        # the stack fill): the trace ends at the first address that is not code
        for i, a in enumerate(frames):
            if elf.name(a & ~1) is None:
                frames = frames[:i]
                break
    if frames:
        out.append("trace")
        sites = elf.call_sites(frames[1:]) if elf is not None else {}
        for i, a in enumerate(frames):
            out.append(f"  #{i}  {at(a)}" if i == 0 else f"  #{i}  {a:#010x} {sites.get(a, '')}")
    elif f.flags & P.FAULT_F_NOWALK:
        out.append("trace    none (a stack overflow, a stack pointer outside its stack, or no unwinder)")
    regs = ("r0", "r1", "r2", "r3", "r12", "lr", "pc", "xpsr")
    out.append("regs     " + " ".join(f"{n}={v:08x}" for n, v in zip(regs, f.r)))
    out.append("         " + " ".join(f"r{4 + i}={v:08x}" for i, v in enumerate(f.callee[:8])) +
               f" psp={f.callee[8]:08x} msp={f.msp:08x} exc_return={f.exc_return:08x}")
    out.append(f"         HFSR={f.hfsr:08x} MMFAR={f.mmfar:08x} BFAR={f.bfar:08x} SFAR={f.sfar:08x}"
               "  (the fault status bits were cleared by Zephyr's handler before zprof's)")
    return out
