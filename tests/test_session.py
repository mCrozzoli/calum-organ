"""The shared session (app/session.py) with a fake organ link."""
from __future__ import annotations

import threading
import time

import pytest

from app.protocol import Ack, ProtocolError
from app.session import Session


class FakeLink:
    def __init__(self, open_=True):
        self.open_ = open_
        self.sent = []
        self.lock = threading.Lock()

    def is_open(self):
        return self.open_

    def send_pattern(self, tempo, grid):
        with self.lock:
            self.sent.append((tempo, [r[:] for r in grid]))
            return Ack(kind="OK", detail=f"PAT {len(self.sent)}")


@pytest.fixture
def setup():
    events = []
    link = FakeLink()
    return Session(events.append, link), link, events


def wait_until(pred, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_paint_bursts_are_merged_into_few_organ_sends(setup):
    s, link, events = setup
    for j in range(5):
        s.set_cells([[0, j, 1]], by="ana")
    assert wait_until(lambda: s.organ()["rev"] == s.rev)
    assert len(link.sent) <= 2, "edits within the coalescing window share one send"
    assert link.sent[-1][1][0][:6] == [1, 1, 1, 1, 1, 0]
    assert s.organ()["seq"] == len(link.sent)
    kinds = [e["type"] for e in events]
    assert kinds.count("cells") == 5 and "organ" in kinds
    assert [e for e in events if e["type"] == "cells"][0] == {"type": "cells", "cells": [[0, 0, 1]], "rev": 1, "by": "ana"}


def test_two_people_painting_keep_each_others_cells(setup):
    s, _, _ = setup
    s.set_cells([[0, 0, 1]], by="ana")
    s.set_cells([[1, 3, 1]], by="ben")
    g = s.pattern()["grid"]
    assert g[0][0] == 1 and g[1][3] == 1


def test_cells_outside_the_grid_are_ignored_and_bad_input_rejected(setup):
    s, _, _ = setup
    rev = s.rev
    assert s.set_cells([[9, 0, 1], [0, 99, 1], [0, 0, 0]]) == rev, "nothing changed: no new revision"
    for bad in ([[0, 0, 2]], [[0, 0]], "x", [[0, "1", 1]], [[0, 0, 1]] * 600):
        with pytest.raises(ValueError):
            s.set_cells(bad)


def test_replace_validates_and_broadcasts(setup):
    s, _, events = setup
    s.replace(90, [[1, 0, 1]], by="host")
    assert s.pattern() == {"tempo": 90, "grid": [[1, 0, 1]], "rev": 1}
    assert events[-1]["type"] == "pattern"
    with pytest.raises(ProtocolError):
        s.replace(5, [[1]])


def test_flush_sends_now(setup):
    s, link, _ = setup
    s.set_cells([[0, 0, 1]])
    s.flush()                      # what /api/play does before PLAY
    assert s.organ()["rev"] == s.rev
    assert link.sent[-1][1][0][0] == 1


def test_nothing_is_sent_without_an_organ():
    events = []
    link = FakeLink(open_=False)
    s = Session(events.append, link)
    s.set_cells([[0, 0, 1]])
    time.sleep(0.2)
    assert link.sent == [] and s.organ()["seq"] is None


def test_presence(setup):
    s, _, events = setup
    host = s.join("h1", "", "host")
    ana = s.join("g1", "  Ana\x00 the organist with a very long name ", "guest")
    assert host["name"] == "Host" and host["colour"] != ana["colour"]
    assert ana["name"] == "Ana the organist with a"  # printable only, 24 chars max, trimmed
    assert [u["id"] for u in s.presence()] == ["h1", "g1"]
    s.leave("g1")
    assert events[-1] == {"type": "presence", "users": [host]}
