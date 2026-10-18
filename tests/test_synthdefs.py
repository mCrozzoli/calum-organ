"""The compiled SynthDefs (app/static/synthdefs) must match what the browser
code sends them, and only use UGens the bundled scsynth engine has."""
from __future__ import annotations

import re
import struct
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "app" / "static"
DEFS = STATIC / "synthdefs"
WASM = STATIC / "vendor" / "supersonic-core" / "wasm" / "scsynth-nrt.wasm"
SOUND_JS = (STATIC / "js" / "sound.js").read_text()


def read(path: Path):
    """name -> (control names, UGen class names) for every def in the file."""
    data = path.read_bytes()
    pos = 4 + 4
    out = {}

    def i32(at):
        return struct.unpack_from(">i", data, at)[0]

    def i16(at):
        return struct.unpack_from(">h", data, at)[0]

    def pstr(at):
        n = data[at]
        return data[at + 1:at + 1 + n].decode("ascii"), at + 1 + n

    assert data[:4] == b"SCgf" and i32(4) == 2
    n_defs = i16(pos); pos += 2
    for _ in range(n_defs):
        name, pos = pstr(pos)
        n_consts = i32(pos); pos += 4 + 4 * n_consts
        n_params = i32(pos); pos += 4 + 4 * n_params
        n_names = i32(pos); pos += 4
        controls = []
        for _ in range(n_names):
            cname, pos = pstr(pos)
            pos += 4
            controls.append(cname)
        n_ugens = i32(pos); pos += 4
        ugens = set()
        for _ in range(n_ugens):
            cls, pos = pstr(pos)
            ugens.add(cls)
            pos += 1                               # rate
            n_in = i32(pos); n_out = i32(pos + 4); pos += 8 + 2
            pos += 8 * n_in + n_out
        n_variants = i16(pos); pos += 2
        for _ in range(n_variants):
            _, pos = pstr(pos)
            pos += 4 * n_params
        out[name] = (controls, ugens)
    assert pos == len(data), "trailing bytes: parser out of step"
    return out


PIPE = read(DEFS / "organPipe.scsyndef")["organPipe"]
SAMPLE = read(DEFS / "organSample.scsyndef")["organSample"]
MASTER = read(DEFS / "organMaster.scsyndef")["organMaster"]


def test_controls_match_the_engine_code():
    # every "name", value pair sent with /s_new or /n_set in sound.js
    # every "name" sent with /s_new, /n_set or /n_setn in sound.js
    sent = set(re.findall(r'"(out|revOut|in|revIn|freq|gate|amp|azimuth|distance|binaural|reverb|room|'
                          r'attack|harm|buf|rate|loopStart|loopEnd)"', SOUND_JS))
    assert sent, "found no controls in sound.js"
    known = set(PIPE[0]) | set(SAMPLE[0]) | set(MASTER[0])
    assert sent <= known, f"sound.js sends controls the SynthDefs don't have: {sent - known}"
    shared = {"gate", "amp", "azimuth", "distance", "binaural", "reverb", "out", "revOut"}
    assert shared <= set(PIPE[0]) and shared <= set(SAMPLE[0]), "both pipe kinds take the same placement"
    assert {"freq", "attack", "harm"} <= set(PIPE[0])
    assert {"buf", "rate", "loopStart", "loopEnd"} <= set(SAMPLE[0])


def test_only_ugens_the_browser_engine_has():
    wasm = WASM.read_bytes()
    pseudo = {"Control", "BinaryOpUGen", "UnaryOpUGen", "MulAdd", "Sum3", "Sum4"}
    for ugen in (PIPE[1] | SAMPLE[1] | MASTER[1]) - pseudo:
        # Names are stored NUL-terminated, sometimes as the tail of a longer
        # name (the linker merges "SinOsc" into "FSinOsc"), so match the end.
        assert re.search(re.escape(ugen.encode()) + b"\x00", wasm), f"{ugen} not in scsynth-nrt.wasm"
