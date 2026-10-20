"""Static checks on the Arduino sketches (no toolchain needed)."""
from __future__ import annotations

import re
from pathlib import Path

from app import protocol

ROOT = Path(__file__).resolve().parent.parent
FW = ROOT / "firmware"
STATIC = ROOT / "app" / "static"


def test_peers_header_copies_are_identical():
    # Arduino only sees headers inside the sketch folder, so there are two.
    a = (FW / "calum_sender" / "peers.h").read_text()
    b = (FW / "calum_receiver" / "peers.h").read_text()
    assert a == b, "firmware/*/peers.h differ: keep both copies in sync"


def test_sender_limits_match_protocol():
    src = (FW / "calum_sender" / "calum_sender.ino").read_text()
    assert f"t < {protocol.MIN_TEMPO} || t > {protocol.MAX_TEMPO}" in src
    assert f"cols > {protocol.MAX_COLS}" in src
    peers = (FW / "calum_sender" / "peers.h").read_text()
    assert re.search(rf"#define NUM_PEERS {protocol.MAX_ROWS}\b", peers)


def test_firmware_version_matches_app():
    import json
    from app import __version__
    for board in ("sender", "receiver"):
        h = (FW / f"calum_{board}" / "peers.h").read_text()
        assert f'#define FW_VERSION "{__version__}"' in h
        manifest = json.loads((STATIC / "firmware" / board / "manifest.json").read_text())
        assert manifest["version"] == __version__, "rebuild: tools/build_firmware.sh"


def test_updater_manifests_point_at_real_files():
    import json
    for board in ("sender", "receiver"):
        d = STATIC / "firmware" / board
        manifest = json.loads((d / "manifest.json").read_text())
        offsets = []
        for part in manifest["builds"][0]["parts"]:
            f = d / part["path"]
            assert f.is_file() and f.stat().st_size > 0, f
            assert f.read_bytes()[:1] == b"\xe9" or part["path"] == "partitions.bin" \
                or part["path"] == "boot_app0.bin", f"{f} is not an ESP32 image"
            offsets.append(part["offset"])
        assert offsets == [0x1000, 0x8000, 0xE000, 0x10000]


def test_pipes_store_their_letter_and_the_hub_finds_them():
    # 1.2: each pipe keeps its letter in flash and announces itself; the hub
    # learns who's who and answers PIPES. The Boards panel relies on these.
    pipe = (FW / "calum_receiver" / "calum_receiver.ino").read_text()
    hub = (FW / "calum_sender" / "calum_sender.ino").read_text()
    assert 'prefs.getUChar("pipe"' in pipe and 'prefs.putUChar("pipe"' in pipe
    for cmd in ('"INFO"', '"PIPE "', '"TEST"', "PKT_HELLO", "PKT_WHO"):
        assert cmd in pipe, cmd
    assert "READY FW calum_receiver %s pipe %c mac %s" in pipe
    for needle in ("esp_now_register_recv_cb", '"PIPES"', '"OK PIPES"', "PIPE %d", "DUP %d", "ask_who()"):
        assert needle in hub, needle
    js = (STATIC / "js" / "boards.js").read_text()
    assert "INFO pipe" in js and "FW calum_receiver" in js and "FW calum_sender" in js


def test_simulator_lists_pipes():
    sim = (ROOT / "sim" / "fake_esp.py").read_text()
    assert '"PIPES"' in sim and "OK PIPES" in sim
