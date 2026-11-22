# SPDX-License-Identifier: Apache-2.0
"""P3 exit check: zprof's trace against the demo's own counters.

The demo's heartbeat hook (prof.c on the demo's zprof branch) puts gfx_stats()
and audio_get_counters() into every heartbeat, read on the target at a known
trace time. So the trace's own events can be held against them exactly,
beat by beat, without two clocks read at different moments:

  frames   STOP("frame", 1) marks between two heartbeats == the change of gfx.frames
  period   presents in a streak (START after a STOP 1, no idle slot between): their
           median interval against gfx.period_us, and the drops they imply (the
           firmware's rule, account_frame) against the change of gfx.dropped
  margin   at every heartbeat, gfx.margin_min_us is the least frame.margin_us
           plotted since the control port's "reset", and a plotted value
  audio    audio_tid made ready from an interrupt (the DMA's half done, the refill
           semaphore) between two heartbeats == the change of audio.blocks; their
           mean interval, and the DAC rate it gives (128 frames a block)

  python p3check.py --host 192.168.254.86 --secs 20 --elf <zephyr.elf> --demo <stm32n6-demo> [-o rec.zpr]
  python p3check.py rec.zpr [--elf <zephyr.elf>]

Live: records the session (the bridge must not hold it), sends the control port's
"reset" 2 s in, and prints the control port's "stats" and "audio" at the end
beside the last heartbeat. An existing recording checks the margin from its
start if it holds no reset.
"""
from __future__ import annotations

import argparse
import importlib.util
import statistics
import subprocess
import sys
import threading
import time
from bisect import bisect_left
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "host" / "bridge"))

from zprof_bridge import proto as P  # noqa: E402
from zprof_bridge import record  # noqa: E402
from zprof_bridge.elf import Elf  # noqa: E402
from zprof_bridge.stream import EV_SESSION, Decoder  # noqa: E402

INT32_MAX = 2**31 - 1
BLOCK_FRAMES = 128


def s32(v: int) -> int:
    return v - (1 << 32) if v & 0x80000000 else v


