# Calum Organ — Pipe Madness v1.1

A step sequencer that drives a pipe organ built from solenoid valves. You
draw a rhythm grid in the browser: each row is a pipe (A–H), each column a
step. The pattern goes over USB to an **ESP32 sender**, which sends each
pipe its row over ESP-NOW and then acts as the organ's clock: on every step
it broadcasts one tick to all receivers at once, so the pipes play exactly
together.

**Open it online: <https://mcrozzoli.github.io/calum-organ/>** (Chrome or
Edge on a computer).

## Two ways to run it

The same app runs in two places; the version name in the top-left corner
says which one you're in.

| | **Online** | **Local app** |
|---|---|---|
| Start | open the link above | double-click `Organ.command` |
| Talks to the sender | directly, from the browser (Web Serial) | through a small Python program |
| Browser | Chrome or Edge on a computer | any |
| Needs | internet to open the page | Python 3 (set up automatically) |
| Presets | stored in that browser (export/import to move them) | files in `~/.calum_organ/presets/` |
| Extras | demo organ, update board firmware | Quit button |

```
 Online:      Browser ── Web Serial (USB) ──▶ ESP32 sender ── ESP-NOW ──▶ 8× receiver ──▶ pipes
 Local app:   Browser ── HTTP/SSE ──▶ Python server ── USB ──▶ ESP32 sender ── … ──▶ pipes
```

Either way, only the sender plugs into the computer. The pipe boards only
need power.

## Quick start (Calum)

1. Plug the ESP32 sender into the computer by USB.
2. Open **<https://mcrozzoli.github.io/calum-organ/>** in Chrome or Edge
   (or double-click **`Organ.command`** for the local app).
3. In the port menu choose **Choose USB device…**, click **Connect** and pick
   the board in Chrome's list (ESP32 boards are marked ★ after the first
   time). The organ gets whatever is on screen.
5. Click or drag on the grid to paint (drag starting on a lit cell to erase;
   right-click also erases). Set the tempo, then press **▶ Play**. **■ Stop** silences
   every pipe.
6. **Save…** stores the pattern by name (a dot on the button means unsaved
   changes). Pick one from the preset menu to load it; it's sent to the
   organ straight away, and you're warned first if that would discard
   unsaved changes. **Delete** removes the selected preset.

Keyboard: `Space` = play/stop, `C` = clear. Works on a phone or tablet too
(touch to paint) if the server is reachable from it.

No hardware? Choose **Demo organ** in the port menu to try everything with
a simulated organ.

Finishing:
- **Online:** press **■ Stop**, then **Disconnect** or close the tab. The
  sender keeps the beat by itself, so closing the tab while playing leaves
  the organ playing (the browser warns you).
- **Local app:** click **Quit** (top right). It stops the organ, disconnects
  and closes the app. `Ctrl+C` in the Terminal window does the same. Closing
  only the browser tab leaves the app running.

The pattern on screen is remembered by the browser, so a reload or a
closed tab doesn't lose it.

## Reading the screen

The bar under the toolbar always says what you're looking at:

| Badge | Meaning |
|---|---|
| **PREVIEW** | Not connected. The playhead is a local preview (dashed outline, outlined pipes); the organ is not playing. |
| **LIVE · STOPPED** | Connected, organ silent. |
| **LIVE · PLAYING** | The playhead moves only when the sender reports a step, so it shows what the organ is doing. |
| **DEMO** | Connected to the simulated organ. Drawn like the preview; no hardware is moving. |
| **NO BEAT** | The organ should be playing, but no steps are arriving: check the sender. |

On the right side of that bar, the app shows whether the organ has your latest
edit ("Organ has pattern #12") or is still sending it. Each pipe card shows
**up to date** (got the latest pattern), **sending**, **missed** (didn't
answer after 3 tries: check power and range), or **unused** (beyond the
number of pipes in the grid).

Edits, tempo, pipe/step counts and presets are sent to the organ
immediately while connected. A change in step count takes effect at the
start of the next bar so the rhythm doesn't stumble.

## Safety behaviour

- **Stop** is broadcast 3 times; receivers also close their valve by
  themselves if they hear no beat for 2 s (sender unplugged, out of range).
- If a single beat is lost over the radio, the receiver plays the next
  step on its own clock (at most 25 ms late) and re-syncs on the next beat.
- If the sender reboots, the app notices and resends the pattern.
- Reloading the page or opening a second tab shows what the organ is
  playing; it never overwrites it with a blank grid.

## Updating board firmware

