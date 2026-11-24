# SPDX-License-Identifier: Apache-2.0
"""Spans and PC samples: control frames, decoding (threads, on-CPU time, children),
the summary's sections and the Perfetto export."""
from __future__ import annotations

import json
import struct

from zprof_bridge import perfetto, prof
from zprof_bridge import proto as P
from zprof_bridge.analyze import Analysis, report
from zprof_bridge.stream import Decoder

from pathlib import Path

from test_stream import A, B, HZ, IDLE, SENDER, Enc

US = HZ // 1_000_000
LAYOUT, REFR, LABEL, FRAME, DECK = 0x70001000, 0x70001010, 0x70001020, 0x70001030, 0x70001040


class FakeElf:
    """Names for the test's addresses, as the ELF would give them."""
    path = Path("fake.elf")
    strings = {LAYOUT: "layout", REFR: "lv_refr_now", LABEL: "lv_draw_sw_label", FRAME: "frame",
               DECK: "Flight Deck"}
    funcs = {0x08001000: ("lv_draw_sw_blend", 0x100), 0x08002000: ("lv_draw_sw_label", 0x200),
             0x08003000: ("idle", 0x40)}

    def string(self, a: int) -> str | None:
        return self.strings.get(a)

    def name(self, a: int, exact_only: bool = False) -> str | None:
        for start, (n, size) in self.funcs.items():
            if start <= a < start + size:
                return n if a == start else f"{n}+{a - start:#x}"
        return None

    def function(self, a: int) -> str | None:
        n = self.name(a)
        return n.split("+")[0] if n else None

    def check_build_id(self, _b) -> None:
        return None


def stream() -> Decoder:
    e = Enc()
    e.hello()
    p = e.tlv(P.HT_SPANS, struct.pack("<IIII", 1, 20_000, 23, 80))
    p += e.tlv(P.HT_SAMPLE, struct.pack("<III", 4000, 240, 1))
    p += e.tlv(P.HT_METRIC, struct.pack("<HBB", 0, P.KIND_COUNTER, 0) + b"zprof.spans\0spans")
    p += e.tlv(P.HT_METRIC, struct.pack("<HBB", 1, P.KIND_COUNTER, 0) + b"zprof.spans_left_out\0spans")
    e.frame(P.CH_CONTROL, p)
    r = Enc.rec
    tr = Enc.sync(0)
    tr += r(0, P.EV_METRIC, 0, 4)
    tr += r(0, P.EV_METRIC, 1, 96)          # 100 spans in all: 100 x 100 ns over 2 ms = 0.5 %
    tr += r(0, P.EV_SWITCH_IN, 0, A)
    tr += r(10 * US, P.EV_MARK_START, 0, FRAME)
    # A: refr 100..1100 us containing layout 150..450 us; B preempts A 500..700 us
    tr += r(60 * US, P.EV_SPAN, 0, DECK, 30 * US)                # the switch, in the frame before the refresh
    tr += r(450 * US, P.EV_SPAN, 1, LAYOUT, 300 * US)
    tr += r(500 * US, P.EV_SWITCH_OUT, 0x80, A, 0)
    tr += r(500 * US, P.EV_SWITCH_IN, 0, B)
    tr += r(600 * US, P.EV_SAMPLE, 0, 0x08001010, 0x08002021, B)
    tr += r(700 * US, P.EV_SWITCH_OUT, 0, B, 0)
    tr += r(700 * US, P.EV_SWITCH_IN, 0, A)
    tr += r(800 * US, P.EV_SAMPLE, 0, 0x08001020, 0x08002041, A)
    tr += r(900 * US, P.EV_SAMPLE, 16 + 33, 0x08001030, 0, A)    # in an interrupt
    tr += r(1000 * US, P.EV_SPAN, 2, LABEL, 150 * US)
    tr += r(1100 * US, P.EV_SPAN, 0, REFR, 1000 * US)
    tr += r(1200 * US, P.EV_MARK_STOP, 0, FRAME, 1)
    tr += r(1300 * US, P.EV_SAMPLE, 0, 0x08003004, 0x08003001, IDLE)
    tr += r(2000 * US, P.EV_SWITCH_OUT, 0, A, 0)
    tr += r(2000 * US, P.EV_SWITCH_IN, 0, SENDER)
    e.frame(P.CH_TRACE, tr)
    d = Decoder()
    d.feed(bytes(e.out))
    return d


