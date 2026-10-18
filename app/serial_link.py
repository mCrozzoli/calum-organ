"""Pure-stdlib serial transport. No Qt, no asyncio.

A background reader thread parses ACK / NAK / OK / ERR / STEP / LOG lines
and reports them through the ``on_event`` callback. The HTTP server turns
those events into Server-Sent Events for the browser.

Requests (PAT / PLAY / STOP) are serialised: one is on the wire at a time,
and each waits for its own OK before the next is written. Without this,
overlapping requests would consume each other's replies.
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import serial

from . import protocol


@dataclass
class LinkConfig:
    port: str
    baud: int = 115200
    ack_timeout_s: float = 1.0
    retries: int = 3


class SerialLink:
    """Thread-safe serial link with ack+retry. Emits events via callback."""

    def __init__(self, on_event: Optional[Callable[[dict], None]] = None) -> None:
        self._ser: Optional[serial.Serial] = None
        self._cfg: Optional[LinkConfig] = None
        self._reader: Optional[threading.Thread] = None
        self._reader_stop = threading.Event()
        self._reply_q: "queue.Queue[protocol.Ack]" = queue.Queue()
        self._write_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self.playing = False
        self._on_event = on_event or (lambda e: None)

    def _emit(self, event_type: str, **payload) -> None:
        try:
            self._on_event({"type": event_type, **payload})
        except Exception:
            pass

    # ------------------------------------------------------------------ lifecycle
    def is_open(self) -> bool:
        return self._ser is not None and self._ser.is_open

    @property
    def port(self) -> Optional[str]:
        return self._cfg.port if self.is_open() and self._cfg else None

    def open(self, cfg: LinkConfig) -> None:
        if self.is_open():
            raise RuntimeError("link already open")
        self._ser = serial.Serial(cfg.port, cfg.baud, timeout=0.1, write_timeout=1.0)
        self._cfg = cfg
        self._reader_stop.clear()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._emit("log", line=f"opened {cfg.port} @ {cfg.baud}", level="info")
        self._emit("status", connected=True, port=cfg.port)

    def close(self) -> None:
        if self._reader is not None:
            self._reader_stop.set()
            self._reader.join(timeout=1.0)
            self._reader = None
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None
        self._set_playing(False)
        self._emit("log", line="closed", level="info")
        self._emit("status", connected=False, port=None)

    # ------------------------------------------------------------------ reader
    def _read_loop(self) -> None:
        assert self._ser is not None
        buf = bytearray()
        while not self._reader_stop.is_set():
            try:
                chunk = self._ser.read(64)
            except (serial.SerialException, OSError) as exc:
                self._emit("log", line=f"serial read error: {exc}", level="err")
                self._set_playing(False)
                self._emit("status", connected=False, port=None)
                self._reply_q.put(protocol.Ack(kind="DISCONNECTED", detail=str(exc)))
                return
            if not chunk:
                continue
            buf.extend(chunk)
            while b"\n" in buf:
                line, _, buf = buf.partition(b"\n")
                ack = protocol.decode_reply(line)
                if ack.kind == "STEP":
                    # Once per step: drives the UI playhead, too noisy to log.
                    self._handle_step(ack)
                    continue
                text = line.decode("ascii", "replace").rstrip()
                self._emit("log", line=f"<< {text}", level=_classify(ack))
                if ack.kind in ("ACK", "NAK"):
                    self._handle_peer_ack(ack)
                elif ack.kind == "OK" and ack.detail in ("PLAY", "STOP"):
                    self._set_playing(ack.detail == "PLAY")
                elif ack.kind == "OK" and ack.detail == "READY":
                    # Sender (re)booted, e.g. reset by opening the port: it
                    # has no pattern and is stopped. The UI resends.
                    self._set_playing(False)
                    self._emit("ready")
                self._reply_q.put(ack)

    def _handle_step(self, ack: protocol.Ack) -> None:
        try:
            step = int(ack.detail.split()[0])
        except (ValueError, IndexError):
            return
        if not self.playing:
            # STEP proves the organ is running, even if we missed OK PLAY.
            self._set_playing(True)
        self._emit("step", step=step)

    def _set_playing(self, playing: bool) -> None:
        if playing == self.playing:
            return
        self.playing = playing
        self._emit("transport", playing=playing)

    def _handle_peer_ack(self, ack: protocol.Ack) -> None:
        try:
            parts = ack.detail.split()
            peer = int(parts[0])
            seq = int(parts[1]) if len(parts) > 1 else 0
        except (ValueError, IndexError):
            return
        self._emit("peer", peer=peer, ok=(ack.kind == "ACK"), seq=seq)

    # ------------------------------------------------------------------ writes
    def _write(self, frame: bytes) -> None:
        if self._ser is None:
            raise RuntimeError("link not open")
        with self._write_lock:
            self._emit("log",
                       line=f">> {frame.decode('ascii', 'replace').rstrip()}",
                       level="send")
            # No flush(): it waits (forever) until the device has read
            # everything. write_timeout bounds a stuck device instead.
            try:
                self._ser.write(frame)
            except serial.SerialTimeoutException as exc:
                raise TimeoutError("serial write timed out") from exc

    def _drain(self) -> None:
        while True:
            try:
                self._reply_q.get_nowait()
            except queue.Empty:
                return

    def _request(self, frame: bytes, expect: str) -> protocol.Ack:
        """Write ``frame`` and wait for ``OK <expect>``, retrying on timeout."""
        if not self.is_open():
            raise RuntimeError("link not open")
        assert self._cfg is not None
        with self._request_lock:
            last_err = "no reply"
            for attempt in range(1, self._cfg.retries + 1):
                self._drain()
                self._write(frame)
                deadline = time.monotonic() + self._cfg.ack_timeout_s
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        ack = self._reply_q.get(timeout=remaining)
                    except queue.Empty:
                        break
                    if ack.kind == "DISCONNECTED":
                        raise ConnectionError(ack.detail)
                    if ack.kind == "OK" and ack.detail.startswith(expect):
                        return ack
                    if ack.kind == "ERR":
                        # The sender understood and refused: retrying won't help.
                        raise ValueError(f"sender: {ack.detail}")
                last_err = f"timeout (attempt {attempt}/{self._cfg.retries})"
                self._emit("log", line=last_err, level="warn")
            raise TimeoutError(f"{expect} failed: {last_err}")

    def send_pattern(self, tempo: int, grid) -> protocol.Ack:
        return self._request(protocol.encode_pattern(tempo, grid), "PAT")

    def send_play(self) -> protocol.Ack:
        return self._request(protocol.encode_play(), "PLAY")

    def send_stop(self) -> protocol.Ack:
        return self._request(protocol.encode_stop(), "STOP")

    def send_ping(self) -> None:
        self._write(protocol.encode_ping())


def _classify(ack: protocol.Ack) -> str:
    if ack.kind in ("OK", "ACK", "PONG"):
        return "ok"
    if ack.kind == "NAK":
        return "warn"
    if ack.kind == "ERR":
        return "err"
    return "info"
