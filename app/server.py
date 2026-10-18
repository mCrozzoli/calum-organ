"""Stdlib-only HTTP + Server-Sent Events server for the Calum Organ web UI.

Endpoints:
  GET  /                    → index.html (from app/static/)
  GET  /<path>              → other files in app/static/ (also /static/<path>)
  GET  /api/ports           → list serial ports
  POST /api/connect         → {port} → open serial link
  POST /api/disconnect      → close serial link
  POST /api/pattern         → {tempo, grid} → send PAT (with retry)
  POST /api/play            → send PLAY
  POST /api/stop            → send STOP
  GET  /api/presets         → list preset names
  GET  /api/presets/{name}  → load a preset
  POST /api/presets/{name}  → {tempo, grid} → save a preset
  DELETE /api/presets/{name} → delete a preset
  POST /api/quit            → stop the organ, disconnect, shut the app down
  GET  /api/status          → {connected, port, playing, pattern, peers}
  GET  /api/events          → Server-Sent Events: log, status, peer, step,
                              transport, ready

The frontend is a single page that connects to /api/events on load and
renders everything from there.
"""
from __future__ import annotations

import json
import mimetypes
import re
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import unquote, urlparse

from . import presets, protocol
from .ports import list_serial_ports
from .serial_link import LinkConfig, SerialLink

STATIC_DIR = Path(__file__).parent / "static"
PRESET_NAME_RE = re.compile(r"^[\w][\w \-.]{0,63}$")


def _preset_name(raw: str) -> str:
    name = unquote(raw).strip()
    if not PRESET_NAME_RE.match(name) or ".." in name:
        raise ValueError("preset names may use letters, numbers, spaces, - _ . (max 64)")
    return name


# ---------------------------------------------------------------------------
# global state (single-user local app)
# ---------------------------------------------------------------------------
class AppState:
    def __init__(self) -> None:
        self._subscribers: List[queue.Queue] = []
        self._sub_lock = threading.Lock()
        # What the organ currently has, so a reloaded or second page shows
        # it instead of overwriting it with a blank grid.
        self.pattern: Optional[dict] = None
        self.peers: Dict[int, dict] = {}
        self.link = SerialLink(on_event=self._on_link_event)

    def _on_link_event(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "peer":
            self.peers[event["peer"]] = {"seq": event["seq"], "ok": event["ok"]}
        elif kind == "ready" or (kind == "status" and not event.get("connected")):
            self.pattern = None     # sender rebooted or link gone
            self.peers = {}
        self._broadcast(event)

    def stop_organ(self) -> None:
        """Silence the organ and release the port (used on quit and Ctrl+C)."""
        if not self.link.is_open():
            return
        if self.link.playing:
            try:
                self.link.send_stop()
            except Exception:
                pass    # receivers time out and close their valves anyway
        self.link.close()

    def snapshot(self) -> dict:
        return {
            "type": "status",
            "connected": self.link.is_open(),
            "port": self.link.port,
            "playing": self.link.playing,
            "pattern": self.pattern,
            "peers": self.peers,
        }

    def subscribe(self) -> "queue.Queue[dict]":
        q: "queue.Queue[dict]" = queue.Queue(maxsize=512)
        with self._sub_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q) -> None:
        with self._sub_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def _broadcast(self, event: dict) -> None:
        with self._sub_lock:
            dead = []
            for q in self._subscribers:
                try:
                    q.put_nowait(event)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                try:
                    self._subscribers.remove(q)
                except ValueError:
                    pass


STATE = AppState()


