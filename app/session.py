"""The shared session: one pattern that everyone edits, and who's connected.

The laptop running the local app (the host) owns the organ connection. Every
page, the host's own and any guest that joined over Wi-Fi, edits the same
pattern here:

  - painting arrives as cell changes (``set_cells``), so two people painting
    at once never overwrite each other's work;
  - the host's settings, presets and Clear replace the whole pattern
    (``replace``).

Each change bumps ``rev`` and is broadcast to every page. A background worker
then sends the merged pattern to the organ, coalescing bursts of edits into
one serial request.
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Dict, List, Optional

from . import protocol

MAX_CELLS_PER_EDIT = 512           # 8 x 32 = 256 is a whole grid; leave room
SEND_COALESCE_S = 0.06             # gather edits for this long before sending
# Guest colours (also used to flash their edits); the host is always first.
COLOURS = ["#5cd1ff", "#f2a93b", "#42d392", "#c792ea", "#ef5350", "#f4c542", "#7fdbca", "#ff9cac"]


class Session:
    def __init__(self, broadcast: Callable[[dict], None], link) -> None:
        self._broadcast = broadcast
        self._link = link
        self._lock = threading.Lock()
        self.tempo = 120
        self.grid: List[List[int]] = [[0] * 16 for _ in range(4)]
        self.rev = 0                       # 0 = nobody has set a pattern yet
        # what the organ has: the sender's pattern number and our rev
        self.organ_seq: Optional[int] = None
        self.organ_rev: Optional[int] = None
        self.organ_error: Optional[str] = None
        self._dirty = threading.Event()
        self._send_lock = threading.Lock()
        self.users: Dict[str, dict] = {}   # connection id -> {name, role, colour}
        self._next_colour = 0
        threading.Thread(target=self._sync_loop, name="organ-sync", daemon=True).start()

    # ------------------------------------------------------------ the pattern
    def pattern(self) -> dict:
        with self._lock:
            return {"tempo": self.tempo, "grid": [row[:] for row in self.grid], "rev": self.rev}

    def set_cells(self, cells, by: str = "") -> int:
        """Paint: [[row, col, 0|1], ...]. Cells outside the grid are ignored
        (someone may have painted just as the host made the grid smaller)."""
        if not isinstance(cells, list) or len(cells) > MAX_CELLS_PER_EDIT:
            raise ValueError(f"cells must be a list of at most {MAX_CELLS_PER_EDIT}")
        with self._lock:
            changed = []
            for c in cells:
                if not (isinstance(c, list) and len(c) == 3 and all(isinstance(v, int) for v in c)):
                    raise ValueError("each cell is [row, col, 0|1]")
                i, j, v = c
                if v not in (0, 1):
                    raise ValueError("cell values are 0 or 1")
                if 0 <= i < len(self.grid) and 0 <= j < len(self.grid[0]) and self.grid[i][j] != v:
                    self.grid[i][j] = v
                    changed.append([i, j, v])
            if not changed:
                return self.rev
            self.rev += 1
            rev = self.rev
        self._broadcast({"type": "cells", "cells": changed, "rev": rev, "by": by})
        self._dirty.set()
        return rev

    def replace(self, tempo: int, grid, by: str = "") -> int:
        """The host's settings, presets and Clear: the whole pattern."""
        protocol.validate_pattern(tempo, grid)
        with self._lock:
            self.tempo = tempo
            self.grid = [list(row) for row in grid]
            self.rev += 1
            rev = self.rev
        self._broadcast({"type": "pattern", "tempo": tempo, "grid": grid, "rev": rev, "by": by})
        self._dirty.set()
        return rev

    # ------------------------------------------------------------ the organ
    def organ(self) -> dict:
        return {"seq": self.organ_seq, "rev": self.organ_rev, "error": self.organ_error,
                "pending": self._dirty.is_set()}

    def organ_lost(self) -> None:
        """The sender rebooted or the link closed: it no longer has our pattern."""
        self.organ_seq = self.organ_rev = None
        self.organ_error = None

    def resend(self) -> None:
        self._dirty.set()

    def flush(self) -> None:
        """Make sure the organ has the latest pattern now (before PLAY)."""
        if self._dirty.is_set() or self.organ_rev != self.rev:
            self._dirty.clear()
            self._send()

    def _sync_loop(self) -> None:
        while True:
            self._dirty.wait()
            time.sleep(SEND_COALESCE_S)
            self._dirty.clear()
            try:
                self._send()
            except Exception:
                pass                       # reported via the "organ" event

    def _send(self) -> None:
        if not self._link.is_open():
            return
        with self._send_lock:
            snap = self.pattern()
            if self.organ_rev == snap["rev"]:
                return
            self._broadcast({"type": "organ", "state": "sending", "rev": snap["rev"]})
            try:
                ack = self._link.send_pattern(snap["tempo"], snap["grid"])
            except Exception as exc:
                self.organ_error = str(exc)
                self._broadcast({"type": "organ", "state": "error", "error": str(exc), "rev": snap["rev"]})
                raise
            try:
                self.organ_seq = int(ack.detail.split()[1])
            except (IndexError, ValueError):
                self.organ_seq = None
            self.organ_rev = snap["rev"]
            self.organ_error = None
            self._broadcast({"type": "organ", "state": "sent", "seq": self.organ_seq, "rev": snap["rev"]})

    # ------------------------------------------------------------ who's here
    def join(self, conn_id: str, name: str, role: str) -> dict:
        with self._lock:
            colour = COLOURS[0] if role == "host" else COLOURS[1 + self._next_colour % (len(COLOURS) - 1)]
            if role != "host":
                self._next_colour += 1
            clean = "".join(ch for ch in (name or "") if ch.isprintable()).strip()[:24].strip()
            user = {"id": conn_id, "name": clean or ("Host" if role == "host" else "Guest"),
                    "role": role, "colour": colour}
            self.users[conn_id] = user
        self._broadcast_presence()
        return user

    def leave(self, conn_id: str) -> None:
        with self._lock:
            self.users.pop(conn_id, None)
        self._broadcast_presence()

    def presence(self) -> List[dict]:
        with self._lock:
            return sorted(self.users.values(), key=lambda u: (u["role"] != "host", u["name"]))

    def _broadcast_presence(self) -> None:
        self._broadcast({"type": "presence", "users": self.presence()})
