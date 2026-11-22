# SPDX-License-Identifier: Apache-2.0
"""zprof bridge command line.

  python -m zprof_bridge capture [--host H] [--port 5560] [--secs 10] -o rec.zpr [--elf zephyr.elf]
  python -m zprof_bridge summary rec.zpr [--elf zephyr.elf] [--irq-header device.h]
  python -m zprof_bridge export rec.zpr [-o rec.json] [--elf ...] [--irq-header ...]   (ui.perfetto.dev)
  python -m zprof_bridge serve [--host H | --replay rec.zpr [--speed 1] [--loop]] [--record rec.zpr] [--ws-port 8786]
                               [--deadlines d.json] [--preset sched|timing|objects]
  python -m zprof_bridge sched rec.zpr [--elf ...] [--irq-header ...] [--deadlines d.json]
  python -m zprof_bridge discover

capture records a session to a .zpr file (the stream as received, replayable)
and prints a summary when it ends. summary decodes a recording again. Names
come from the ELF of the build on the board (checked by build id); interrupt
names from a CMSIS device header if given, else from the handlers' symbols.
Run from host/bridge (or with it on PYTHONPATH).
"""
from __future__ import annotations

import argparse
import socket
import sys
import time
from pathlib import Path

from . import link, record
from . import thresholds as TH
from .analyze import Analysis, irq_names_from_header, report
from .elf import Elf
from .presets import BY_ID
from .sched import load_deadlines, sched_report
from .stream import Decoder, StreamError


def _analysis(d: Decoder, a: argparse.Namespace) -> Analysis:
    elf = Elf(a.elf) if a.elf else None
    names = irq_names_from_header(a.irq_header) if a.irq_header else {}
    return Analysis(d, elf, names)


def cmd_discover(a: argparse.Namespace) -> None:
    boards = link.discover()
    if not boards:
        print("no board answered on udp/5557")
    for ip, kv in boards.items():
        print(f"{ip}  prof={kv.get('prof', '(none)')}  fw={kv.get('fw', '?')}")


def cmd_capture(a: argparse.Namespace) -> None:
    host, port = a.host, a.port
    if not host:
        boards = link.discover()
        with_prof = [ip for ip, kv in boards.items() if "prof" in kv]
        host = (with_prof or list(boards) or [None])[0]
        if host is None:
            sys.exit("no board found: give --host")
        if port is None and host in boards and "prof" in boards[host]:
            port = int(boards[host]["prof"])
    port = port or link.DEFAULT_PORT
    meta = {"host": host, "port": port}
    if a.elf:
        meta |= {"elf": str(Path(a.elf).resolve()), "elf_sha256": record.sha256(Path(a.elf))}
    d = Decoder()
    w = record.Writer(a.out, meta)
    s = link.connect(host, port)
    print(f"capturing from {host}:{port} for {a.secs:g} s -> {a.out}")
    t_end = time.time() + a.secs
    try:
        while time.time() < t_end:
            try:
                data = s.recv(1 << 16)
            except socket.timeout:
                continue
            if not data:
                print("the target closed the session")
                break
            w.chunk(data)
            if a.raw:
                d.bytes_in += len(data)
            else:
                d.feed(data)
    except KeyboardInterrupt:
        pass
    finally:
        s.close()
        w.close()
    if a.raw:
        secs = a.secs - max(0.0, t_end - time.time())
        print(f"recorded {d.bytes_in / 1e6:.1f} MB in {secs:.0f} s ({d.bytes_in / secs / 1024:,.0f} KB/s), not decoded")
        return
    print(report(_analysis(d, a)))


def cmd_summary(a: argparse.Namespace) -> None:
    d = Decoder()
    head = record.feed_all(a.recording, d)
    if d.sessions > 1:
        print(f"({d.sessions} sessions: the connection was re-established {d.sessions - 1} time(s)"
              + (f", the target rebooted {d.reboots} time(s): this covers its last boot"
                 if d.reboots else "") + "; the window includes the gaps)")
    elf = a.elf or head.get("elf")
    if elf and not Path(elf).exists():
        print(f"(the recording's ELF {elf} is gone; names from the hello only)")
        elf = None
    a.elf = elf
    print(report(_analysis(d, a)))


def cmd_export(a: argparse.Namespace) -> None:
    from . import perfetto

    d = Decoder()
    head = record.feed_all(a.recording, d)
    elf = a.elf or head.get("elf")
    a.elf = elf if elf and Path(elf).exists() else None
    out = a.out or str(Path(a.recording).with_suffix(".json"))
    n = perfetto.export(_analysis(d, a), out)
    print(f"{out}: {n['slices']:,} slices, {n['threads']} threads, {n['interrupts']} interrupts, "
          f"{n['drops']} drop markers; open it in https://ui.perfetto.dev (the file stays in the browser)")


