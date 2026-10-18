"""End-to-end test: SerialLink ↔ fake_esp engine over a PTY pair.

Skipped on Windows (no os.openpty).
"""
from __future__ import annotations

import os
import sys
import threading
import time

import pytest

pytest.importorskip("serial")
if sys.platform.startswith("win"):
    pytest.skip("PTY not available on Windows", allow_module_level=True)

from app.serial_link import LinkConfig, SerialLink  # noqa: E402
from sim.fake_esp import Engine, read_available  # noqa: E402


def wait_for(pred, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def sim():
    """Yields (slave_path, engine). The pump thread polls so teardown never blocks."""
    master, slave = os.openpty()
    slave_path = os.ttyname(slave)
    stop = threading.Event()
    engine = Engine(lambda data: os.write(master, data), offline=frozenset("C"))

    def pump():
        while not stop.is_set():
            try:
                chunk = read_available(master, stop)
            except OSError:
                return
            if chunk:
                engine.feed(chunk)

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    try:
        yield slave_path, engine
    finally:
        engine.stop_clock()
        stop.set()
        t.join(timeout=1.0)
        for fd in (master, slave):
            try: os.close(fd)
            except OSError: pass


@pytest.fixture
def link(sim):
    events = []
    lk = SerialLink(on_event=events.append)
    lk.open(LinkConfig(port=sim[0], ack_timeout_s=1.0, retries=2))
    lk.events = events
    try:
        yield lk
    finally:
        lk.close()


def of_type(events, kind):
    return [e for e in events if e["type"] == kind]


def test_send_pattern_gets_ok_and_per_row_acks(link):
    ack = link.send_pattern(120, [[1, 0, 1, 0], [0, 1, 0, 1], [1, 1, 0, 0]])
    assert ack.kind == "OK" and ack.detail.startswith("PAT")
    # ACK/NAK lines arrive after OK PAT: wait for one per row.
    assert wait_for(lambda: len(of_type(link.events, "peer")) == 3)
    peers = {e["peer"]: e["ok"] for e in of_type(link.events, "peer")}
    assert peers == {0: True, 1: True, 2: False}   # sim treats C as offline


def test_play_streams_steps_and_stop_ends_them(link):
    link.send_pattern(300, [[1, 0, 1, 0]])          # 300 steps/min = 200 ms
    link.send_play()
    assert link.playing
    assert wait_for(lambda: len(of_type(link.events, "step")) >= 5, timeout=3)
    steps = [e["step"] for e in of_type(link.events, "step")][:5]
    assert steps == [0, 1, 2, 3, 0]
    assert of_type(link.events, "transport")[-1] == {"type": "transport", "playing": True}

    link.send_stop()
    assert not link.playing
    n = len(of_type(link.events, "step"))
    time.sleep(0.5)
    assert len(of_type(link.events, "step")) == n
    # STEP lines are not logged (they'd flood the log)
    assert not any("STEP" in e.get("line", "") for e in of_type(link.events, "log"))


def test_play_without_pattern_is_refused(link):
    with pytest.raises(ValueError, match="no pattern"):
        link.send_play()


def test_overlapping_sends_each_get_their_own_ok(link):
    results, errors = [], []

    def go(i):
        try:
            results.append(link.send_pattern(120, [[i % 2] * 4]).detail)
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(repr(exc))

    threads = [threading.Thread(target=go, args=(i,)) for i in range(6)]
    for t in threads: t.start()
    for t in threads: t.join(timeout=10)
    assert not errors
    assert sorted(results) == sorted(f"PAT {i}" for i in range(1, 7))


def test_ready_line_resets_playing(link, sim):
    link.send_pattern(120, [[1]])
    link.send_play()
    assert link.playing
    sim[1].stop_clock()
    sim[1]._write(b"OK READY\n")                    # sender rebooted
    assert wait_for(lambda: of_type(link.events, "ready"))
    assert not link.playing


def test_timeout_raises():
    master, slave = os.openpty()
    slave_path = os.ttyname(slave)
    lk = SerialLink()
    lk.open(LinkConfig(port=slave_path, ack_timeout_s=0.1, retries=2))
    try:
        with pytest.raises(TimeoutError):
            lk.send_pattern(120, [[1, 0]])
    finally:
        lk.close()
        os.close(master)
        try: os.close(slave)
        except OSError: pass
