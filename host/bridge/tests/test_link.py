# SPDX-License-Identifier: Apache-2.0
"""The discovery answer: key=value services, and fw= with spaces to the end."""
from __future__ import annotations

from zprof_bridge.link import parse_answer


def test_answer_with_prof_and_a_dated_fw():
    kv = parse_answer(b"N6HA N6DK board=STM32N6570-DK ip=192.0.2.7 mac=02:80:e1:00:00:01 "
                      b"hostlink=5557 ctl=5556 shot=5555 media=5558 http=80 prof=5560 fw=Nov 22 2026 07:28:00")
    assert kv["board"] == "STM32N6570-DK"
    assert kv["prof"] == "5560"
    assert kv["fw"] == "Nov 22 2026 07:28:00"


def test_answer_without_prof_or_fw():
    kv = parse_answer(b"N6HA N6DK board=X ip=192.0.2.7 ctl=5556\n")
    assert "prof" not in kv and "fw" not in kv
    assert kv["ctl"] == "5556"
