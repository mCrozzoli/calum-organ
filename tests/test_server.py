"""Smoke test for the HTTP server: index.html, /api/ports, /api/presets."""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

pytest.importorskip("serial")

from app.server import serve  # noqa: E402


@pytest.fixture
def running_server():
    s = serve("127.0.0.1", 0)
    t = threading.Thread(target=s.serve_forever, daemon=True)
    t.start()
    host, port = s.server_address
    base = f"http://{host}:{port}"
    try:
        yield base
    finally:
        s.shutdown()


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=2) as r:
        return r.status, r.read()


def test_index(running_server):
    status, body = get(running_server, "/")
    assert status == 200
    assert b"<title>Calum Organ" in body


def test_ports(running_server):
    status, body = get(running_server, "/api/ports")
    assert status == 200
    data = json.loads(body)
    assert isinstance(data, list)
    for p in data:
        assert "device" in p and "description" in p and "likely" in p


def test_static_css(running_server):
    for path in ("/app.css", "/static/app.css"):     # new relative path + old prefix
        status, body = get(running_server, path)
        assert status == 200
        assert b":root" in body


def test_js_modules_served_as_javascript(running_server):
    with urllib.request.urlopen(running_server + "/js/app.js", timeout=2) as r:
        assert r.status == 200
        assert "javascript" in r.headers["Content-Type"]


@pytest.mark.parametrize("path", ["/../pyproject.toml", "/%2e%2e/pyproject.toml", "/js/../../server.py"])
def test_no_escape_from_static_dir(running_server, path):
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(running_server, path)
    assert exc.value.code in (403, 404)


def test_unknown_api_is_404(running_server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(running_server, "/api/nope")
    assert exc.value.code == 404


def test_status_snapshot(running_server):
    status, body = get(running_server, "/api/status")
    assert status == 200
    assert json.loads(body) == {"type": "status", "connected": False, "port": None,
                                "playing": False, "pattern": None, "peers": {}}


@pytest.mark.parametrize("name", ["..%2Fescape", "%2Fetc%2Fpasswd", "a%2Fb", ".hidden"])
def test_bad_preset_names_rejected(running_server, name):
    req = urllib.request.Request(
        f"{running_server}/api/presets/{name}",
        data=json.dumps({"tempo": 120, "grid": [[1]]}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=2)
    assert exc.value.code == 400


def test_delete_preset_and_quit(running_server, tmp_path, monkeypatch):
    from app import presets
    monkeypatch.setattr(presets, "PRESET_DIR", tmp_path / "presets")

    def call(method, path, body=None):
        req = urllib.request.Request(
            running_server + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2) as r:
            return json.loads(r.read())

    call("POST", "/api/presets/demo", {"tempo": 120, "grid": [[1, 0]]})
    assert call("GET", "/api/presets") == ["demo"]
    call("DELETE", "/api/presets/demo")
    assert call("GET", "/api/presets") == []
    with pytest.raises(urllib.error.HTTPError) as exc:
        call("DELETE", "/api/presets/demo")
    assert exc.value.code == 404

    assert call("POST", "/api/quit", {}) == {"ok": True}
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:          # server stops accepting
        try:
            call("GET", "/api/status")
        except OSError:
            break
        time.sleep(0.05)
    else:
        pytest.fail("server still running after quit")
