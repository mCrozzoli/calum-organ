"""Stdlib-only HTTP + Server-Sent Events server for the Calum Organ web UI.

Two listeners serve the same web app:

  host   127.0.0.1, always: the laptop's own page. Full control: the organ
         connection, play/stop, tempo, presets, sharing, quit.
  guest  all network interfaces, only while the host shares (app/share.py):
         phones and laptops that joined with the code. They can watch and
         paint the shared pattern (app/session.py), nothing else.

Endpoints (H = host only):
  GET  /, /<path>             web app files from app/static/ (also /static/<path>)
  GET  /api/status            snapshot: organ, shared pattern, who's here, role
  GET  /api/events            Server-Sent Events: status, log (H), peer, step,
                              transport, ready, cells, pattern, organ,
                              presence, sharing, quit
  GET  /api/session           the shared pattern
  POST /api/session/cells     {cells: [[row, col, 0|1], ...]}  paint
  POST /api/session/pattern   H {tempo, grid}  replace (settings, presets, Clear)
  GET  /api/ports             H list serial ports
  POST /api/connect           H {port}
  POST /api/disconnect        H
  POST /api/play, /api/stop   H
  GET  /api/presets[/name]    H
  POST /api/presets/{name}    H {tempo, grid}
  DELETE /api/presets/{name}  H
  GET  /api/share             H sharing info (code, addresses)
  POST /api/share             H {on: true|false}
  POST /api/quit              H stop the organ, stop sharing, shut down
  GET  /api/join?code=1234    guest: check the code, remember it (cookie)
"""
from __future__ import annotations

import json
import mimetypes
import queue
import re
import select
import socket
import threading
import time
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from . import presets, protocol
from .ports import list_serial_ports
from .serial_link import LinkConfig, SerialLink
from .session import Session
from .share import Sharing

STATIC_DIR = Path(__file__).parent / "static"
# Older Pythons don't know these; the sound engine needs the right types.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
PRESET_NAME_RE = re.compile(r"^[\w][\w \-.]{0,63}$")
JOIN_COOKIE = "organ_join"
GUEST_EDITS_PER_SECOND = 30
MAX_GUESTS = 60


def _preset_name(raw: str) -> str:
    name = unquote(raw).strip()
    if not PRESET_NAME_RE.match(name) or ".." in name:
        raise ValueError("preset names may use letters, numbers, spaces, - _ . (max 64)")
    return name


class Forbidden(Exception):
    pass