def cmd_sched(a: argparse.Namespace) -> None:
    """The schedulability analysis of a recording, decoded chunk by chunk (a long one
    does not fit in memory as records)."""
    from .live import LiveSession

    head, chunks = record.read(a.recording)
    elf_path = a.elf or head.get("elf")
    elf = Elf(elf_path) if elf_path and Path(elf_path).exists() else None
    names = irq_names_from_header(a.irq_header) if a.irq_header else {}
    s = LiveSession(elf, names, target=Path(a.recording).name, source="replay",
                    deadlines=load_deadlines(a.deadlines), thresholds=TH.load(a.thresholds))
    for _, data in chunks:
        if data:
            s.feed(data)
        else:
            s.restart()
        s.retained.clear()
        s.pending.clear()
    m = s.sched_model()
    if m is None:
        sys.exit("no jobs in the recording")
    out = s.sched_message(*m, full=True)
    print(sched_report(out))


def cmd_serve(a: argparse.Namespace) -> None:
    import asyncio

    from . import live

    elf_path = a.elf
    if a.replay and not elf_path:
        head, _ = record.read(a.replay)
        elf_path = head.get("elf") if head.get("elf") and Path(head["elf"]).exists() else None
    elf = Elf(elf_path) if elf_path else None
    names = irq_names_from_header(a.irq_header) if a.irq_header else {}
    dl = load_deadlines(a.deadlines)
    th = TH.load(a.thresholds)
    if a.replay:
        s = live.LiveSession(elf, names, target=Path(a.replay).name, source="replay", deadlines=dl, thresholds=th)
        src = live.from_recording(s, a.replay, a.speed, a.loop)
    else:
        host, port = a.host, a.port or link.DEFAULT_PORT
        if not host:
            boards = link.discover()
            host = next((ip for ip, kv in boards.items() if "prof" in kv), next(iter(boards), None))
            if host is None:
                sys.exit("no board found: give --host")
            port = int(boards.get(host, {}).get("prof", port))
        w = None
        if a.record:
            meta = {"host": host, "port": port}
            if elf_path:
                meta |= {"elf": str(Path(elf_path).resolve()), "elf_sha256": record.sha256(Path(elf_path))}
            w = record.Writer(a.record, meta)
        s = live.LiveSession(elf, names, target=f"{host}:{port}", source="live", deadlines=dl, thresholds=th)
        if a.preset:
            s.want_classes = BY_ID[a.preset]["classes"]
        src = live.from_board(s, host, port, w)
    try:
        asyncio.run(live.serve(s, src, a.ws_port))
    except KeyboardInterrupt:
        pass


def main() -> None:
    ap = argparse.ArgumentParser(prog="zprof_bridge", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("discover")
    sp.set_defaults(fn=cmd_discover)
    sp = sub.add_parser("capture")
    sp.add_argument("--host")
    sp.add_argument("--port", type=int)
    sp.add_argument("--secs", type=float, default=10.0)
    sp.add_argument("-o", "--out", required=True)
    sp.add_argument("--elf")
    sp.add_argument("--irq-header")
    sp.add_argument("--raw", action="store_true", help="record only, decode nothing (long sessions)")
    sp.set_defaults(fn=cmd_capture)
    sp = sub.add_parser("summary")
    sp.add_argument("recording")
    sp.add_argument("--elf")
    sp.add_argument("--irq-header")
    sp.set_defaults(fn=cmd_summary)
    sp = sub.add_parser("export", help="Trace Event JSON for ui.perfetto.dev")
    sp.add_argument("recording")
    sp.add_argument("-o", "--out")
    sp.add_argument("--elf")
    sp.add_argument("--irq-header")
    sp.set_defaults(fn=cmd_export)
    sp = sub.add_parser("serve", help="live to the browser over a WebSocket on 127.0.0.1")
    sp.add_argument("--host")
    sp.add_argument("--port", type=int)
    sp.add_argument("--replay", help="serve a .zpr recording instead of a target")
    sp.add_argument("--speed", type=float, default=1.0)
    sp.add_argument("--loop", action="store_true")
    sp.add_argument("--record", help="also record the live session to this .zpr")
    sp.add_argument("--elf")
    sp.add_argument("--irq-header")
    sp.add_argument("--ws-port", type=int, default=8786)
    sp.add_argument("--deadlines", help="threads' deadlines and release objects (JSON); else D = period")
    sp.add_argument("--thresholds", help="thresholds file (default config/zprof.thresholds.json)")
    sp.add_argument("--preset", choices=list(BY_ID), help="what the target records (the page can change it)")
    sp.set_defaults(fn=cmd_serve)
    sp = sub.add_parser("sched", help="schedulability analysis of a recording")
    sp.add_argument("recording")
    sp.add_argument("--elf")
    sp.add_argument("--irq-header")
    sp.add_argument("--deadlines")
    sp.add_argument("--thresholds")
    sp.set_defaults(fn=cmd_sched)
    a = ap.parse_args()
    try:
        a.fn(a)
    except StreamError as e:
        sys.exit(f"stream error: {e}")


if __name__ == "__main__":
    main()
