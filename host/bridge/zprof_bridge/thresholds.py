# SPDX-License-Identifier: Apache-2.0
"""The project thresholds file (config/zprof.thresholds.json), as the dashboard
reads it (web/src/thresholds.ts): one source for every limit. A rule reads
"breach when value <op> threshold"; '*' matches one dotted segment and the
rule with the fewest wildcards wins."""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT = Path(__file__).resolve().parents[3] / "config" / "zprof.thresholds.json"


def load(path: str | Path | None = None) -> dict:
    return json.loads(Path(path or DEFAULT).read_text(encoding="utf-8"))


def _matches(pattern: str, metric: str) -> bool:
    p, s = pattern.split("."), metric.split(".")
    return len(p) == len(s) and all(a == "*" or a == b for a, b in zip(p, s))


def live_rule(th: dict, metric: str) -> dict | None:
    rules = [r for r in th.get("live", []) if _matches(r["metric"], metric)]
    return min(rules, key=lambda r: r["metric"].count("*"), default=None)


def _breach(op: str, v: float, t: float) -> bool:
    return v >= t if op == ">=" else v > t if op == ">" else v <= t if op == "<=" else v < t


def status(th: dict, metric: str, v: float | None) -> str:
    """'crit', 'warn', 'ok', or 'idle' (no rule, or no value)."""
    r = live_rule(th, metric)
    if r is None or v is None or v != v:
        return "idle"
    if "crit" in r and _breach(r["op"], v, r["crit"]):
        return "crit"
    if "warn" in r and _breach(r["op"], v, r["warn"]):
        return "warn"
    return "ok"


def metric_id(*parts: str) -> str:
    """A metric id from names that may hold dots of their own."""
    return ".".join(p.replace(".", "_") for p in parts)