# ---------------------------------------------------------------------------
# global state
# ---------------------------------------------------------------------------
class AppState:
    def __init__(self) -> None:
        self._subscribers: List[Tuple[queue.Queue, str]] = []      # (queue, role)
        self._sub_lock = threading.Lock()
        self.peers: Dict[int, dict] = {}
        self.link = SerialLink(on_event=self._on_link_event)
        self.session = Session(self._broadcast, self.link)
        self.sharing = Sharing()
        self._edit_times: Dict[str, List[float]] = {}

    def _on_link_event(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "peer":
            self.peers[event["peer"]] = {"seq": event["seq"], "ok": event["ok"]}
        elif kind == "ready" or kind == "status":
            # Sender (re)booted, or the link opened or closed: the organ no
            # longer has our pattern. Once connected, send it the shared one.
            self.peers = {}
            self.session.organ_lost()
            if kind == "ready" or event.get("connected"):
                self.session.resend()
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

    def snapshot(self, role: str = "host") -> dict:
        snap = {
            "type": "status",
            "role": role,
            "connected": self.link.is_open(),
            "port": self.link.port if role == "host" else None,
            "playing": self.link.playing,
            "session": self.session.pattern(),
            "organ": self.session.organ(),
            "peers": self.peers,
            "users": self.session.presence(),
        }
        if role == "host":
            snap["sharing"] = self.sharing.info()
        return snap

    def subscribe(self, role: str) -> "queue.Queue[dict]":
        q: "queue.Queue[dict]" = queue.Queue(maxsize=512)
        with self._sub_lock:
            if role == "guest" and sum(r == "guest" for _, r in self._subscribers) >= MAX_GUESTS:
                raise Forbidden("the session is full")
            self._subscribers.append((q, role))
        return q

    def unsubscribe(self, q) -> None:
        with self._sub_lock:
            self._subscribers = [(s, r) for s, r in self._subscribers if s is not q]

    def _broadcast(self, event: dict) -> None:
        # The serial log is for the host: guests don't need port names and traffic.
        host_only = event.get("type") in ("log",)
        with self._sub_lock:
            alive = []
            for q, role in self._subscribers:
                if host_only and role != "host":
                    alive.append((q, role))
                    continue
                try:
                    q.put_nowait(event)
                    alive.append((q, role))
                except queue.Full:
                    pass                      # too slow: drop that subscriber
            self._subscribers = alive

    def allow_edit(self, who: str) -> bool:
        """At most GUEST_EDITS_PER_SECOND paint requests per guest address."""
        now = time.monotonic()
        recent = [t for t in self._edit_times.get(who, []) if now - t < 1.0]
        if len(recent) >= GUEST_EDITS_PER_SECOND:
            self._edit_times[who] = recent
            return False
        recent.append(now)
        self._edit_times[who] = recent
        return True


STATE = AppState()


# ---------------------------------------------------------------------------
# request handlers
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    """The host's listener (127.0.0.1)."""
    server_version = "CalumOrgan/1.1"
    role = "host"

    # quiet the default per-request stderr log
    def log_message(self, format, *args):  # noqa: A002
        return

    # ---- helpers ------------------------------------------------------
    def _send_json(self, payload, status: int = 200, headers: Optional[dict] = None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        if length > 256 * 1024:
            raise ValueError("request too large")
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

    def _query(self) -> dict:
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    # ---- who may do what -----------------------------------------------
    def _check_host_header(self) -> bool:
        """Only answer to 127.0.0.1 / localhost: a web page elsewhere that
        resolves its own name to 127.0.0.1 (DNS rebinding) gets nothing."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host in ("127.0.0.1", "localhost", "::1"):
            return True
        self.send_error(403, "unexpected Host")
        return False

    def _check_origin(self) -> bool:
        """State-changing requests must come from this app's own pages, not
        from another website open in the same browser (CSRF)."""
        origin = self.headers.get("Origin")
        if origin is None or urlparse(origin).netloc == self.headers.get("Host"):
            return True
        self._send_json({"error": "requests from other sites are not allowed"}, 403)
        return False

    def _allowed(self, method: str, path: str) -> bool:
        return True                    # the host may do everything

    def _who(self) -> str:
        return "host"

    # ---- routing ------------------------------------------------------
    def do_GET(self):  # noqa: N802
        if not self._check_host_header():
            return
        self._get(urlparse(self.path).path)

    def do_POST(self):  # noqa: N802
        if not self._check_host_header() or not self._check_origin():
            return
        self._post(urlparse(self.path).path)

    def do_DELETE(self):  # noqa: N802
        if not self._check_host_header() or not self._check_origin():
            return
        path = urlparse(self.path).path
        if not path.startswith("/api/presets/") or not self._allowed("DELETE", path):
            self._deny(path)
            return
        try:
            presets.delete(_preset_name(path[len("/api/presets/"):]))
            self._send_json({"ok": True})
        except FileNotFoundError:
            self._send_json({"error": "not found"}, 404)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, 400)

    def _deny(self, path: str) -> None:
        if path.startswith("/api/"):
            self._send_json({"error": "only the host can do that"}, 403)
        else:
            self.send_error(404)

    def _get(self, path: str) -> None:
        if path.startswith("/api/") and not self._allowed("GET", path):
            self._deny(path)
            return
        if path == "/api/status":
            self._send_json(STATE.snapshot(self.role))
            return
        if path == "/api/events":
            self._stream_events()
            return
        if path == "/api/session":
            self._send_json(STATE.session.pattern())
            return
        if path == "/api/ports":
            self._send_json([p.to_json() for p in list_serial_ports()])
            return
        if path == "/api/share":
            self._send_json(STATE.sharing.info())
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
        if path.startswith("/api/"):
            self.send_error(404)
            return
        # Everything else is the web UI. It uses relative paths so the same
        # files also work from GitHub Pages; /static/ is the old prefix.
        rel = unquote(path).lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        self._send_static(rel or "index.html")

    def _post(self, path: str) -> None:
        if not self._allowed("POST", path):
            self._deny(path)
            return
        try:
            body = self._read_json()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, 400)
            return

        try:
            if path == "/api/session/cells":
                if self.role == "guest" and not STATE.allow_edit(self.client_address[0]):
                    self._send_json({"error": "too many edits, slow down"}, 429)
                    return
                rev = STATE.session.set_cells(body.get("cells"), by=str(body.get("by", ""))[:64])
                self._send_json({"ok": True, "rev": rev})
                return

            if path == "/api/session/pattern":
                tempo = int(body.get("tempo", 120))
                grid = body.get("grid")
                if not isinstance(grid, list):
                    raise ValueError("missing 'grid'")
                rev = STATE.session.replace(tempo, grid, by=str(body.get("by", ""))[:64])
                self._send_json({"ok": True, "rev": rev})
                return

            if path == "/api/connect":
                port = body.get("port")
                if not port:
                    raise ValueError("missing 'port'")
                if STATE.link.is_open():
                    STATE.link.close()
                STATE.link.open(LinkConfig(port=port))
                self._send_json({"ok": True})
                return

            if path == "/api/disconnect":
                STATE.link.close()
                self._send_json({"ok": True})
                return

            if path == "/api/play":
                STATE.session.flush()          # the organ gets the latest edits first
                STATE.link.send_play()
                self._send_json({"ok": True})
                return

            if path == "/api/stop":
                STATE.link.send_stop()
                self._send_json({"ok": True})
                return

            if path == "/api/share":
                if body.get("on"):
                    info = STATE.sharing.start(lambda h, p: OrganServer((h, p), GuestHandler))
                else:
                    info = STATE.sharing.stop()
                STATE._broadcast({"type": "sharing", "on": info["on"]})
                self._send_json(info)
                return

            if path == "/api/quit":
                STATE.stop_organ()
                STATE.sharing.stop()
                STATE._broadcast({"type": "quit"})
                self._send_json({"ok": True})
                # shutdown() blocks until serve_forever() returns, so it
                # can't run on this request's thread.
                threading.Thread(target=self.server.shutdown, daemon=True).start()
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
    def _still_welcome(self) -> bool:
        return True

    def _client_gone(self) -> bool:
        """An event stream client never sends anything after its request, so
        a readable socket means it closed (tab closed, phone left)."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _stream_events(self) -> None:
        try:
            q = STATE.subscribe(self.role)
        except Forbidden as exc:
            self._send_json({"error": str(exc)}, 503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        conn_id = uuid.uuid4().hex[:12]
        q.put_nowait(STATE.snapshot(self.role) | {"you": conn_id})   # this client only
        STATE.session.join(conn_id, self._query().get("name", ""), self.role)
        try:
            last_ping = time.monotonic()
            while self._still_welcome() and not self._client_gone():
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
            STATE.session.leave(conn_id)
            # The "Connection: keep-alive" header above makes http.server
            # wait for another request on this socket. A stream that ends
            # (e.g. sharing stopped) must close it, or the browser keeps
            # waiting on a dead stream instead of noticing.
            self.close_connection = True


class GuestHandler(Handler):
    """The share listener (all interfaces): watch and paint, with the code."""
    role = "guest"
    GUEST_API = {("GET", "/api/status"), ("GET", "/api/events"), ("GET", "/api/session"),
                 ("POST", "/api/session/cells")}

    def _check_host_header(self) -> bool:
        return True                    # reached by IP or .local name; the code guards it

    def _joined(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie") or "")
        return JOIN_COOKIE in cookie and STATE.sharing.check(cookie[JOIN_COOKIE].value)

    def _allowed(self, method: str, path: str) -> bool:
        return (method, path) in self.GUEST_API and self._joined()

    def _still_welcome(self) -> bool:
        return STATE.sharing.active and self._joined()

    def _deny(self, path: str) -> None:
        if path.startswith("/api/") and not self._joined():
            self._send_json({"error": "join code needed", "join": True}, 401)
        else:
            super()._deny(path)

    def _get(self, path: str) -> None:
        if path == "/api/join":
            code = self._query().get("code", "")
            if STATE.sharing.check(code):
                self._send_json({"ok": True}, headers={
                    "Set-Cookie": f"{JOIN_COOKIE}={code}; Path=/; SameSite=Strict; HttpOnly"})
            else:
                self._send_json({"error": "wrong code"}, 403)
            return
        super()._get(path)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
class OrganServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A browser dropping a connection (tab closed, reload, quit) is
        # normal; don't print a traceback into Calum's Terminal for it.
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    return OrganServer((host, port), Handler)
