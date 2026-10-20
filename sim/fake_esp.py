"""Pure-Python stand-in for the ESP32 sender.

Two modes:

  python -m sim.fake_esp --pty
      Opens a pseudo-terminal pair, prints the slave path, and speaks the
      v9 protocol on the master end. Paste the printed path into the app's
      port picker ("Manual…") and you can drive the UI without hardware.

  python -m sim.fake_esp --port /dev/ttys002
      Attach to an existing serial device (e.g. a USB loopback).

It behaves like the v1.2 hub (sender) firmware: every PAT is answered with
OK PAT <seq>, then ACK <peer> <seq> for each row's peer (NAK for peers
listed in --offline). PLAY starts a clock that emits STEP <n> at the
pattern tempo; STOP stops it. The pattern is rendered as ASCII art.

  python -m sim.fake_esp --pty --offline C,F
      Pretend pipes C and F are unreachable.
"""
from __future__ import annotations

import argparse
import os
import select
import sys
import threading
import time
from typing import BinaryIO

from app import protocol  # noqa: E402  (package import)


def _render(pat: protocol.Pattern) -> str:
    header = f"-- tempo={pat.tempo}bpm rows={pat.rows} cols={pat.cols} --"
    body = []
    for i, row in enumerate(pat.grid):
        body.append(f"  {chr(ord('A') + i)} │ " + "".join("█" if c else "·" for c in row))
    return "\n".join([header, *body])


class Engine:
    def __init__(self, write: "callable[[bytes], None]", offline: frozenset = frozenset()) -> None:
        self._write_raw = write
        self._write_lock = threading.Lock()
        self._offline = offline
        self._seq = 0
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._tempo = 120
        self._cur_steps = 0
        self._next_steps = 0
        self._step = 0
        self._clock_stop: "threading.Event | None" = None

    def _write(self, data: bytes) -> None:
        with self._write_lock:
            self._write_raw(data)

    @property
    def playing(self) -> bool:
        return self._clock_stop is not None

    def feed(self, chunk: bytes) -> None:
        self._buf.extend(chunk)
        while b"\n" in self._buf:
            line, _, self._buf = self._buf.partition(b"\n")
            self._handle(line.decode("ascii", "replace").strip())

    def _handle(self, line: str) -> None:
        if not line:
            return
        if line.startswith("PAT"):
            try:
                pat = protocol.decode_pattern(line)
            except protocol.ProtocolError as exc:
                self._write(f"ERR {exc}\n".encode())
                return
            with self._lock:
                self._seq = (self._seq + 1) & 0xFFFF
                self._tempo = pat.tempo
                self._next_steps = pat.cols
                if not self.playing:
                    self._cur_steps = pat.cols
                seq = self._seq
            print(_render(pat), flush=True)
            self._write(f"OK PAT {seq}\n".encode())
            for peer in range(pat.rows):
                kind = "NAK" if chr(ord("A") + peer) in self._offline else "ACK"
                self._write(f"{kind} {peer} {seq}\n".encode())
        elif line == "PLAY":
            if self._next_steps == 0:
                self._write(b"ERR no pattern\n")
                return
            self.stop_clock()
            with self._lock:
                self._step = 0
                self._cur_steps = self._next_steps
            self._clock_stop = threading.Event()
            threading.Thread(target=self._clock, args=(self._clock_stop,), daemon=True).start()
            self._write(b"OK PLAY\n")
            print("[sim] PLAY", flush=True)
        elif line == "STOP":
            self.stop_clock()
            self._write(b"OK STOP\n")
            print("[sim] STOP", flush=True)
        elif line == "PING":
            self._write(b"PONG\n")
        elif line == "PIPES":
            for i in range(8):
                self._write(f"PIPE {i} DE:E0:00:00:00:0{i} 1.2\n".encode())
            self._write(b"OK PIPES\n")
        else:
            self._write(f"ERR unknown: {line}\n".encode())

    def stop_clock(self) -> None:
        if self._clock_stop is not None:
            self._clock_stop.set()
            self._clock_stop = None

    def _clock(self, stop: threading.Event) -> None:
        next_tick = time.monotonic()
        while not stop.is_set():
            with self._lock:
                if self._step == 0:
                    self._cur_steps = self._next_steps
                step = self._step
                self._step = 0 if step + 1 >= self._cur_steps else step + 1
                step_s = 60.0 / self._tempo
            self._write(f"STEP {step}\n".encode())
            next_tick += step_s
            stop.wait(max(0.0, next_tick - time.monotonic()))


# ---------------------------------------------------------------------------
# runners
# ---------------------------------------------------------------------------
def read_available(fd: int, stop: threading.Event, n: int = 256) -> bytes:
    """os.read that wakes up every 100 ms to check ``stop``."""
    while not stop.is_set():
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            return os.read(fd, n)
    return b""


def run_pty(offline: frozenset) -> None:
    master, slave = os.openpty()
    slave_path = os.ttyname(slave)
    print(f"[sim] paste this into the app's 'Manual…' port picker:\n  {slave_path}",
          flush=True)

    def write(data: bytes) -> None:
        os.write(master, data)

    engine = Engine(write, offline)
    try:
        while True:
            try:
                chunk = os.read(master, 256)
            except OSError:
                time.sleep(0.05)
                continue
            if chunk:
                engine.feed(chunk)
    except KeyboardInterrupt:
        print("\n[sim] bye")


def run_port(path: str, offline: frozenset) -> None:
    import serial  # local import so --pty works without pyserial installed
    ser = serial.Serial(path, 115200, timeout=0.1)
    engine = Engine(lambda data: ser.write(data), offline)
    try:
        while True:
            chunk = ser.read(256)
            if chunk:
                engine.feed(chunk)
    except KeyboardInterrupt:
        ser.close()
        print("\n[sim] bye")


def main() -> int:
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--pty", action="store_true", help="create a pseudo-terminal pair")
    group.add_argument("--port", help="attach to an existing serial device")
    ap.add_argument("--offline", default="",
                    help="comma-separated pipes to treat as unreachable, e.g. C,F")
    args = ap.parse_args()
    offline = frozenset(p.strip().upper() for p in args.offline.split(",") if p.strip())
    if args.pty:
        run_pty(offline)
    else:
        run_port(args.port, offline)
    return 0


if __name__ == "__main__":
    sys.exit(main())
