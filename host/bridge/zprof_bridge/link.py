# SPDX-License-Identifier: Apache-2.0
"""Finding a target and talking to it.

Discovery uses the N6 demo's existing query: "N6HQ" broadcast to udp/5557 is
answered with an "N6HA ..." line of key=value services; a board running zprof
lists `prof=<port>`. A target without that service can still be reached with
--host and the default port.
"""
from __future__ import annotations

import socket
import time

DISCOVERY_PORT = 5557
DEFAULT_PORT = 5560


def discover(timeout: float = 1.0) -> dict[str, dict[str, str]]:
    """Boards that answer the N6 discovery query: address -> their key=value services."""
    found: dict[str, dict[str, str]] = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.2)
    try:
        s.sendto(b"N6HQ", ("255.255.255.255", DISCOVERY_PORT))
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, addr = s.recvfrom(512)
            except (socket.timeout, ConnectionResetError):
                continue
            if data[:4] == b"N6HA":
                kv = dict(p.split("=", 1) for p in data[5:].decode("ascii", "replace").split() if "=" in p)
                found[addr[0]] = kv
    except OSError:
        pass
    finally:
        s.close()
    return found


def connect(host: str, port: int = DEFAULT_PORT, timeout: float = 5.0) -> socket.socket:
    s = socket.create_connection((host, port), timeout=timeout)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
    s.settimeout(1.0)
    return s