def test_control_frames() -> None:
    tag, ln, on, ns, depth = struct.unpack_from("<HHIII", prof.spans_frame(True, 12.5, 6), 8)
    assert (tag, ln, on, ns, depth) == (P.CT_SPANS, 12, 1, 12_500, 6)
    tag, ln, hz = struct.unpack_from("<HHI", prof.sample_frame(4000), 8)
    assert (tag, ln, hz) == (P.CT_SAMPLE, 4, 4000)
    assert prof.spans_arg("20") == (20.0, 23) and prof.spans_arg("5,4") == (5.0, 4)


def test_hello_reports_spans_and_sampling() -> None:
    h = stream().hello
    assert h.spans == (1, 20_000, 23, 80) and h.sample == (4000, 240, 1)


def test_spans_threads_cpu_and_children() -> None:
    an = Analysis(stream(), FakeElf())
    spans, samples = prof.decode(an)
    by = {s.name: s for s in spans}
    refr, layout, label = by["lv_refr_now"], by["layout"], by["lv_draw_sw_label"]
    assert refr.t1 - refr.t0 == 1000 * US and refr.thread == A
    assert refr.cpu == 800 * US                       # B ran 200 us inside it
    assert refr.child == 450 * US                     # layout and the label, both directly inside
    assert layout.depth == 1 and label.depth == 2
    assert [s.exc for s in samples] == [0, 0, 49, 0]
    assert [s.thread for s in samples] == [B, A, A, IDLE]
    assert {prof.func(an, s.pc) for s in samples} == {"lv_draw_sw_blend", "idle"}


def test_summary_sections() -> None:
    text = report(Analysis(stream(), FakeElf()))
    assert "spans    4 recorded (kept: at least 20 us, levels 0 to 23; 96 shorter or deeper left out" in text
    assert "their hooks: 100 spans x 100 ns" in text and "= 0.50 % of the CPU" in text
    row = next(l for l in text.splitlines() if l.strip().startswith("lv_refr_now"))
    assert " 80.0% " in row                           # on CPU
    assert "PC samples  4" in text and "4,000 Hz asked" in text and "handler 0.30 us" in text
    blend = next(l for l in text.splitlines() if l.strip().startswith("lv_draw_sw_blend"))
    assert "lv_draw_sw_label" in blend                # the leaf's caller, from LR
    assert "1 in idle" in text
    assert "longest of 1 'frame' jobs" in text and "lv_refr_now" in text.split("longest of")[1]


def test_frames_with_a_span_and_their_composition() -> None:
    an = Analysis(stream(), FakeElf())
    an.prof_opts = {"frames": 1, "frames_with": "Flight Deck", "frame_us": 100.0}
    text = report(an)
    assert "frames holding a 'Flight Deck' span: 1 frames, 1.19 ms mean" in text
    comp = text.split("per frame on average:")[1]
    refr = next(l for l in comp.splitlines() if l.strip().startswith("lv_refr_now"))
    assert refr.split()[1:4] == ["1.0", "1000", "550"]      # count, total, self (1000 - 300 - 150)
    assert prof.frame_jobs(an, prof.decode(an)[0], with_span="Explorer") == []


def test_perfetto_has_span_and_sample_tracks(tmp_path) -> None:
    an = Analysis(stream(), FakeElf())
    out = tmp_path / "x.json"
    perfetto.export(an, out)
    ev = json.loads(out.read_text())["traceEvents"]
    names = {e["args"]["name"] for e in ev if e.get("name") == "thread_name"}
    assert any(n.endswith(" spans") for n in names) and "interrupts samples" in names
    sl = [e for e in ev if e.get("ph") == "X" and e.get("name") == "lv_refr_now"]
    assert sl and sl[0]["dur"] == 1000.0 and sl[0]["args"]["on_cpu_us"] == 800.0
