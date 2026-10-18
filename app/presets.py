"""JSON preset save/load."""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List

from . import protocol

PRESET_DIR = Path.home() / ".calum_organ" / "presets"


@dataclass
class Preset:
    name: str
    tempo: int
    grid: List[List[int]]


def ensure_dir() -> None:
    PRESET_DIR.mkdir(parents=True, exist_ok=True)


def list_presets() -> List[str]:
    ensure_dir()
    return sorted(p.stem for p in PRESET_DIR.glob("*.json"))


def save(preset: Preset) -> Path:
    protocol.validate_pattern(preset.tempo, preset.grid)
    ensure_dir()
    path = PRESET_DIR / f"{preset.name}.json"
    path.write_text(json.dumps(asdict(preset), indent=2))
    return path


def delete(name: str) -> None:
    path = PRESET_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(path)
    path.unlink()


def load(name: str) -> Preset:
    path = PRESET_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(path)
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ValueError(f"corrupt preset {name}: {exc}") from exc
    try:
        preset = Preset(
            name=data["name"],
            tempo=int(data["tempo"]),
            grid=[[int(c) for c in row] for row in data["grid"]],
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"corrupt preset {name}: {exc}") from exc
    protocol.validate_pattern(preset.tempo, preset.grid)
    return preset
