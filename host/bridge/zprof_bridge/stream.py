# SPDX-License-Identifier: Apache-2.0
"""Decode a zprof byte stream (docs/PROTOCOL.md): preamble, frames, the hello
and thread tables on the control channel, trace records on the trace channel.

Feed it bytes as they arrive (`feed`); it keeps what it has decoded:
`hello`, `threads` (pointer -> Thread), `irqs` (number -> Irq) and `records`
(Record with the timestamp unwrapped to 64 bits). Frame sequence numbers are
checked per channel; ring drops arrive as OVERFLOW records.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

from . import fault
from . import proto as P


# Not from the target: the decoder's marker at the start of each session (arg: index in SESSION_KINDS).
EV_SESSION = 0x100
SESSION_KINDS = ("first", "reconnect", "reboot")


@dataclass
class Thread:
    ptr: int
    prio: int
    entry: int
    stack_start: int
    stack_size: int
    name: str


@dataclass
class Irq:
    irq: int
    prio: int
    enabled: bool
    handler: int
    arg: int


@dataclass
class Record:
    t: int              # timestamp, unwrapped to 64 bits (timestamp clock cycles)
    id: int
    arg: int
    w: tuple[int, ...]  # payload words


@dataclass
class Hello:
    proto: int = 0
    kernel: str = ""
    build_id: bytes = b""
    build_id_addr: int = 0
    ts_hz: int = 0
    kcyc_hz: int = 0
    ts_source: int = 0
    ring_bytes: int = 0
    sender: int = 0
    hook_cost: int = 0  # timestamp ticks per hook, measured by the target at connect
    classes: int = 0xFF  # kernel-object classes the target records (bit = id - OBJ_FIRST); its answer to a change too
    metrics: dict = field(default_factory=dict)   # index -> (name, kind, unit): the heartbeat's dictionary
    # capture-then-upload: state (CAP_*), bytes held, capacity (0: none), ms recorded; the last report
    capture: tuple = (0, 0, 0, 0)
    # the flight recorder (REC_*): state, ms kept after a trigger, triggers since boot, bytes held
    recorder: tuple = (0, 0, 0, 0)
    # the PMU: the four Arm event numbers counted (empty: none), flags (PMU_F_*), its AUTHSTATUS
    pmu_events: tuple = ()
    pmu_flags: int = 0
    pmu_auth: int = 0
    # the protocol analyzer: buses recorded now and those the build can record (PROTO_*)
    proto: int = 0
    proto_avail: int = 0
    # threads the target's fault handler ended: faults since boot, the last ones
    # (uptime ms, reason, thread name), newest first
    fault_count: int = 0
    fault_log: list = field(default_factory=list)


class StreamError(Exception):
    pass


@dataclass
class Decoder:
    hello: Hello = field(default_factory=Hello)
    threads: dict[int, Thread] = field(default_factory=dict)
    irqs: dict[int, Irq] = field(default_factory=dict)
    records: list[Record] = field(default_factory=list)
    seq_gaps: int = 0
    frames: int = 0
    bytes_in: int = 0

    sessions: int = 0   # sessions seen (a reconnect starts a new one)
    reboots: int = 0    # sessions that began with the target's clock behind the last one

    def __post_init__(self) -> None:
        self._buf = bytearray()
        self._pending_threads: dict[int, Thread] = {}
        self._hello_done = False
        self._last_abs: int | None = None
        self.on_session = None  # callback(kind): 'first', 'reconnect' or 'reboot', at its first SYNC
        self.on_capture = None  # callback((state, bytes, capacity, ms)): a capture status from the target
        self.on_recorder = None  # callback((state, post_ms, triggers, held)): the flight recorder's status
        self.on_fault = None     # callback(fault.Fault): a fault record from the target
        self.faults: list = []   # every fault record received (fault.Fault)
        self._reset_session()

    def _reset_session(self) -> None:
        """Per-session state: a new connection starts over with a preamble, and its
        timestamps are anchored again at its first SYNC."""
        self._pre = False
        self._seq: dict[int, int] = {}
        self._t_last32: int | None = None
        self._t64 = 0                                # unwrapped, this session's own count
        self._sync: tuple[int, int] | None = None    # (t64, kernel cycles) of the last SYNC
        self._offset: int | None = None              # session count -> target time since boot
        self._held: list[Record] = []                # records before the session's first SYNC

    def restart(self) -> None:
        """The byte stream broke (a reconnect): drop any half frame, expect a preamble."""
        self._buf.clear()
        self._reset_session()

    # ------------------------------------------------------------ input
    def feed(self, data: bytes) -> None:
        self.bytes_in += len(data)
        self._buf += data
        b = self._buf
        at = 0
        while True:
            if not self._pre:
                if len(b) - at < 8:
                    break
                if bytes(b[at:at + 4]) != P.MAGIC:
                    raise StreamError(f"not a zprof stream: {bytes(b[at:at + 8])!r}")
                self.hello.proto = struct.unpack_from("<H", b, at + 4)[0]
                if self.hello.proto != P.PROTO_VERSION:
                    raise StreamError(f"protocol {self.hello.proto}, this bridge speaks {P.PROTO_VERSION}")
                self._pre = True
                self.sessions += 1
                at += 8
            more = self._step(b, at)  # True: a new session's preamble at self._at
            at = self._at
            if not more:
                break
        del b[:at]

    def _step(self, b: bytearray, at: int) -> bool:
        """Decode the frames from `at`; False when more bytes are needed. A preamble
        where a frame should start is a new session in the same stream."""
        while len(b) - at >= P.FRAME_HDR:
            if bytes(b[at:at + 4]) == P.MAGIC:
                self._reset_session()
                self._at = at
                return True
            ch, _flags, seq, n = struct.unpack_from("<BBHI", b, at)
            if len(b) - at - P.FRAME_HDR < n:
                break
            payload = bytes(b[at + P.FRAME_HDR: at + P.FRAME_HDR + n])
            self._frame(ch, seq, payload)
            at += P.FRAME_HDR + n
        self._at = at
        return False

    # ------------------------------------------------------------ frames
    def _frame(self, ch: int, seq: int, p: memoryview) -> None:
        self.frames += 1
        want = self._seq.get(ch)
        if want is not None and seq != want:
            self.seq_gaps += 1
        self._seq[ch] = (seq + 1) & 0xFFFF
        if ch == P.CH_CONTROL:
            self._control(p)
        elif ch == P.CH_TRACE:
            self._trace(p)

    def _control(self, p: memoryview) -> None:
        at = 0
        h = self.hello
        while at + 4 <= len(p):
            tag, n = struct.unpack_from("<HH", p, at)
            v = bytes(p[at + 4: at + 4 + n])
            at += 4 + n
            if tag == P.HT_PROTO:
                h.proto = struct.unpack_from("<H", v)[0]
            elif tag == P.HT_KERNEL:
                h.kernel = v.decode("ascii", "replace")
            elif tag == P.HT_BUILD_ID:
                h.build_id, h.build_id_addr = v[:16], struct.unpack_from("<I", v, 16)[0]
            elif tag == P.HT_CLOCKS:
                h.ts_hz, h.kcyc_hz, h.ts_source = struct.unpack_from("<III", v)
            elif tag == P.HT_RING:
                h.ring_bytes = struct.unpack_from("<I", v)[0]
            elif tag == P.HT_SENDER:
                h.sender = struct.unpack_from("<I", v)[0]
            elif tag == P.HT_HOOK_COST:
                h.hook_cost = struct.unpack_from("<I", v)[0]
            elif tag == P.HT_CLASSES:
                h.classes = struct.unpack_from("<I", v)[0]
            elif tag == P.HT_METRIC:
                idx, kind = struct.unpack_from("<HB", v)
                name, _, unit = v[4:].partition(b"\0")
                h.metrics[idx] = (name.decode("utf-8", "replace"), kind, unit.decode("utf-8", "replace"))
            elif tag == P.HT_CAPTURE:
                h.capture = struct.unpack_from("<IIII", v)
                if self.on_capture:
                    self.on_capture(h.capture)
            elif tag == P.HT_RECORDER:
                was = h.recorder[0]
                h.recorder = struct.unpack_from("<IIII", v)
                if was == P.REC_HELD and h.recorder[0] != P.REC_HELD:
                    # the held flight recording has been sent; the live stream that
                    # follows is anchored afresh at its first SYNC, behind a session
                    # marker (a run in flight at the freeze must not span the gap)
                    self._t_last32 = None
                    self._sync = None
                    self._offset = None
                if self.on_recorder:
                    self.on_recorder(h.recorder)
            elif tag == P.HT_FAULT_LOG:
                h.fault_count = struct.unpack_from("<I", v)[0]
                h.fault_log = [(up, reason, name.split(b"\0", 1)[0].decode("utf-8", "replace"))
                               for up, reason, name in struct.iter_unpack("<II16s", v[4:])]
            elif tag == P.HT_PROTO:
                h.proto, h.proto_avail = struct.unpack_from("<II", v)
            elif tag == P.HT_FAULT:
                f = fault.parse(v)
                # every hello carries the fault the target holds: once is enough
                if f is not None and not any(g.uptime_ms == f.uptime_ms and g.thread == f.thread
                                             for g in self.faults):
                    self.faults.append(f)
                    if self.on_fault:
                        self.on_fault(f)
            elif tag == P.HT_PMU:
                *ev, h.pmu_flags, h.pmu_auth = struct.unpack_from("<HHHHII", v)
                h.pmu_events = tuple(ev)
            elif tag == P.HT_IRQ:
                irq, prio, en, handler, arg = struct.unpack_from("<HBBII", v)
                self.irqs[irq] = Irq(irq, prio, bool(en), handler, arg)
            elif tag == P.HT_THREAD:
                ptr, prio, entry, start, size = struct.unpack_from("<IiIII", v)
                name = v[20:].decode("utf-8", "replace")
                self._pending_threads[ptr] = Thread(ptr, prio, entry, start, size, name)
            elif tag == P.HT_END:
                # a complete thread table: replace, but keep threads seen before
                # (they may have ended; their records still name them)
                self.threads.update(self._pending_threads)
                self._pending_threads = {}
                self._hello_done = True

    def _trace(self, p: memoryview) -> None:
        n = len(p) // 4
        words = struct.unpack_from(f"<{n}I", p)
        i = 0
        recs = self.records
        while i + 2 <= n:
            ts, w1 = words[i], words[i + 1]
            rid, nw, arg = w1 & 0xFF, (w1 >> 8) & 0xF, w1 >> 16
            if i + 2 + nw > n:
                raise StreamError("a record cut by its frame")
            w = words[i + 2: i + 2 + nw]
            # unwrap: records are in time order and SYNC comes every 250 ms
            if self._t_last32 is None:
                self._t64 = ts
            else:
                self._t64 += (ts - self._t_last32) & 0xFFFFFFFF
            if rid == P.EV_OVERFLOW and self._sync is not None and nw >= 3:
                # after a gap the 32-bit stamp may have wrapped more than once:
                # take the wrap the kernel's 64-bit count says it is
                t_sync, kc_sync = self._sync
                kc = w[1] | (w[2] << 32)
                h = self.hello
                expect = t_sync + (kc - kc_sync) * (h.ts_hz or 1) // (h.kcyc_hz or 1)
                k = round((expect - ts) / 2**32)
                self._t64 = ts + k * 2**32
            if rid == P.EV_SYNC and nw >= 2:
                kc = w[0] | (w[1] << 32)
                if self._sync is not None:
                    # after a gap (a flight recording sent ahead of the live stream, a
                    # long silence) the 32-bit stamp may have wrapped more than once:
                    # the wrap the kernel's 64-bit count says, as at an OVERFLOW
                    t_sync, kc_sync = self._sync
                    h = self.hello
                    expect = t_sync + (kc - kc_sync) * (h.ts_hz or 1) // (h.kcyc_hz or 1)
                    self._t64 = ts + round((expect - ts) / 2**32) * 2**32
                self._sync = (self._t64, kc)
                if self._offset is None:
                    self._anchor(kc)
            self._t_last32 = ts
            if self._offset is None:
                self._held.append(Record(self._t64, rid, arg, w))
                if len(self._held) > 200_000:  # a target that never sends SYNC: session time
                    self._offset = 0
                    self._flush_held()
            else:
                t = self._t64 + self._offset
                recs.append(Record(t, rid, arg, w))
                self._last_abs = t
            i += 2 + nw

    def _anchor(self, kc: int) -> None:
        """Times from here on are the target's time since boot (in timestamp ticks),
        so a reconnect continues the same timeline. The first SYNC of a session gives it."""
        h = self.hello
        abs_sync = kc * (h.ts_hz or 1) // (h.kcyc_hz or 1)
        kind = "first"
        if self._last_abs is not None:
            kind = "reboot" if abs_sync < self._last_abs else "reconnect"
            if kind == "reboot":
                self.reboots += 1
        self._offset = abs_sync - self._t64
        if self.on_session:
            self.on_session(kind)
        # a marker before the session's records: whatever was in flight when the
        # last one broke (a thread's run, an interrupt) must not span the gap
        t0 = (self._held[0].t + self._offset) if self._held else abs_sync
        self.records.append(Record(t0, EV_SESSION, SESSION_KINDS.index(kind), ()))
        self._flush_held()

    def _flush_held(self) -> None:
        for r in self._held:
            r.t += self._offset
            self.records.append(r)
        if self._held:
            self._last_abs = self._held[-1].t
        self._held = []

    @property
    def ready(self) -> bool:
        return self._hello_done
