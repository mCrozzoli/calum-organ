import pytest

from app import protocol


def test_encode_roundtrip():
    grid = [[1, 0, 1, 1], [0, 0, 1, 0]]
    frame = protocol.encode_pattern(120, grid)
    assert frame.endswith(b"\n")
    pat = protocol.decode_pattern(frame)
    assert pat.tempo == 120
    assert pat.rows == 2
    assert pat.cols == 4
    assert pat.grid == grid


def test_boundary_1x1():
    frame = protocol.encode_pattern(20, [[1]])
    pat = protocol.decode_pattern(frame)
    assert pat.tempo == 20 and pat.grid == [[1]]


def test_boundary_8x32():
    grid = [[(i + j) & 1 for j in range(32)] for i in range(8)]
    pat = protocol.decode_pattern(protocol.encode_pattern(300, grid))
    assert pat.grid == grid


@pytest.mark.parametrize("tempo", [0, 19, 301, 999])
def test_bad_tempo(tempo):
    with pytest.raises(protocol.ProtocolError):
        protocol.encode_pattern(tempo, [[1]])


def test_too_many_rows():
    with pytest.raises(protocol.ProtocolError):
        protocol.encode_pattern(120, [[1]] * 9)


def test_too_many_cols():
    with pytest.raises(protocol.ProtocolError):
        protocol.encode_pattern(120, [[0] * 33])


def test_bad_cell_value():
    with pytest.raises(protocol.ProtocolError):
        protocol.encode_pattern(120, [[0, 2]])


def test_jagged_grid():
    with pytest.raises(protocol.ProtocolError):
        protocol.encode_pattern(120, [[0, 1], [1]])


def test_decode_rejects_bad_header():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode_pattern(b"NOPE 1 1 1 0\n")


def test_decode_rejects_wrong_row_length():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode_pattern(b"PAT 120 1 4 010\n")


def test_decode_reply_kinds():
    assert protocol.decode_reply(b"OK PAT 3").kind == "OK"
    assert protocol.decode_reply(b"ERR tempo").kind == "ERR"
    assert protocol.decode_reply(b"ACK 2 17").kind == "ACK"
    assert protocol.decode_reply(b"hello").kind == "LOG"


def test_row_to_bitfield():
    assert protocol.row_to_bitfield([1, 0, 1, 1]) == 0b1101
    assert protocol.row_to_bitfield([0] * 8) == 0


def test_decode_step_reply():
    ack = protocol.decode_reply(b"STEP 7\r\n")
    assert ack.kind == "STEP" and ack.detail == "7"
