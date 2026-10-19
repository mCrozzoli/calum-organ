"""Letting other devices join: a second web server, on the local network.

The host's own page is served on 127.0.0.1 only. When the host shares, a
second listener opens on all network interfaces for guests. It serves the
same web app, but its API only lets guests watch and paint the shared
pattern, and only with the join code the host shows (in a QR code).
Stopping sharing closes it and invalidates the code.
"""
from __future__ import annotations

import ipaddress
import secrets
import socket
import threading
from typing import List, Optional

PREFERRED_PORT = 8800


def lan_addresses() -> List[str]:
    """This computer's addresses that phones on the same network can reach:
    private IPv4 addresses (the one with the default route first), then the
    .local name (survives address changes; iPhones and Macs resolve it)."""
    found: List[str] = []
    try:
        # No packet is sent: this just asks which interface would route there.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.254.254.254", 1))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    ips = []
    for a in found:
        try:
            ip = ipaddress.ip_address(a)
        except ValueError:
            continue
        if ip.is_private and not ip.is_loopback and a not in ips:
            ips.append(a)
    host = socket.gethostname()
    names = [host] if host.endswith(".local") else []
    return ips + names


class Sharing:
    def __init__(self, bind: str = "0.0.0.0") -> None:
        # 0.0.0.0 = every network interface. Tests use 127.0.0.1 (no macOS
        # firewall prompt); `python -m app --share-bind` sets it too.
        self.bind = bind
        self.server = None
        self.code: Optional[str] = None
        self.port: Optional[int] = None
        self._lock = threading.Lock()

    @property
    def active(self) -> bool:
        return self.server is not None

    def start(self, make_server) -> dict:
        """make_server(host, port) -> a server object with serve_forever()."""
        with self._lock:
            if self.server is None:
                try:
                    server = make_server(self.bind, PREFERRED_PORT)
                except OSError:                  # 8800 busy: any free port
                    server = make_server(self.bind, 0)
                self.server = server
                self.port = server.server_address[1]
                self.code = f"{secrets.randbelow(10_000):04d}"
                threading.Thread(target=server.serve_forever, name="share", daemon=True).start()
            return self.info()

    def stop(self) -> dict:
        with self._lock:
            server, self.server = self.server, None
            self.code = None
            self.port = None
        if server is not None:
            server.shutdown()
            server.server_close()
        return self.info()

    def check(self, code: Optional[str]) -> bool:
        current = self.code
        return bool(current) and bool(code) and secrets.compare_digest(str(code), current)

    def info(self) -> dict:
        if not self.active:
            return {"on": False}
        urls = [f"http://{a}:{self.port}/?join={self.code}" for a in lan_addresses()]
        return {"on": True, "code": self.code, "port": self.port, "urls": urls}
