# SPDX-License-Identifier: Apache-2.0
"""The live bridge: decode a target's stream (or replay a recording) and serve
it to the browser over a WebSocket on 127.0.0.1.

To the browser:
- text `{"type": "hello", ...}`: the target and the lanes of the timeline
  (interrupts, then threads by priority); sent at connect and whenever a
  thread or interrupt appears, after which the browser rebuilds its lanes and
  receives the retained timeline again;
- binary timeline batches every 50 ms (`encode_intervals`): runs, ready
  waits, interrupts and drop markers, times in ms from the session start;
- text `{"type": "stats", ...}` once a second of target time: per-thread
  CPU, switches, wake latency, interrupts, event and byte rates, drops and
  zprof's own cost.

Only the last RETAIN_MS of timeline is kept, so a session can run for hours.
"""
from __future__ import annotations

import asyncio
import http
import json
import statistics
import struct
import time
from array import array
from collections import deque
from pathlib import Path

from . import proto as P
from .analyze import CALL_NAMES, CLASS_NAMES, EXC_NAMES, ISR_CTX, Tracker, short_name
from .elf import Elf
from . import thresholds as TH
from .presets import ALL, BY_ID, PRESETS, classes_frame, preset_of
from .sched import JobTracker, analyze, build_model, job_marks, releases
from .stream import Decoder

RETAIN_MS = 12_000
TICK_S = 0.05
SCHED_S = 3.0

# interval codes on the wire; BLOCKED: on a mutex another thread held (contention),
# WAITING: for an event (a semaphore given, a queue filled, a poll), a thread's normal rest
RUN, READY, ISR, DROP, BLOCKED, WAITING = 0, 1, 2, 3, 4, 5


def encode_intervals(t0: list[float], t1: list[float], lane: list[int], code: list[int]) -> bytes:
    """`ZIV1` u32 n | t0 f64[n] | t1 f64[n] | lane u16[n] | code u8[n]: every array aligned for typed-array views."""
    n = len(t0)
    return (b"ZIV1" + struct.pack("<I", n) + array("d", t0).tobytes() + array("d", t1).tobytes()
            + array("H", lane).tobytes() + array("B", code).tobytes())