Online, **More ▾ → Update board firmware…** installs the current firmware
on a board plugged in by USB: no Arduino IDE needed. Do the sender and then
each pipe, one at a time. (Uses Espressif's
[ESP Web Tools](https://esphome.github.io/esp-web-tools/).)

The binaries it installs live in `app/static/firmware/`. After changing
anything in `firmware/`, rebuild them with:

```bash
./tools/build_firmware.sh
```

## Testing without hardware

Online or in the local app: choose **Demo organ** in the port menu. For the
local app there's also a simulator that pretends to be a USB port. In a
second terminal:

```bash
cd calum-organ
.venv/bin/python -m sim.fake_esp --pty
```

It prints a path like `/dev/ttys004`. In the app, choose **Other port…**
and enter it. The simulator behaves like the sender firmware: it ACKs
patterns, keeps time and reports steps, and prints each pattern as ASCII
art. Add `--offline C,F` to pretend pipes C and F are unreachable.

## Running tests

```bash
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

This also runs the browser-side tests (`tests/js`) if Node.js is installed.
Every push to `main` runs the tests on GitHub and then publishes
`app/static` to GitHub Pages (`.github/workflows/pages.yml`).

## Firmware

See [docs/HARDWARE.md](docs/HARDWARE.md) for board MACs, wiring and the
Arduino setup. Flash `firmware/calum_sender` to the USB board and
`firmware/calum_receiver` to every pipe board. **v1.1 changed the radio
packet: update the sender and all receivers together.**

Both sketches compile on ESP32 Arduino core 2.0.14 and 3.3.12.
`peers.h` exists in both sketch folders (Arduino needs it there). Keep the
two copies identical; a test checks this.

## Protocol

Line-based ASCII over USB serial, 115200 baud:

```
host → sender:  PAT <tempo> <rows> <cols> <row0bits> ... <rowNbits>
                PLAY   STOP   PING
sender → host:  OK PAT <seq>   ACK <peer> <seq>   NAK <peer> <seq>
                OK PLAY   OK STOP   OK READY   PONG   STEP <n>   ERR <reason>
```

`tempo` is in steps per minute (one step = 60000/tempo ms). `OK PAT` means
the sender accepted the pattern; ACK/NAK per pipe follow as delivery
finishes. `STEP <n>` is sent once per step while playing. Implemented twice,
kept in step by tests: `app/protocol.py` (local app) and
`app/static/js/protocol.js` (browser).

Over the radio (`firmware/*/peers.h`), the sender unicasts one `PKT_PATTERN`
per pipe (with retry), broadcasts `PKT_TICK {step, tempo, rows}` every step,
and broadcasts `PKT_STOP` to stop.

## Project layout

```
calum-organ/
├── Organ.command           # double-click launcher
├── README.md
├── pyproject.toml
├── app/                    # local app (Python server) + the web UI
│   ├── __main__.py         # starts server, opens browser
│   ├── server.py           # stdlib HTTP + Server-Sent Events
│   ├── serial_link.py      # serial transport, one request at a time
│   ├── protocol.py         # encoder/decoder + validators
│   ├── ports.py            # port discovery
│   ├── presets.py          # presets in ~/.calum_organ/presets/
│   └── static/             # the web UI = the GitHub Pages site
│       ├── index.html, app.css
│       ├── js/app.js       # UI
│       ├── js/backends.js  # local app vs online (Web Serial / demo)
│       ├── js/link.js      # serial link + Web Serial transport
│       ├── js/protocol.js  # same protocol as app/protocol.py
│       ├── js/demo.js      # simulated organ
│       └── firmware/       # binaries for the web updater
├── firmware/
│   ├── calum_sender/       # USB board: parser + master clock
│   └── calum_receiver/     # pipe boards: follow ticks, drive relay
├── tools/
│   ├── build_firmware.sh   # rebuild app/static/firmware/
│   └── get_mac/            # prints a board's MAC address
├── sim/fake_esp.py         # USB stand-in for the sender (local app)
├── tests/                  # pytest + tests/js (node --test)
├── docs/                   # hardware notes, audit
├── .github/workflows/      # test + publish to GitHub Pages
└── TODO.md                 # backlog: accessibility, MIDI controllers
```

## History

- 2023 (v4–v8): Tkinter/Jupyter UIs with OSC-over-SLIP. Retired.
- v0.9 (Apr 2026): rewrite with a PyQt6 UI. Retired.
- v1.0 (Apr 2026): browser UI, pyserial only.
- v1.1 (Oct 2026): sender is the master clock (real Play/Stop, pipes in
  sync), screen shows real organ state, live resend of every change,
  touch support, reworked UI, preset delete + unsaved-changes warning,
  Quit button, receivers ride through lost beats. Online version on GitHub
  Pages (Web Serial, demo organ, firmware updates from the browser).
