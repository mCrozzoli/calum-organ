"""The recorded-organ corpus (app/static/corpus) is complete and consistent."""
from __future__ import annotations

import json
from pathlib import Path

CORPUS = Path(__file__).resolve().parent.parent / "app" / "static" / "corpus"
DATA = json.loads((CORPUS / "corpus.json").read_text())
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def test_licence_and_credit():
    assert DATA["license"] == "CC0-1.0"
    assert "Simon Dalzell" in DATA["credit"]


def test_one_note_every_three_semitones_c2_to_c6():
    nominal = [m for m in range(36, 85, 3)]
    assert [round(s["midi"]) for s in DATA["samples"]] == nominal
    for s, m in zip(DATA["samples"], nominal):
        assert s["note"] == f"{NAMES[m % 12]}{m // 12 - 1}"
        assert abs(s["midi"] - m) < 0.25, f"{s['note']} measured {s['midi']}"


def test_files_are_ogg_opus_and_loops_fit():
    for s in DATA["samples"]:
        data = (CORPUS / s["file"]).read_bytes()
        assert data[:4] == b"OggS" and b"OpusHead" in data[:64], s["file"]
        assert 0 < s["loopStart"] < s["loopEnd"] <= s["duration"], s["file"]
        assert s["loopEnd"] - s["loopStart"] > 1.0          # long enough not to sound like a loop


def test_synth_model_matches_the_samples():
    assert len(DATA["model"]) == len(DATA["samples"])
    for m in DATA["model"]:
        assert len(m["harmonics"]) == 8 and m["harmonics"][0] == 1.0
        assert all(0 <= h <= 1 for h in m["harmonics"])
        assert 0.02 <= m["attack"] <= 0.3