class LiveSession:
    def __init__(self, elf: Elf | None = None, irq_names: dict[int, str] | None = None,
                 target: str = "", source: str = "live", deadlines: dict | None = None,
                 thresholds: dict | None = None):
        self.elf = elf
        self.irq_names = irq_names or {}
        self.target, self.source = target, source
        self.deadlines = deadlines or {}           # thread name -> {"deadline_us", "release", "why"}
        self.th = thresholds if thresholds is not None else TH.load()
        self.d = Decoder()
        self.d.on_session = self._session
        self.epoch = 0             # a new one after a reboot of the target: the page starts over
        self.link_state = "connecting"
        self.new_status: list[dict] = []
        self.wall_bytes = 0
        # what the target records: the page's choice, applied to every new session
        self.want_classes: int | None = None
        self.to_target = None        # send bytes to the target, while connected
        self._classes_seen: int | None = None
        self._reset_view()

    def _reset_view(self) -> None:
        self.tr: Tracker | None = None
        self.jt: JobTracker | None = None          # jobs and arrivals for the schedulability view
        self.sched_tasks: list | None = None       # the model of the last analysis (what-ifs start from it)
        self.sched_meta: dict = {}
        self.sched_last: str | None = None
        self.keys: list[tuple[str, int]] = []        # lane -> ('i', irq) | ('t', thread)
        self.lane: dict[tuple[str, int], int] = {}
        self.topo_dirty = False
        self.retained: deque[tuple[float, float, tuple[str, int], int]] = deque()
        self.pending: list[tuple[float, float, tuple[str, int], int]] = []
        self.stats_hist: deque[dict] = deque(maxlen=120)  # for clients that connect later
        self.new_stats: list[dict] = []                    # not yet sent
        self._first_hello_sent = False
        self._prev: dict | None = None
        self._win_t0 = 0

    # ------------------------------------------------------------ sessions and the link
    def _session(self, kind: str) -> None:
        """The decoder found a new session's first SYNC (records of the last one, if
        any, are still waiting in it)."""
        self._consume()
        if kind == "reboot":
            # the target's clock went back: a new timeline
            self.epoch += 1
            self._reset_view()
        elif kind == "reconnect":
            self._prev = None  # the statistics window starts again after the gap

    def restart(self) -> None:
        """The connection broke: the next bytes are a new session's."""
        self.d.restart()

    def link(self, state: str, why: str = "") -> None:
        self.link_state = state
        if state != "up":
            self.to_target = None
        self.new_status.append(self._status(why))

    def attach(self, send) -> None:
        """A connection to the target is up: `send(bytes)` reaches it. The chosen
        classes go first (the target starts every session recording all of them)."""
        self.to_target = send
        if self.want_classes is not None:
            send(classes_frame(self.want_classes))

    def set_classes(self, classes: int) -> None:
        """The page chose what the target records; it answers with what it records now."""
        self.want_classes = classes & ALL
        if self.to_target:
            self.to_target(classes_frame(self.want_classes))
        self.new_status.append(self._status())

    def command(self, j: dict) -> list[str]:
        """A message from a page; the answer for that page only (most answers go to
        every page with the next updates). What-ifs are answered by `whatif`."""
        kind = j.get("type")
        if kind == "preset" and j.get("id") in BY_ID and self.source == "live":
            self.set_classes(BY_ID[j["id"]]["classes"])
        elif kind == "classes" and isinstance(j.get("classes"), int) and self.source == "live":
            self.set_classes(j["classes"])
        elif kind == "sched_reset" and self.tr is not None:
            self._new_jobs()
        return []

    # ------------------------------------------------------------ schedulability
    def _new_jobs(self) -> None:
        """A fresh observation (at the first hello, a reboot, or the page's Reset)."""
        self.jt = JobTracker(self.d.hello, self.d.threads, irqs=self.d.irqs,
                             release_by_name=releases(self.deadlines),
                             thread_name=lambda p: self.name(("t", p)),
                             obj_name=lambda a: self.elf.name(a) if self.elf else None,
                             job_marks=job_marks(self.deadlines),
                             mark_name=lambda a: self.elf.string(a) if self.elf else None)

    def sched_model(self) -> tuple[list, dict] | None:
        """The task model as it stands, and what it was observed over (cheap: the
        analysis runs on it elsewhere)."""
        jt = self.jt
        if jt is None or jt.t0 is None:
            return None
        tasks = build_model(jt, lambda p: self.name(("t", p)), self.deadlines,
                            irq_name=lambda i: self.name(("i", i)),
                            site_names=self.elf.call_sites if self.elf else None)
        meta = {"observed_s": (jt.t1 - jt.t0) / (self.d.hello.ts_hz or 1), "gaps": jt.gaps}
        self.sched_tasks, self.sched_meta = tasks, meta
        return tasks, meta

    def sched_message(self, tasks: list, meta: dict, full: bool, overrides: dict | None = None) -> dict:
        out = analyze(tasks, self.th, full=full, overrides=overrides, **meta)
        out["deadlines_src"] = {n: d.get("why", "") for n, d in self.deadlines.items()}
        out["preset"] = preset_of(self.d.hello.classes) if self.d.ready else None
        return out

    def _status(self, why: str = "") -> dict:
        h = self.d.hello
        rec = h.classes if self.d.ready else None
        return {"type": "status", "link": self.link_state, "why": why, "sessions": self.d.sessions,
                "reboots": self.d.reboots, "source": self.source, "target": self.target,
                # recording control: only a live target can be told
                "control": self.source == "live", "presets": PRESETS,
                "classes": rec, "preset": preset_of(rec) if rec is not None else None,
                "want": self.want_classes}

    # ------------------------------------------------------------ input
    def feed(self, data: bytes) -> None:
        self.wall_bytes += len(data)
        self.d.feed(data)
        self._consume()

    def _consume(self) -> None:
        if self.tr is None:
            if not self.d.ready:
                return
            h = self.d.hello
            # Lanes appear with their first interrupt or run, not from the tables: most
            # interrupts with a handler never fire, and many threads sleep for minutes.
            self.tr = Tracker(h, keep=False, on_run=self._run, on_isr=self._isr, on_ready=self._ready,
                              on_block=self._block)
            self._new_jobs()
            self.topo_dirty = True
        if self.d.hello.classes != self._classes_seen:   # a hello, or the target's answer to a change
            self._classes_seen = self.d.hello.classes
            self.new_status.append(self._status())
        recs = self.d.records
        if recs:
            if self._prev is None:
                # totals as they stand, but the window starts at these records: after a
                # reconnect the tracker's last time is the old session's, before the gap
                self._win_t0 = recs[0].t
                self._prev = self._snapshot()
                self._prev["t"] = recs[0].t
            self.tr.feed(recs)
            self.jt.feed(recs)
            for r in recs:
                if r.id == P.EV_OVERFLOW:  # a marker on the lane of the thread that was running
                    k = ("t", r.w[3])
                    self._key(k)
                    self._add(r.t, r.t, k, DROP)
            recs.clear()  # live: nothing kept beyond the tracker's totals and the retained timeline
            if self.tr.t1 - self._win_t0 >= self.d.hello.ts_hz:
                s = self._stats()
                self.stats_hist.append(s)
                self.new_stats.append(s)

    def _key(self, k: tuple[str, int]) -> int:
        i = self.lane.get(k)
        if i is None:
            i = self.lane[k] = len(self.keys)
            self.keys.append(k)
            self.topo_dirty = True
        return i

    def _ms(self, t: int) -> float:
        """The target's time since boot, ms: one timeline across reconnects."""
        return t * 1000.0 / (self.d.hello.ts_hz or 1)

    def _add(self, a: int, b: int, key: tuple[str, int], code: int) -> None:
        iv = (self._ms(a), self._ms(b), key, code)
        self.pending.append(iv)
        self.retained.append(iv)

    def _run(self, th: int, a: int, b: int) -> None:
        self._key(("t", th))
        self._add(a, b, ("t", th), RUN)

    def _isr(self, irq: int, a: int, b: int, depth: int) -> None:
        self._key(("i", irq))
        self._add(a, b, ("i", irq), ISR)

    def _ready(self, th: int, a: int, b: int) -> None:
        if b > a:
            self._key(("t", th))
            self._add(a, b, ("t", th), READY)

    def _block(self, th: int, a: int, b: int, state: int, wq: int) -> None:
        """A thread off the CPU, not ready, until it was made ready again: blocked on a
        mutex (contention; known as one once a mutex call named it, so with the Timing
        or Kernel objects preset), or waiting for an event or a sleep: most threads'
        normal rest. From the scheduler's records, whatever the preset."""
        self._key(("t", th))
        self._add(a, b, ("t", th), BLOCKED if wq and wq in self.tr.mutexes else WAITING)

    def obj_name(self, key: tuple[int, int], u) -> str:
        cls, obj = key
        if cls == P.EV_SLEEP:
            return "ISR" if obj == ISR_CTX else self.name(("t", obj))
        if self.elf:
            if cls == P.EV_WORK and u.handler:  # a work item by its handler
                h = self.elf.name(u.handler)
                if h:
                    return h
            if obj:
                n = self.elf.name(obj)
                if n:
                    return n
        return f"{obj:#010x}"

    # ------------------------------------------------------------ names
    def name(self, k: tuple[str, int], long: bool = False) -> str:
        """Interrupts by their handler's symbol (what the firmware calls them), with
        the chip's name for the line in brackets when `long` and a header was given."""
        kind, v = k
        if kind == "i":
            if v & P.ISR_EXC:
                return EXC_NAMES.get(v & 0xFF, f"exception {v & 0xFF}")
            chip = self.irq_names.get(v)
            i = self.d.irqs.get(v)
            sym = self.elf.name(i.handler) if (i and self.elf) else None
            if sym and chip:
                return f"{sym} ({chip})" if long else sym
            return sym or chip or f"IRQ {v}"
        t = self.d.threads.get(v)
        if t and t.name:
            return t.name
        if self.elf:
            n = self.elf.name(v, exact_only=True)
            if n:
                return n
        return f"{v:#010x}"

    # ------------------------------------------------------------ out
    def hello(self) -> str:
        h = self.d.hello
        # interrupts first (by number), then threads by priority
        order = sorted(range(len(self.keys)), key=lambda i: (
            0 if self.keys[i][0] == "i" else 1,
            self.keys[i][1] if self.keys[i][0] == "i" else
            (self.d.threads[self.keys[i][1]].prio if self.keys[i][1] in self.d.threads else 99)))
        self.keys = [self.keys[i] for i in order]
        self.lane = {k: i for i, k in enumerate(self.keys)}
        # share of the retained window each lane spent running, for the page's colors
        run: dict[tuple[str, int], float] = {}
        for a, b, k, c in self.retained:
            if c in (RUN, ISR):
                run[k] = run.get(k, 0.0) + (b - a)
        span = max(1e-9, (self.retained[-1][1] - self.retained[0][0]) if self.retained else 1.0)
        lanes = []
        for k in self.keys:
            t = self.d.threads.get(k[1]) if k[0] == "t" else None
            lanes.append({"name": self.name(k), "kind": "irq" if k[0] == "i" else "thread",
                          "prio": t.prio if t else None, "sender": k == ("t", h.sender),
                          "idle": bool(t and t.name == "idle"), "cpu_pct": 100 * run.get(k, 0.0) / span})
        elf_ok = None
        if self.elf:
            elf_ok = self.elf.check_build_id(h.build_id) is None
        return json.dumps({
            "type": "hello", "source": self.source, "target": self.target, "kernel": h.kernel,
            "ts_hz": h.ts_hz, "ring_kb": h.ring_bytes // 1024, "hook_ns": round(h.hook_cost * 1e9 / (h.ts_hz or 1)),
            "elf": self.elf.path.name if self.elf else None, "elf_ok": elf_ok, "lanes": lanes,
            "retain_ms": RETAIN_MS, "epoch": self.epoch,
        })

    def _encode(self, ivs) -> bytes:
        t0, t1, ln, cd = [], [], [], []
        for a, b, k, c in ivs:
            i = self.lane.get(k)
            if i is None:
                continue
            t0.append(a); t1.append(b); ln.append(i); cd.append(c)
        return encode_intervals(t0, t1, ln, cd)

    def updates(self) -> list[str | bytes]:
        """What to send every client since the last call; on a topology change,
        a new hello and the whole retained timeline instead."""
        out: list[str | bytes] = [json.dumps(s) for s in self.new_status]
        self.new_status.clear()
        if self.tr is None or self.tr.t0 is None:
            return out
        # The first hello waits for a second of target time, so the lanes of
        # everything that runs regularly exist from the start (each later hello
        # makes the page rebuild its timeline).
        if not self._first_hello_sent:
            if self.tr.t1 - self.tr.t0 < (self.d.hello.ts_hz or 1):
                return out
            self._first_hello_sent = True
        if self.retained:
            newest = self.retained[-1][1]
            while self.retained and self.retained[0][1] < newest - RETAIN_MS:
                self.retained.popleft()
        if self.topo_dirty:
            self.topo_dirty = False
            self.pending.clear()
            out.append(self.hello())
            out.append(self._encode(self.retained))
        elif self.pending:
            out.append(self._encode(self.pending))
            self.pending = []
        out.extend(json.dumps(s) for s in self.new_stats)
        self.new_stats.clear()
        return out

    def snapshot(self) -> list[str | bytes]:
        """Everything a client that connects now needs."""
        status = json.dumps(self._status())
        if self.tr is None or not self._first_hello_sent:
            return [status, json.dumps({"type": "waiting", "target": self.target, "source": self.source})]
        return [status, self.hello(), self._encode(self.retained), *map(json.dumps, self.stats_hist),
                *([self.sched_last] if self.sched_last else [])]

    # ------------------------------------------------------------ statistics
    def _snapshot(self) -> dict:
        tr = self.tr
        return {
            "t": tr.t1, "records": tr.records, "bytes": self.d.bytes_in, "dropped": tr.dropped, "wfi": tr.wfi,
            "run": {p: u.run for p, u in tr.threads.items()},
            "isr_in": {p: u.isr_in for p, u in tr.threads.items()},
            "sw": {p: u.switches_in for p, u in tr.threads.items()},
            "irq": {i: (u.count, u.total) for i, u in tr.irqs.items()},
            "obj": {k: (sum(u.calls.values()), u.blocks, u.without) for k, u in tr.objects.items()},
        }

    def _stats(self) -> dict:
        tr, h, prev = self.tr, self.d.hello, self._prev
        now = self._snapshot()
        span = max(1, now["t"] - prev["t"])
        secs = span / (h.ts_hz or 1)
        us = 1e6 / (h.ts_hz or 1)
        threads = []
        for p, u in tr.threads.items():
            run = now["run"].get(p, 0) - prev["run"].get(p, 0)
            if self.tr.cur == p and self.tr._run_from is not None:
                run += max(0, now["t"] - max(self.tr._run_from, prev["t"]))  # the run in progress
            isr = now["isr_in"].get(p, 0) - prev["isr_in"].get(p, 0)
            sw = now["sw"].get(p, 0) - prev["sw"].get(p, 0)
            lat = [x * us for x in u.wake_lat]
            u.wake_lat.clear()
            k = ("t", p)
            threads.append({
                "lane": self.lane.get(k), "name": self.name(k),
                "prio": self.d.threads[p].prio if p in self.d.threads else None,
                "cpu_pct": 100 * run / span, "net_pct": 100 * (run - isr) / span, "switches_s": sw / secs,
                "wake_mean_us": statistics.mean(lat) if lat else None,
                "wake_p99_us": sorted(lat)[int(0.99 * (len(lat) - 1))] if lat else None,
                "wake_max_us": max(lat) if lat else None,
                "sender": p == h.sender,
            })
        threads.sort(key=lambda x: -x["cpu_pct"])
        irqs = []
        isr_total = 0
        for i, u in tr.irqs.items():
            c0, t0 = prev["irq"].get(i, (0, 0))
            n, tot = u.count - c0, u.total - t0
            isr_total += tot
            k = ("i", i)
            irqs.append({"lane": self.lane.get(k), "name": self.name(k, long=True), "per_s": n / secs,
                         "cpu_pct": 100 * tot / span, "mean_us": tot * us / n if n else None,
                         "max_us": u.win_worst * us})
            u.win_worst = 0
        irqs.sort(key=lambda x: -x["cpu_pct"])
        objects = []
        for k, u in tr.objects.items():
            c0, b0, e0 = prev["obj"].get(k, (0, 0, 0))
            c1, b1, e1 = now["obj"][k]
            spans = u.waits or u.durations
            wsum = sum(spans)
            if c1 - c0 or b1 - b0 or spans:
                calls = ", ".join(f"{CALL_NAMES.get(u.cls, {}).get(c, c)}" for c, _ in u.calls.most_common(3))
                objects.append({
                    "name": short_name(self.obj_name(k, u), 40), "cls": CLASS_NAMES.get(u.cls, "?"), "calls": calls,
                    "calls_s": (c1 - c0) / secs, "blocks_s": (b1 - b0) / secs, "without": e1 - e0,
                    "wait_mean_us": wsum * us / len(spans) if spans else None,
                    "wait_max_us": max(spans) * us if spans else None,
                    # waits that began in the window before count whole: capped at the window
                    "wait_pct": min(100.0, 100 * wsum / span) if u.waits else 0.0,
                    "timer": u.cls == P.EV_TIMER,
                    "contended": u.cls == P.EV_MUTEX and bool(u.waits),
                })
            u.waits.clear()      # live: per window only
            u.durations.clear()
        # contended mutexes first, then by time waited, then by traffic
        objects.sort(key=lambda x: (not x["contended"], -(x["wait_pct"] or 0), -x["calls_s"]))
        recs = now["records"] - prev["records"]
        sender = next((x for x in threads if x["sender"]), None)
        hooks_pct = 100 * recs * h.hook_cost / span if h.hook_cost else 0.0
        idle = next((x for x in threads if x["name"] == "idle"), None)
        self._prev, self._win_t0 = now, now["t"]
        return {
            "type": "stats", "t_ms": self._ms(now["t"]), "secs": secs,
            "busy_pct": 100 - (idle["cpu_pct"] if idle else 0), "isr_pct": 100 * isr_total / span,
            "wfi_pct": 100 * (now["wfi"] - prev["wfi"]) / span,
            "events_s": recs / secs, "kbytes_s": (now["bytes"] - prev["bytes"]) / secs / 1024,
            "dropped": now["dropped"] - prev["dropped"], "dropped_total": now["dropped"],
            "self_pct": (sender["cpu_pct"] if sender else 0) + hooks_pct, "hooks_pct": hooks_pct,
            "threads": threads, "irqs": irqs, "objects": objects[:20],
        }