def load_ctl(demo: Path):
    spec = importlib.util.spec_from_file_location("ctl", demo / "tools" / "ctl.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def capture(a) -> Path:
    out = Path(a.out or ROOT / "captures" / f"p3check-{time.strftime('%Y%m%d-%H%M%S')}.zpr")
    cmd = [sys.executable, "-m", "zprof_bridge", "capture", "--host", a.host, "--secs", str(a.secs), "-o", str(out)]
    if a.elf:
        cmd += ["--elf", a.elf]
    ctl = load_ctl(Path(a.demo))
    p = subprocess.Popen(cmd, cwd=ROOT / "host" / "bridge")
    readings: dict[str, str] = {}

    def at_two_seconds():
        time.sleep(2.0)
        readings["reset"] = ctl.send(a.host, ["reset"])[0]
    th = threading.Thread(target=at_two_seconds)
    th.start()
    p.wait()
    th.join()
    readings["stats"], readings["audio"] = ctl.send(a.host, ["stats", "audio"])
    ctl.close(a.host)
    print("control port at the end:")
    for k in ("stats", "audio"):
        print(f"  {k}: {readings[k]}")
    if p.returncode:
        sys.exit(f"capture failed ({p.returncode})")
    return out


def check(path: Path, elf: Elf | None) -> bool:
    d = Decoder()
    record.feed_all(path, d)
    h = d.hello
    hz = h.ts_hz or 1
    us = 1e6 / hz
    names = {i: m[0] for i, m in h.metrics.items()}
    th = {t.name: p for p, t in d.threads.items()}
    audio = th.get("audio_tid")
    string = (lambda a: elf.string(a)) if elf else (lambda a: None)
    frame_name = None

    beats: list[tuple[int, dict]] = []       # (time of its first METRIC record, name -> value)
    stops: list[int] = []                    # STOP("frame", 1)
    idle: list[int] = []                     # STOP("frame", 0)
    presents: list[tuple[int, bool]] = []    # (START after a STOP 1, a streak)
    plots: list[tuple[int, int]] = []
    readies: list[int] = []
    depth = 0
    last_stop = None
    streak = False
    prev_idx = None
    sessions = 0
    for r in d.records:
        rid = r.id
        if rid == EV_SESSION:
            sessions += 1
            if sessions > 1:
                print("the recording spans more than one session: checking the first only")
                break
            continue
        if rid == P.EV_METRIC:
            if prev_idx is None or r.arg <= prev_idx:
                beats.append((r.t, {}))
            beats[-1][1][names.get(r.arg, r.arg)] = r.w[0]
            prev_idx = r.arg        # a beat ends where the index starts again (an interrupt may come between)
            continue
        if rid == P.EV_ISR_ENTER:
            depth += 1
        elif rid == P.EV_ISR_EXIT:
            depth = max(0, depth - 1)
        elif rid == P.EV_READY and depth and r.w[0] == audio:
            readies.append(r.t)
        elif rid in (P.EV_MARK_START, P.EV_MARK_STOP):
            if frame_name is None and string(r.w[0]) == "frame":
                frame_name = r.w[0]
            if r.w[0] != frame_name:
                continue
            if rid == P.EV_MARK_STOP:
                if r.w[1]:
                    stops.append(r.t)
                    last_stop = r.t
                else:
                    idle.append(r.t)
                    streak = False
                    last_stop = None
            elif last_stop is not None:
                presents.append((r.t, streak))
                streak = True
                last_stop = None
        elif rid == P.EV_PLOT and string(r.w[0]) == "frame.margin_us":
            plots.append((r.t, s32(r.w[1])))
    ok = True
    if len(beats) < 3 or frame_name is None:
        print(f"not enough to check: {len(beats)} heartbeats, frame marks {'found' if frame_name else 'not found'}"
              f"{'' if elf else ' (no ELF: mark and plot names unknown)'}")
        return False
    b0, b1 = beats[0][0], beats[-1][0]
    secs = (b1 - b0) / hz
    print(f"{path.name}: {secs:.1f} s between the first and last of {len(beats)} heartbeats, "
          f"{len(d.records):,} records, {d.dropped if hasattr(d, 'dropped') else 0} lost")

    # frames: marks between consecutive heartbeats against the change of gfx.frames
    def count(ts: list[int], lo: int, hi: int) -> int:
        return bisect_left(ts, hi) - bisect_left(ts, lo)
    worst = 0
    for (ta, va), (tb, vb) in zip(beats, beats[1:]):
        worst = max(worst, abs(count(stops, ta, tb) - (vb["gfx.frames"] - va["gfx.frames"])))
    m_tot = count(stops, b0, b1)
    f_tot = beats[-1][1]["gfx.frames"] - beats[0][1]["gfx.frames"]
    good = abs(m_tot - f_tot) <= 2 and worst <= 2
    ok &= good
    print(f"frames : {m_tot} frame marks, gfx.frames +{f_tot} ({f_tot / secs:.2f}/s); "
          f"worst heartbeat {worst} apart -> {'ok' if good else 'MISMATCH'}")

    # period and drops: presents in a streak
    period = beats[-1][1]["gfx.period_us"]
    iv = [(t - pt) * us for (pt, _), (t, s) in zip(presents, presents[1:]) if s and b0 <= pt and t < b1]
    drops = sum(int((x + period / 2) // period) - 1 for x in iv if x > period + period / 2)
    d_tot = s32(beats[-1][1]["gfx.dropped"]) - s32(beats[0][1]["gfx.dropped"])
    if not iv:
        # a 30 fps clip shows a frame every second refresh: an idle slot after each, never a streak
        good = d_tot == 0
        ok &= good
        print(f"period : no presents in a streak (no consecutive frames): not checked; gfx.dropped +{d_tot}"
              f" -> {'ok' if good else 'MISMATCH'}")
    else:
        med = statistics.median(iv)
        good = abs(med - period) <= period * 0.005 and drops == d_tot
        ok &= good
        print(f"period : median {med:.1f} us between {len(iv)} presents in a streak, gfx.period_us {period}; "
              f"{drops} drops by the firmware's rule, gfx.dropped +{d_tot} -> {'ok' if good else 'MISMATCH'}")

    # margin: the gauge is the least plotted margin since the reset
    gauge = [s32(v["gfx.margin_min_us"]) for _, v in beats]
    start = 0
    for i in range(1, len(beats)):
        if gauge[i] > gauge[i - 1]:
            start = i               # a reset between beat i-1 and beat i
    seg_b = beats[start][0]          # plots from here on are certainly after it
    pts = [t for t, _ in plots]
    bad = 0
    checked = 0
    for j in range(start + 1, len(beats)):
        bj = beats[j][0]
        later = [v for t, v in plots[bisect_left(pts, seg_b):bisect_left(pts, bj)]]
        if later and gauge[j] != INT32_MAX:
            checked += 1
            # (a) no smaller margin plotted since the reset (the last one may follow the sampling)
            if min(later[:-1] or [INT32_MAX]) < gauge[j]:
                bad += 1
                continue
            # (b) the value was plotted: from two heartbeats back on (or since the beat before the reset)
            lo = beats[max(start - 1, j - 2, 0)][0]
            if gauge[j] != gauge[j - 1] or j == start + 1:
                if gauge[j] not in [v for t, v in plots[bisect_left(pts, lo):bisect_left(pts, bj)]]:
                    bad += 1
    least = min((v for t, v in plots if t >= seg_b), default=None)
    if least is None:
        # no frame in a streak since the reset: the firmware keeps INT32_MAX, nothing was plotted
        good = gauge[-1] == INT32_MAX or start == 0
        ok &= good
        print(f"margin : nothing plotted since {'the reset' if start else 'the start'} (no consecutive frames): "
              f"not checked; gfx.margin_min_us {'unset' if gauge[-1] == INT32_MAX else gauge[-1]}"
              f" -> {'ok' if good else 'MISMATCH'}")
    else:
        good = checked > 0 and bad == 0
        ok &= good
        print(f"margin : {'a reset at heartbeat ' + str(start) if start else 'no reset in the recording'}; "
              f"gfx.margin_min_us {gauge[-1]}, least plotted since {least}; {checked} heartbeats checked, "
              f"{bad} wrong -> {'ok' if good else 'MISMATCH'}")

    # audio: refills against the DAC's blocks
    if audio is None:
        print("audio  : no audio_tid thread in the hello")
        return False
    worst = 0
    for (ta, va), (tb, vb) in zip(beats, beats[1:]):
        worst = max(worst, abs(count(readies, ta, tb) - (vb["audio.blocks"] - va["audio.blocks"])))
    r_tot = count(readies, b0, b1)
    a_tot = beats[-1][1]["audio.blocks"] - beats[0][1]["audio.blocks"]
    ri = [(b - a) * us for a, b in zip(readies, readies[1:]) if b0 <= a and b < b1]
    mean = statistics.fmean(ri) if ri else float("nan")
    expect = secs * 1e6 / a_tot if a_tot else float("nan")
    good = abs(r_tot - a_tot) <= 2 and worst <= 2 and abs(mean - expect) <= expect * 0.002
    ok &= good
    under = s32(beats[-1][1]["audio.underruns"]) - s32(beats[0][1]["audio.underruns"])
    print(f"audio  : {r_tot} refill wakeups, audio.blocks +{a_tot}; worst heartbeat {worst} apart; "
          f"interval mean {mean:.1f} us (min {min(ri):.1f}, max {max(ri):.1f}), {expect:.1f} us from the "
          f"blocks -> DAC {BLOCK_FRAMES * a_tot / secs:.0f} Hz; underruns +{under} -> {'ok' if good else 'MISMATCH'}")
    print("PASS" if ok else "FAIL")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording", nargs="?")
    ap.add_argument("--host")
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--elf")
    ap.add_argument("--demo", help="the stm32n6-demo checkout (its tools/ctl.py sends the reset)")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    a.elf = str(Path(a.elf).resolve()) if a.elf else None      # the capture runs from the bridge's folder
    a.out = str(Path(a.out).resolve()) if a.out else None
    if a.recording:
        path = Path(a.recording)
        elf_path = a.elf or record.read(path)[0].get("elf")
    elif a.host and a.demo:
        path = capture(a)
        elf_path = a.elf
    else:
        ap.error("a recording, or --host and --demo to make one")
    elf = Elf(elf_path) if elf_path and Path(elf_path).exists() else None
    sys.exit(0 if check(path, elf) else 1)


if __name__ == "__main__":
    main()
