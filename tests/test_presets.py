import json
from pathlib import Path

import pytest

from app import presets


@pytest.fixture(autouse=True)
def _isolated_preset_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(presets, "PRESET_DIR", tmp_path / "presets")


def test_save_and_load():
    p = presets.Preset(name="test", tempo=110, grid=[[1, 0, 1], [0, 1, 0]])
    presets.save(p)
    loaded = presets.load("test")
    assert loaded == p


def test_list_presets_sorted():
    for name in ("b", "a", "c"):
        presets.save(presets.Preset(name=name, tempo=120, grid=[[1]]))
    assert presets.list_presets() == ["a", "b", "c"]


def test_corrupt_file(tmp_path):
    presets.ensure_dir()
    bad = presets.PRESET_DIR / "broken.json"
    bad.write_text("{not json")
    with pytest.raises(ValueError):
        presets.load("broken")


def test_invalid_tempo_rejected_on_save():
    with pytest.raises(Exception):
        presets.save(presets.Preset(name="x", tempo=0, grid=[[1]]))


def test_missing_preset():
    with pytest.raises(FileNotFoundError):
        presets.load("nope")


def test_delete():
    presets.save(presets.Preset(name="gone", tempo=120, grid=[[1]]))
    presets.delete("gone")
    assert presets.list_presets() == []
    with pytest.raises(FileNotFoundError):
        presets.delete("gone")