# ---------------------------------------------------------------- server

def _origin_ok(origin: str | None) -> bool:
    """The page must come from this machine (DNS rebinding guard)."""
    if origin is None:
        return True
    return origin.startswith(("http://127.0.0.1:", "http://localhost:", "http://[::1]:"))


async def serve(session: LiveSession, source_task, ws_port: int) -> None:
    from websockets.asyncio.server import serve as ws_serve

    clients: set = set()

    def check(conn, request):
        if not _origin_ok(request.headers.get("Origin")):
            return conn.respond(http.HTTPStatus.FORBIDDEN, "zprof bridge: pages from this machine only\n")
        return None

    async def handler(ws):
        for m in session.snapshot():
            await ws.send(m)
        clients.add(ws)
        try:
            async for m in ws:
                if not isinstance(m, str):
                    continue
                try:
                    j = json.loads(m)
                except ValueError:
                    continue
                if not isinstance(j, dict):
                    continue
                if j.get("type") == "whatif":
                    # the last model with the page's changes; answered to that page only
                    if session.sched_tasks is not None:
                        out = await asyncio.to_thread(session.sched_message, session.sched_tasks,
                                                      session.sched_meta, True, j.get("overrides") or {})
                        out["req"] = j.get("req")
                        await ws.send(json.dumps(out))
                    continue
                for a in session.command(j):
                    await ws.send(a)
        finally:
            clients.discard(ws)

    async def sched_loop():
        """The schedulability analysis every SCHED_S seconds, off the event loop (about
        0.1 s for the demo's 50 threads and interrupts, room to grow and the order included)."""
        while True:
            await asyncio.sleep(SCHED_S)
            m = session.sched_model()
            if m is None:
                continue
            try:
                out = await asyncio.to_thread(session.sched_message, *m, True)
            except Exception as e:  # noqa: BLE001  an analysis bug must not stop the stream
                print(f"schedulability analysis failed: {type(e).__name__}: {e}", flush=True)
                continue
            msg = json.dumps(out)
            session.sched_last = msg
            for ws in list(clients):
                try:
                    await ws.send(msg)
                except Exception:  # noqa: BLE001
                    clients.discard(ws)

    async def ticker():
        while True:
            await asyncio.sleep(TICK_S)
            msgs = session.updates()
            if not msgs:
                continue
            for ws in list(clients):
                try:
                    for m in msgs:
                        await ws.send(m)
                except Exception:  # noqa: BLE001  a client that went away
                    clients.discard(ws)

    async with ws_serve(handler, "127.0.0.1", ws_port, process_request=check, max_size=None):
        print(f"bridge on ws://127.0.0.1:{ws_port}; open http://127.0.0.1:8781/#target", flush=True)
        await asyncio.gather(source_task, ticker(), sched_loop())