# ---------------------------------------------------------------------------
# request handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "CalumOrgan/1.1"

    # quiet the default per-request stderr log
    def log_message(self, format, *args):  # noqa: A002
        return

    # ---- helpers ------------------------------------------------------
    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"bad JSON: {exc}") from exc

    def _send_static(self, rel_path: str) -> None:
        # rel_path is already relative; resolve and confine to STATIC_DIR.
        target = (STATIC_DIR / rel_path).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        ctype, _ = mimetypes.guess_type(str(target))
        if ctype is None:
            ctype = "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- routing ------------------------------------------------------
    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/" or path == "/index.html":
            self._send_static("index.html")
            return
        if path == "/api/ports":
            self._send_json([p.to_json() for p in list_serial_ports()])
            return
        if path == "/api/status":
            self._send_json(STATE.snapshot())
            return
        if path == "/api/presets":
            self._send_json(presets.list_presets())
            return
        if path.startswith("/api/presets/"):
            try:
                p = presets.load(_preset_name(path[len("/api/presets/"):]))
                self._send_json({"name": p.name, "tempo": p.tempo, "grid": p.grid})
            except FileNotFoundError:
                self._send_json({"error": "not found"}, 404)
            except Exception as exc:
                self._send_json({"error": str(exc)}, 400)
            return
        if path == "/api/events":
            self._stream_events()
            return
        if path.startswith("/api/"):
            self.send_error(404)
            return
        # Everything else is the web UI. It uses relative paths so the same
        # files also work from GitHub Pages; /static/ is the old prefix.
        rel = unquote(path).lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        self._send_static(rel or "index.html")

    def do_DELETE(self):  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/presets/"):
            self.send_error(404)
            return
        try:
            presets.delete(_preset_name(path[len("/api/presets/"):]))
            self._send_json({"ok": True})
        except FileNotFoundError:
            self._send_json({"error": "not found"}, 404)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, 400)

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, 400)
            return

        try:
            if path == "/api/connect":
                port = body.get("port")
                if not port:
                    raise ValueError("missing 'port'")
                if STATE.link.is_open():
                    STATE.link.close()
                STATE.link.open(LinkConfig(port=port))
                self._send_json({"ok": True})
                return

            if path == "/api/quit":
                STATE.stop_organ()
                STATE._broadcast({"type": "quit"})
                self._send_json({"ok": True})
                # shutdown() blocks until serve_forever() returns, so it
                # can't run on this request's thread.
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return

            if path == "/api/disconnect":
                STATE.link.close()
                self._send_json({"ok": True})
                return

            if path == "/api/pattern":
                tempo = int(body.get("tempo", 120))
                grid = body.get("grid")
                if not isinstance(grid, list):
                    raise ValueError("missing 'grid'")
                ack = STATE.link.send_pattern(tempo, grid)
                try:
                    seq = int(ack.detail.split()[1])
                except (IndexError, ValueError):
                    seq = None
                STATE.pattern = {"tempo": tempo, "grid": grid, "seq": seq}
                self._send_json({"ok": True, "detail": ack.detail})
                return

            if path == "/api/play":
                STATE.link.send_play()
                self._send_json({"ok": True})
                return

            if path == "/api/stop":
                STATE.link.send_stop()
                self._send_json({"ok": True})
                return

            if path.startswith("/api/presets/"):
                name = _preset_name(path[len("/api/presets/"):])
                tempo = int(body.get("tempo", 120))
                grid = body.get("grid")
                if not isinstance(grid, list):
                    raise ValueError("missing 'grid'")
                presets.save(presets.Preset(name=name, tempo=tempo, grid=grid))
                self._send_json({"ok": True})
                return

            self.send_error(404)
        except (protocol.ProtocolError, ValueError) as exc:
            self._send_json({"error": str(exc)}, 400)
        except (TimeoutError, ConnectionError, RuntimeError) as exc:
            self._send_json({"error": str(exc)}, 502)
        except Exception as exc:
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    # ---- SSE ----------------------------------------------------------
    def _stream_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = STATE.subscribe()
        q.put_nowait(STATE.snapshot())   # this client only
        try:
            last_ping = time.monotonic()
            while True:
                try:
                    ev = q.get(timeout=1.0)
                    payload = json.dumps(ev)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    pass
                # heartbeat every 15 s so proxies don't drop us
                if time.monotonic() - last_ping > 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            STATE.unsubscribe(q)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
class OrganServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # A browser dropping a connection (tab closed, reload, quit) is
        # normal; don't print a traceback into Calum's Terminal for it.
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    return OrganServer((host, port), Handler)
