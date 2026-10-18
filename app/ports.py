"""Serial port discovery."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from serial.tools import list_ports

GOOD_HINTS = (
    "usbserial",
    "usbmodem",
    "SLAB_USBtoUART",
    "wchusb",
    "CP210",
    "CH340",
)


@dataclass
class PortInfo:
    device: str
    description: str
    likely: bool

    def to_json(self) -> dict:
        return {
            "device": self.device,
            "description": self.description,
            "likely": self.likely,
        }


def list_serial_ports() -> List[PortInfo]:
    out: List[PortInfo] = []
    for p in list_ports.comports():
        dev = p.device or ""
        desc = p.description or ""
        likely = any(h.lower() in dev.lower() or h.lower() in desc.lower()
                     for h in GOOD_HINTS)
        out.append(PortInfo(device=dev, description=desc, likely=likely))
    out.sort(key=lambda p: (not p.likely, p.device))
    return out