# The target sends a SYNC every 250 ms, so a second-long silence is already
# unusual; this long means the link is gone (a cable out, a switch rebooting).
SILENCE_S = 3.0
# A new connection can wait in the target's backlog while it gives up on the old
# one (a send stalled for 5 s ends a session there).
FIRST_DATA_S = 8.0
CONNECT_S = 5.0


async def from_board(session: LiveSession, host: str, port: int, writer=None) -> None:
    """Stream from the target for as long as the bridge runs: a broken connection
    (closed, reset, silent, unreachable, garbled) is dropped and made again, with
    a back-off of 0.5 s doubling to 5 s. Each new connection is a new session on
    the target; the timeline continues on the target's clock."""
    from .stream import StreamError

    delay, attempts, first = 0.5, 0, True
    while True:
        attempts += 1
        try:
            reader, w = await asyncio.wait_for(asyncio.open_connection(host, port), CONNECT_S)
        except (OSError, asyncio.TimeoutError) as e:
            why = f"cannot reach {host}:{port} ({type(e).__name__}{': ' + str(e) if str(e) else ''})"
            if attempts == 1 or attempts % 10 == 0:
                print(f"{why}; trying again", flush=True)
            session.link("down", why)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)
            continue
        if not first:
            session.restart()
            if writer:
                writer.restart()
        first = False
        print(f"connected to {host}:{port}" + (f" (after {attempts} attempt(s))" if attempts > 1 else ""), flush=True)
        session.link("up")
        session.attach(w.write)
        got = False
        why = ""
        try:
            while True:
                data = await asyncio.wait_for(reader.read(1 << 16), SILENCE_S if got else FIRST_DATA_S)
                if not data:
                    why = "the target closed the connection"
                    break
                if not got:
                    got, delay, attempts = True, 0.5, 0
                if writer:
                    writer.chunk(data)
                session.feed(data)
        except asyncio.TimeoutError:
            why = f"no data for {SILENCE_S if got else FIRST_DATA_S:g} s"
        except (OSError, ConnectionError) as e:
            why = f"{type(e).__name__}: {e}"
        except StreamError as e:
            why = f"bad data: {e}"
        finally:
            w.close()
        print(f"link lost ({why}); reconnecting", flush=True)
        session.link("down", why)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 5.0)


async def from_recording(session: LiveSession, path: str | Path, speed: float, loop: bool) -> None:
    from . import record

    session.link("up")
    while True:
        _, chunks = record.read(path)
        start_wall, start_ns = time.monotonic(), None
        for ns, data in chunks:
            start_ns = start_ns or ns
            due = (ns - start_ns) / 1e9 / speed
            lag = due - (time.monotonic() - start_wall)
            if lag > 0:
                await asyncio.sleep(lag)
            if data:
                session.feed(data)
            else:
                session.restart()  # the recording's link broke here
        if not loop:
            print("recording replayed to its end", flush=True)
            session.link("down", "end of the recording")
            await asyncio.Event().wait()
        # again from the start: its clock goes back, which the page takes as a reboot
        session.restart()
