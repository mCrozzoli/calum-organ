# Hardware notes

## Boards (ESP-NOW peers)

The pipe order is set in `firmware/*/peers.h` (both copies must match).
To read a new board's MAC, flash `tools/get_mac/get_mac.ino` and open the
Serial Monitor at 115200.

| Pipe | MAC | Notes |
|---|---|---|
| A | 94:B9:7E:F9:10:F0 | "Calum's MAC" |
| B | 94:B9:7E:FA:A4:EC | |
| C | 94:B9:7E:FA:30:8C | |
| D | 4C:EB:D6:75:BB:64 | |
| E | C8:F0:9E:F4:9B:8C | |
| F | C8:F0:9E:F4:93:B0 | |
| G | C8:F0:9E:F2:B7:10 | |
| H | 08:3A:F2:7D:2F:1C | |

Boards marked dead in the 2023 notes (do not reuse without testing):

- 08:3A:F2:7C:1A:9C (was pipe 1)
- 4C:EB:D6:75:C1:F0 (was pipe 4)

## Wiring

Each receiver drives a relay on **GPIO22**. Most cheap relay boards are
active-LOW; if a valve is open when it should be closed, flip
`RELAY_ACTIVE` / `RELAY_IDLE` at the top of `calum_receiver.ino`.

## Arduino setup

- Board package: **esp32 by Espressif**. Tested to compile on 2.0.14 and
  3.3.12.
- Board: "ESP32 Dev Module" (`esp32:esp32:esp32`).
- Easiest: open the online app in Chrome, **More ▾ → Update board
  firmware…**, and plug each board in by USB in turn.
- Or with the Arduino IDE: flash `firmware/calum_sender` to the board
  plugged into the computer, and `firmware/calum_receiver` to every pipe
  board.
- At start-up each board prints its firmware version and MAC address
  (Serial Monitor at 115200, or "Logs & Console" in the web updater).
- **Sender and receivers must run the same firmware version.** v1.1
  changed the radio packet, so v1.0 boards ignore v1.1 messages.
