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
| Extras | demo organ, update board firmware | Quit button, **play together** (others join by QR code) |
| Both | simulated sound (SuperCollider in the browser), light/dark theme | |

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

## Playing together

Phones and laptops can join the laptop that's connected to the organ and
paint the pattern with you, live. Any number of devices, iPhones included.

1. On the laptop connected to the central ESP32, start the **local app**
   (double-click `Organ.command`) and connect the organ.
2. Click **Share…** → **Start sharing**. A QR code and a 4-digit join code
   appear. If the Mac asks whether Python may accept incoming connections,
   choose **Allow**.
3. Others, on the same Wi-Fi (or the laptop's hotspot), scan the QR code,
   type their name, and paint. If the code doesn't work, pick the other
   address in the Share dialog (the laptop may be on more than one network).

Everyone sees the same pattern, everyone's edits (flashed in their colour),
the organ's real playhead and who's here. Two people painting at the same
moment keep both their strokes: edits travel as single cells and the laptop
merges them before sending one pattern to the organ.

**The laptop (host) keeps control** of the organ connection, play/stop,
tempo, presets and Clear. Guests can only paint, and only with the code;
**Stop sharing** disconnects them all and invalidates the code. Guests'
phones load the app over the local network (plain http), where browsers
don't allow web audio, so they don't play the simulated sound; they hear
the organ.

## Listening without the organ

The **Listen** panel plays the demo organ (and the preview) as simulated
pipes, so you can hear a pattern before the hardware is there.

- **🔊 Sound on** starts the sound engine (browsers only allow audio after a
  click). Best with headphones. On iPhone the page asks for playback mode,
  so the silent switch doesn't mute it; if it's still silent, turn up the
  volume with the side buttons.
- **Sound** chooses what the pipes sound like:
  - **Recorded organ:** real notes of a chapel organ (a stopped flute stop),
    one recording every three semitones, so no pipe is shifted by more than
    1.5 semitones. Held notes loop seamlessly.
  - **Synth: stopped pipe:** SuperCollider synthesis using the harmonics and
    attack times measured from that recorded organ.
  - **Synth: open pipe:** SuperCollider synthesis of an open principal pipe.
- **The room:** a square seen from above, with you (🎧) facing the top. Drag
  the pipes, and yourself, around it; rings are every 2 m. Click a pipe to
  hear it. With the pipe focused, arrow keys move it.
- **Pitch:** choose each pipe's note (C2–C6); **+¼** raises it by a quarter
  tone. Set them to the real pipes' notes and the simulation sounds like the
  installation.
- **🎧 Headphones (3D)** places each pipe around you: the far ear hears it
  slightly later and duller, far pipes are quieter and more reverberant.
  Left/right and near/far are clear; front/back is only a hint (that needs a
  measured head model). **🔈 Speakers** pans left/right only.
- **Room size** sets how far apart things are, and the reverb.
- The **L/R meter** shows what's coming out of each side.

With the real organ connected the simulated sound mutes itself: you're
hearing the real pipes. The layout and pitches are saved in the browser.

### How the sound is made

SuperCollider, running in the browser: [SuperSonic](https://github.com/samaaron/supersonic)
compiles `scsynth` to WebAssembly (same setup and pinned version as the Dark
Sonification web designs; the `postMessage` transport needs no special
headers, so GitHub Pages works). The synthesis is ordinary SuperCollider:

- `sound/organ_synthdefs.scd`: `organPipe` (flue-pipe harmonics, breath
  noise, attack chiff), `organSample` (plays a recorded note, then cycles its
  steady part while the valve stays open), both placed by the same binaural
  or stereo code, and `organMaster` (reverb, volume, limiter).
- `app/static/js/sound.js`: boots the engine, loads the recordings into
  buffers, and sends OSC (`/s_new`, `/n_set`), one persistent synth per pipe.
- `app/static/corpus/`: the recorded organ, built by
  `tools/build_corpus.py` from the VSCO 2 CE files (see its README).

After changing the SynthDefs, rebuild and check them (needs SuperCollider
and ffmpeg):

```bash
/Applications/SuperCollider.app/Contents/MacOS/sclang tools/build_synthdefs.scd
ffmpeg -i app/static/corpus/organ-C3.ogg -ar 48000 -c:a pcm_f32le /tmp/organ-C3.wav
/Applications/SuperCollider.app/Contents/MacOS/sclang tools/check_synthdefs.scd /tmp/organ_check.wav /tmp/organ-C3.wav
python3 tools/check_synthdefs.py /tmp/organ_check.wav
```

The check renders pipes offline and measures them: louder and earlier in
the near ear, quieter when far, silent with the valve closed, a held
recorded note looping without clicks or dips, and the synth and the
recording at the same loudness.

To rebuild the recorded organ, download `Keys/Organ/Quiet/NT5_Man3Quiet_122…170_rr1.wav`
from <https://github.com/sgossner/VSCO-2-CE> into a folder, then:

```bash
python3 tools/build_corpus.py <that folder>
```

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
│   ├── server.py           # stdlib HTTP + Server-Sent Events, host/guest roles
│   ├── session.py          # the shared pattern, who's here, sending to the organ
│   ├── share.py            # the guest listener, join code, network addresses
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
│       ├── js/sound.js     # SuperCollider (SuperSonic) sound engine
│       ├── js/stage.js     # listening stage: positions, pitches
│       ├── js/corpus.js    # sound sources: which recording / spectrum
│       ├── corpus/         # recorded organ (VSCO 2 CE, CC0), see its README
│       ├── synthdefs/      # compiled .scsyndef (built from sound/)
│       ├── vendor/         # SuperSonic 0.71.0 (see vendor/README.md)
│       └── firmware/       # binaries for the web updater
├── firmware/
│   ├── calum_sender/       # USB board: parser + master clock
│   └── calum_receiver/     # pipe boards: follow ticks, drive relay
├── sound/organ_synthdefs.scd  # the simulated pipes, in SuperCollider
├── tools/
│   ├── build_firmware.sh   # rebuild app/static/firmware/
│   ├── build_synthdefs.scd # rebuild app/static/synthdefs/
│   ├── build_corpus.py     # rebuild app/static/corpus/ from VSCO 2 CE
│   ├── version_assets.py   # publish step: ?v= on file references
│   ├── check_synthdefs.*   # render offline + measure placement
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
  Light/dark theme. Simulated pipe sound in SuperCollider (SuperSonic),
  with a draggable listening stage, per-pipe pitch (quarter tones too) and
  headphone 3D. Recorded-organ sound source (VSCO 2 CE), synth voices
  modelled on it, and an About & credits panel. Play together: guests join
  the local app by QR code over Wi-Fi and paint the shared pattern. iPhone
  sound fix (audio unlocked in the tap, silent switch bypassed).

## Credits and licences

The app's **About & credits** panel (More ▾, or the page footer) lists
everyone: Calum (organ and concept), Miguel Angel Crozzoli (software), built
with Claude AI as a co-designing agent, and the projects below.

- `app/static/vendor/`: SuperSonic 0.71.0 (Sam Aaron). The client is MIT,
  the `scsynth` engine (`supersonic-core`) is GPL-3.0-or-later; their licence
  files are next to them. Later SuperSonic versions are AGPL-3.0, which is
  why it's pinned.
- `app/static/corpus/`: organ recorded by Simon Dalzell (Ivy Audio) for
  Versilian Studios Chamber Orchestra 2: Community Edition, CC0.
- Firmware: Arduino-ESP32 core (LGPL-2.1), ESP-IDF (Apache-2.0). Web
  updater: ESP Web Tools (Apache-2.0).
- `app/static/vendor/qrcode-generator/`: QR codes for sharing, by Kazuhiko
  Arase (MIT).

This project's own code has no licence file yet.
