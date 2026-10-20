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
    for needle in ("esp_now_register_recv_cb", '"PIPES"', 'OK PIPES fw %s', "PIPE %d", "DUP %d", "ask_who()"):
        assert needle in hub, needle
    js = (STATIC / "js" / "boards.js").read_text()
    assert "INFO pipe" in js and "FW calum_receiver" in js and "FW calum_sender" in js


def test_simulator_lists_pipes():
    sim = (ROOT / "sim" / "fake_esp.py").read_text()
    assert '"PIPES"' in sim and "OK PIPES" in sim


def test_live_notes_cannot_stick():
    # 1.3: NOTE <mask> from the app; the hub repeats it while keys are held,
    # pipes let go without it, and Stop clears it.
    hub = (FW / "calum_sender" / "calum_sender.ino").read_text()
    pipe = (FW / "calum_receiver" / "calum_receiver.ino").read_text()
    peers = (FW / "calum_sender" / "peers.h").read_text()
    assert "PKT_NOTE" in peers and "NOTE_REPEAT_MS" in peers and "NOTE_TIMEOUT_MS" in peers
    repeat = int(re.search(r"#define NOTE_REPEAT_MS\s+(\d+)", peers).group(1))
    timeout = int(re.search(r"#define NOTE_TIMEOUT_MS\s+(\d+)", peers).group(1))
    assert timeout >= 3 * repeat, "a pipe must survive two lost repeats"
    assert '"NOTE"' in hub and "service_notes()" in hub and "live_mask = 0;" in hub
    assert "NOTE_TIMEOUT_MS" in pipe and "live_open = false;" in pipe
    # the valve is driven in one place only
    assert pipe.count("digitalWrite(RELAY_PIN") == 2, "apply_valve() and close_valve() only"


def test_rhythm_14_matches_the_app():
    # 1.4: figures, per-pipe length and rate, a step count that never wraps.
    peers = (FW / "calum_sender" / "peers.h").read_text()
    hub = (FW / "calum_sender" / "calum_sender.ino").read_text()
    pipe = (FW / "calum_receiver" / "calum_receiver.ino").read_text()
    js = (STATIC / "js" / "rhythm.js").read_text()
    # the same figure codes and timings in C and JS
    for name, code in (("FULL", 1), ("DETACHED", 2), ("STACCATO", 3), ("REP2", 4), ("REP3", 5), ("REP4", 6), ("OFFBEAT", 7)):
        assert re.search(rf"FIG_{name} = {code}\b", peers), name
        assert re.search(rf"\b{name}: {code}\b", js), name
    for c_rule, js_rule in (("phase < 0.85", "phase < 0.85"), ("phase < 0.3", "phase < 0.3"), ("phase >= 0.5", "phase >= 0.5")):
        assert c_rule in peers and js_rule in js
    assert "uint32_t count;" in peers and "rate_num" in peers and "pattern[12]" in peers
    assert '"PAT2"' in hub and "handle_pat2" in hub and "tick.count = count;" in hub
    assert "service_play(now)" in pipe and "figure_open(get_figure(front.pattern, cell), phase)" in pipe
    assert "#define PIPE_MAGIC 0xC1" in peers
