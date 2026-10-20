"""Line-based serial protocol between the app and the ESP32 sender.

The sender parses ASCII lines terminated with '\\n'. A pattern frame looks
like:

    PAT <tempo> <rows> <cols> <row0bits> <row1bits> ... <rowNbits>\\n

where each rowNbits is a string of '0' / '1' of length <cols>. Rows map 1:1
to ESP-NOW peers A..H, so at most 8 rows are supported.

The sender is the organ's clock. Its replies:

    OK PAT <seq>        pattern accepted; delivery continues in the background
    ACK <peer> <seq>    peer received pattern <seq>
    NAK <peer> <seq>    peer did not receive pattern <seq> after retries
    OK PLAY / OK STOP   transport changed
    STEP <n>            the pipes just played step n (sent once per step)
    PONG / ERR <reason>

This module is pure (no serial I/O) so it can be unit-tested trivially.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Sequence

MAX_ROWS = 8
MAX_COLS = 32
MIN_TEMPO = 20
MAX_TEMPO = 300


class ProtocolError(ValueError):
    """Raised when a pattern or frame fails validation."""


# ---------------------------------------------------------------------------
# encoding
# ---------------------------------------------------------------------------
def validate_pattern(tempo: int, grid: Sequence[Sequence[int]]) -> None:
    if not isinstance(tempo, int):
        raise ProtocolError(f"tempo must be int, got {type(tempo).__name__}")
    if not (MIN_TEMPO <= tempo <= MAX_TEMPO):
        raise ProtocolError(f"tempo {tempo} out of range [{MIN_TEMPO}, {MAX_TEMPO}]")

    rows = len(grid)
    if not (1 <= rows <= MAX_ROWS):
        raise ProtocolError(f"rows {rows} out of range [1, {MAX_ROWS}]")

    cols = len(grid[0]) if rows else 0
    if not (1 <= cols <= MAX_COLS):
        raise ProtocolError(f"cols {cols} out of range [1, {MAX_COLS}]")

    for i, row in enumerate(grid):
        if len(row) != cols:
            raise ProtocolError(f"row {i} has length {len(row)}, expected {cols}")
        for j, v in enumerate(row):
            if v not in (0, 1):
                raise ProtocolError(f"cell [{i}][{j}] = {v!r}, must be 0 or 1")


def encode_pattern(tempo: int, grid: Sequence[Sequence[int]]) -> bytes:
    """Encode a pattern as a protocol line (including trailing newline)."""
    validate_pattern(tempo, grid)
    rows = len(grid)
    cols = len(grid[0])
    parts: List[str] = ["PAT", str(tempo), str(rows), str(cols)]
    for row in grid:
        parts.append("".join(str(v) for v in row))
    return (" ".join(parts) + "\n").encode("ascii")


def encode_play() -> bytes:
    return b"PLAY\n"


def encode_stop() -> bytes:
    return b"STOP\n"


def encode_ping() -> bytes:
    return b"PING\n"


# ---------------------------------------------------------------------------
# decoding (for sender-side / sim / tests)
# ---------------------------------------------------------------------------
@dataclass
class Pattern:
    tempo: int
    rows: int
    cols: int
    grid: List[List[int]]


def decode_pattern(line: bytes | str) -> Pattern:
    text = line.decode("ascii") if isinstance(line, (bytes, bytearray)) else line
    text = text.strip()
    tokens = text.split()
    if not tokens or tokens[0] != "PAT":
        raise ProtocolError(f"not a PAT line: {text!r}")
    if len(tokens) < 4:
        raise ProtocolError(f"PAT frame too short: {text!r}")
    try:
        tempo = int(tokens[1])
        rows = int(tokens[2])
        cols = int(tokens[3])
    except ValueError as exc:
        raise ProtocolError(f"bad header ints: {exc}") from exc
    if len(tokens) != 4 + rows:
        raise ProtocolError(
            f"expected {rows} row payloads, got {len(tokens) - 4}"
        )
    grid: List[List[int]] = []
    for i, bits in enumerate(tokens[4:]):
        if len(bits) != cols:
            raise ProtocolError(f"row {i} length {len(bits)} != cols {cols}")
        if any(c not in "01" for c in bits):
            raise ProtocolError(f"row {i} has non-binary chars: {bits!r}")
        grid.append([int(c) for c in bits])
    validate_pattern(tempo, grid)
    return Pattern(tempo=tempo, rows=rows, cols=cols, grid=grid)


@dataclass
class Ack:
    kind: str           # 'OK', 'ERR', 'ACK', 'NAK', 'PONG', 'STEP', 'PIPE', 'DUP', 'INFO', 'LOG'
    detail: str = ""    # trailing text


def decode_reply(line: bytes | str) -> Ack:
    text = line.decode("ascii", errors="replace") if isinstance(line, (bytes, bytearray)) else line
    text = text.strip()
    if not text:
        return Ack(kind="", detail="")
    head, _, rest = text.partition(" ")
    if head in ("OK", "ERR", "ACK", "NAK", "PONG", "STEP", "PIPE", "DUP", "INFO"):
        return Ack(kind=head, detail=rest)
    return Ack(kind="LOG", detail=text)


# ---------------------------------------------------------------------------
# row-bits → bitfield (used by firmware packet builder and its host mirror)
# ---------------------------------------------------------------------------
def row_to_bitfield(row: Iterable[int]) -> int:
    """Pack a row of 0/1 ints into an integer. LSB is step 0."""
    value = 0
    for i, v in enumerate(row):
        if v:
            value |= 1 << i
    return value
