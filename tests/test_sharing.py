"""Host and guests over real HTTP: who may do what, and the join code."""
from __future__ import annotations

import http.client
import json
import threading
import time

import pytest

from app.server import STATE, serve


@pytest.fixture
def host_port():
    STATE.sharing.bind = "127.0.0.1"          # no macOS firewall prompt in tests
    s = serve("127.0.0.1", 0)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        yield s.server_address[1]
    finally:
        STATE.sharing.stop()
        s.shutdown()
        s.server_close()


def req(port, method, path, body=None, headers=None, host_header=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Content-Type": "application/json"}
    if host_header:
        h["Host"] = host_header
    h.update(headers or {})
    conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    ctype = r.getheader("Content-Type") or ""
    return r.status, (json.loads(data) if ctype.startswith("application/json") else data), r


def test_host_snapshot(host_port):
    status, snap, _ = req(host_port, "GET", "/api/status")
    assert status == 200 and snap["role"] == "host"
    assert set(snap["session"]) == {"tempo", "grid", "rev"}
    assert snap["sharing"] == {"on": False}
    assert isinstance(snap["users"], list)


def test_other_websites_cannot_send_commands(host_port):
    status, body, _ = req(host_port, "POST", "/api/session/cells", {"cells": [[0, 0, 1]]},
                          headers={"Origin": "http://evil.example"})
    assert status == 403 and "other sites" in body["error"]
    status, _, _ = req(host_port, "POST", "/api/session/cells", {"cells": [[0, 0, 1]]},
                       headers={"Origin": f"http://127.0.0.1:{host_port}"})
    assert status == 200


def test_names_other_than_localhost_are_refused(host_port):
    status, _, _ = req(host_port, "GET", "/api/status", host_header="evil.example")   # DNS rebinding
    assert status == 403


def test_guests_need_the_code_and_can_only_paint(host_port):
    status, info, _ = req(host_port, "POST", "/api/share", {"on": True})
    assert status == 200 and info["on"] and len(info["code"]) == 4
    gp, code = info["port"], info["code"]
    assert all(u.endswith(f":{gp}/?join={code}") for u in info["urls"])

    # the app itself loads; the API needs the code
    assert req(gp, "GET", "/")[0] == 200
    status, body, _ = req(gp, "GET", "/api/status")
    assert status == 401 and body["join"] is True
    assert req(gp, "GET", "/api/join?code=nope")[0] == 403
    status, _, r = req(gp, "GET", f"/api/join?code={code}")
    cookie = r.getheader("Set-Cookie").split(";")[0]
    assert status == 200 and cookie == f"organ_join={code}" and "SameSite=Strict" in r.getheader("Set-Cookie")
    guest = {"Cookie": cookie}

    status, snap, _ = req(gp, "GET", "/api/status", headers=guest)
    assert status == 200 and snap["role"] == "guest" and snap["port"] is None and "sharing" not in snap

    rev = req(host_port, "GET", "/api/session")[1]["rev"]
    status, body, _ = req(gp, "POST", "/api/session/cells", {"cells": [[1, 2, 1]]}, headers=guest)
    assert status == 200 and body["rev"] == rev + 1
    assert req(host_port, "GET", "/api/session")[1]["grid"][1][2] == 1

    for method, path, body in [("POST", "/api/play", {}), ("POST", "/api/stop", {}),
                               ("POST", "/api/connect", {"port": "/dev/x"}),
                               ("POST", "/api/session/pattern", {"tempo": 120, "grid": [[1]]}),
                               ("POST", "/api/share", {"on": False}), ("POST", "/api/quit", {}),
                               ("GET", "/api/ports", None), ("GET", "/api/presets", None),
                               ("DELETE", "/api/presets/x", None)]:
        status, resp, _ = req(gp, method, path, body, headers=guest)
        assert status == 403, (method, path, status, resp)

    # stopping sharing closes the door; a new code locks out the old one
    req(host_port, "POST", "/api/share", {"on": False})
    with pytest.raises(OSError):
        req(gp, "GET", "/api/status", headers=guest)
    info2 = req(host_port, "POST", "/api/share", {"on": True})[1]
    if info2["code"] != code:
        assert req(info2["port"], "GET", "/api/status", headers=guest)[0] == 401


def test_guest_edits_are_rate_limited(host_port):
    info = req(host_port, "POST", "/api/share", {"on": True})[1]
    gp, code = info["port"], info["code"]
    guest = {"Cookie": f"organ_join={code}"}
    statuses = [req(gp, "POST", "/api/session/cells", {"cells": [[0, k % 16, k % 2]]}, headers=guest)[0]
                for k in range(40)]
    assert statuses.count(429) > 0 and statuses[0] == 200


def test_presence_follows_event_streams(host_port):
    conn = http.client.HTTPConnection("127.0.0.1", host_port, timeout=5)
    conn.request("GET", "/api/events?name=Ana")
    r = conn.getresponse()
    seen = False
    end = time.monotonic() + 3
    while time.monotonic() < end and not seen:
        line = r.fp.readline().decode()
        if line.startswith("data:"):
            ev = json.loads(line[5:])
            seen = ev.get("type") == "presence" and any(u["name"] == "Ana" for u in ev["users"])
    assert seen
    r.close()                                      # the tab closes (both ends of
    conn.close()                                   # http.client hold the socket)
    end = time.monotonic() + 4
    while time.monotonic() < end:
        users = req(host_port, "GET", "/api/status")[1]["users"]
        if not any(u["name"] == "Ana" for u in users):
            break
        time.sleep(0.2)
    else:
        pytest.fail("Ana is still listed 4 s after leaving")


def test_stopping_sharing_ends_guest_streams(host_port):
    """Guests must notice: their event stream closes, it doesn't hang open."""
    import socket
    info = req(host_port, "POST", "/api/share", {"on": True})[1]
    s = socket.create_connection(("127.0.0.1", info["port"]))
    s.sendall(f"GET /api/events?name=Ana HTTP/1.1\r\nHost: 127.0.0.1:{info['port']}\r\n"
              f"Cookie: organ_join={info['code']}\r\nConnection: keep-alive\r\n\r\n".encode())
    s.settimeout(0.3)
    data = b""
    end = time.monotonic() + 2
    while time.monotonic() < end and b'"status"' not in data:
        try:
            data += s.recv(4096)
        except socket.timeout:
            pass
    assert b'"status"' in data
    req(host_port, "POST", "/api/share", {"on": False})
    end = time.monotonic() + 3
    while time.monotonic() < end:
        try:
            if s.recv(4096) == b"":
                break                              # closed: the browser will notice
        except socket.timeout:
            pass
    else:
        pytest.fail("guest stream still open 3 s after sharing stopped")
    s.close()
