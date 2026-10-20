# Calum Organ — Pipe Madness v1.4

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
| Play together | **rooms** over the internet: anyone with the link joins | guests on the same Wi-Fi join by QR code |
| Extras | demo organ, update board firmware | Quit button, works without internet |
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

## Figures, each pipe's own rhythm, and meter

**Figures (articulation).** A lit cell can play a figure inside its step.
Pick one in the row of buttons above the grid; painting an empty cell puts
it there. Right-click a cell (or hold a finger on it) to change its figure.

| Figure | The valve… |
|---|---|
| ■ full | open the whole step; full steps side by side are one long note |
| ◐ detached | open most of the step, so the next note starts again |
| · staccato | short |
| ⁚ ⁝ ⁞ 2 / 3 / 4 repeats | quick notes inside the step (3 = a triplet) |
| ◑ offbeat | only the second half of the step |

A solenoid needs time to open and close: the app warns when a figure, at
the current tempo and speed, asks it to move faster than about 25 ms (a
guess until measured on the real pipes).

**Each pipe's own rhythm.** Click a pipe's letter (left of the grid):

- **Length**: the row can loop fewer steps than the grid, e.g. A 16, B 12,
  C 7 (polymeter): they shift against each other and come back in line.
  Steps past a row's length are faded.
- **Speed**: same as everyone, a **ratio** to the master beat (1:2, 2:3,
  3:4, 4:5, 5:4, 4:3, 3:2, 2:1: polyrhythm), or **its own tempo** (e.g. 121
  against 120: it drifts in and out of step, like Steve Reich's phasing).

The letter shows the row's length and speed; each row has its own playhead.
The master tempo stays the reference everything is measured against.

**Meter.** *Beat* (next to Steps) groups the steps: 4, 3, 2, 5, 7, or
additive groupings such as 3+3+2 and 2+2+3 (or type your own). It draws
the beat lines; tuplets within a beat come from the repeat figures, and
across pipes from their speeds.

The hub keeps one master beat and counts steps; each pipe works out where
it is from that count and its own speed, between beats too, so everything
stays locked and lines up again where it should. Figures and per-pipe
rhythm need **firmware 1.4 on the hub and every pipe** (More ▾ → Boards);
with an older hub the organ plays every lit cell as a full step, all at one
speed, and the app says so. The local app plays on/off at one speed only.

## MIDI keyboards and pads

Plug a MIDI controller into the computer by USB and click **🎹 MIDI** (top
right; Chrome or Edge). The first time, **Turn on MIDI** and allow it.
Controllers are found as they're plugged in and out.

- **Keyboard** (plug and play): each key plays the pipe **tuned closest**
  to it, using the pitches in the Listen panel (set those to the real
  pipes' notes). Held keys open their pipes straight away, **on top of the
  pattern**; the **sustain pedal** keeps them open.
- **Pads** (nanoPAD, MPD…): consecutive pads play A, B, C… from a base note
  (36 by default; **Set the pad for pipe A…** changes it).
- **Pad grids** (Launchpad Mini MK3, Launchpad X, APC mini, APC mini mk2):
  the 8×8 pads show the pattern and edit it (rows = pipes A–H, 8 steps per
  page, following the playhead; the arrow buttons change page), the side
  buttons play each pipe live. A Launchpad needs **Light up the
  Launchpad…** once: the browser asks for full MIDI access to switch it into
  that mode. On the APC minis, the rightmost fader sets the tempo.
- **Link a control**: choose Pipe A–H, Play/Stop, Record, Clear, Tempo or
  Sustain, click **Learn**, then press the key, pad or button (or move the
  knob). Links are saved per controller in this browser.
- **● Rec** (next to Clear): while the pattern plays, keys you press are
  written into the grid at the current step (a key in the second half of a
  step lands on the next one).

**■ Stop** also lets go of every live note. Playing the real pipes live
needs hub firmware 1.3 (More ▾ → Boards); with an older hub, keys play the
simulated sound only. MIDI works in the online version; the local app plays
live notes on the simulated sound only.

## Gestures: phone or PS5 controller

**🎮 Gestures** teaches the organ your moves and plays from them (learning
by example, as in Rebecca Fiebrink's Wekinator). Choose the controller:
**this phone's motion** (open the site or the room link on a phone), a
**PS5 controller** (Chrome or Edge on a computer, USB or Bluetooth) or **any
game controller**. Then four steps:

1. **Teach**: pick the pipes this pose plays (none = a *silence* pose) and,
   for learned controls, their values (e.g. tempo 60); hold **Hold to record
   this pose** while holding it (moving a little helps). Repeat per pose. On
   a PS5 controller, hold ✕ to record.
2. **Map**: what the model listens to and what it plays.
   - **Inputs**, each with a live meter and a tick box, or a set at once
     (*Tilt only*, *Tilt + turn*, *Tilt + moves*, *Everything*):

     | Controller | Inputs |
     |---|---|
     | Phone | tilt x/y/z, turn x/y/z, compass heading, the on-screen touch pad (x, y, touching) |
     | PS5 | tilt, turn, both sticks, L2/R2, the touchpad (x, y, touching) |
     | Gamepad | both sticks, both triggers |
     | All | **shake** (how much it's moving lately) and **swing x/y** (the direction of the last quick move, fading out) |

   - **Outputs**: **Pipes** (learned or off); **Tempo**, **Loop length**
     (play only N steps) and **Loop section** (which part of the pattern
     loops), each *off*, *learned from the poses* (it glides between the
     values you taught) or *direct from one input* (e.g. tilt y → loop
     length 1–8, with invert; no training).
3. **Train** (a second or two): it says how often the pipes come out right
   and how close the controls get. Changing the map asks to train again
   (the examples are kept).
4. **Play**: hold **Hold to play** (or L1 on the controller, or tick *Play
   without holding*) and move. The PS5 controller's light bar shows the open
   pipes and it rumbles when one opens. Controls stay where you leave them,
   like knobs; **Play the whole pattern again** ends a loop.

Pipes play like MIDI keys: on top of the pattern, through the same live
notes (hub 1.3), and Stop lets go. A loop changes what the organ is sent
(only those steps); the rest of the grid is faded and the bar at the top
says which steps loop. In a room every guest can teach and play their own
phone (the phone learns; the host gets only which pipes it holds, and lets
go after a second of silence); tempo and loop are the host's.

The model is a small neural network (an MLP: one hidden layer of 24 units,
one output per pipe and per learned control) trained in the browser in plain
JavaScript (`js/mlp.js`). Examples, map and model are kept in that browser,
per controller.

## Playing together

Other people can paint the pattern with you, live, from their own phone or
computer. Everyone sees the same pattern, everyone's edits (flashed in
their colour), the organ's real playhead and who's here.

### Online: rooms

1. On the computer connected to the organ, open the online version and
   connect the organ (or the demo organ).
2. **Play together…** → **Open a room**. A room code (e.g. `K7PQ2M`), its
   link and a QR code appear. Send the link, or let people scan the code.
3. Others open the link (any modern browser, iPhones included), type their
   name and paint, wherever they are. Or they type the code under
   **Play together… → Join**.

This page is the **host**: it runs the organ and decides what each person
can do. Click someone's name above the grid:

| Role | Can |
|---|---|
| **Paint every pipe** (default) | paint any cell |
| **Own one pipe** | paint only their pipe's row; the other rows are dimmed |
| **Co-host** | also play/stop, tempo, pipes and steps, presets (their own) and Clear |

**Make host…** hands the room to that person: this page lets go of the
organ and rejoins as a co-host, and everyone follows the room to the new
host (they keep their roles). The new host then connects the organ on
their computer, or plays the demo organ. **Remove** takes someone out.
Closing the host's page (or **Close the room**) ends it for everyone.

Guests far away hear the simulated pipes (Listen panel), following the
organ's playhead. Rooms find each other through the free public
[PeerJS](https://peerjs.com/) server; after that the browsers talk to each
other directly (WebRTC). On some strict networks (some offices and venues)
direct connections are blocked; a phone's mobile data usually works.

### Local app: Wi-Fi

Phones and laptops on the same Wi-Fi can join the local app, without
the internet. Any number of devices, iPhones included.

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
tempo, presets and Clear. Guests can only paint, and only with the code (no roles here);
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

## Boards: the hub and the pipes

The organ has two kinds of ESP32 board:

- the **hub**: plugged into the computer by USB while playing; it sends
  each pipe its row and keeps the beat (the firmware calls it the sender);
- the **pipes**, A–H: one board per pipe, driving its valve (the
  receivers).

Since 1.2 each pipe **stores its letter on the board** and announces itself
over the radio; the hub finds the pipes by itself. Swapping or adding a
pipe board needs no code change: give it a letter and it plays.

Online, **More ▾ → Boards: hub & pipes…** sets them up one at a time:

1. Plug a board in by USB and click **Connect a board…**. The panel
   restarts it and reads what it is: hub or pipe, firmware version, letter.
2. Choose **the hub** or **a pipe** and its letter, then
   **Install … firmware** (or **Make it pipe B** if the firmware is already
   current). Installing a pipe also sets its letter.
3. **Click the valve** opens the pipe's valve for a moment, to check the
   wiring. **Next board…** for the next one.

While the hub is connected, the panel also shows which pipes it hears
(✓ = a 1.2 board with that letter, 1.1 = an old board it still knows from
its built-in list). If two boards are set to the same letter, the app
warns. If a board won't connect or install, hold its **BOOT** button while
clicking, then let go.

Updating from 1.1: update the hub first; it still plays 1.1 pipes from
its built-in address list. Then update each pipe and give it its letter.
The letter survives later updates and power cuts.

Installing uses [esptool-js](https://github.com/espressif/esptool-js)
0.5.7 (Espressif), loaded only when you install. The files it installs live
in `app/static/firmware/`. After changing anything in `firmware/`, rebuild
them with:

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

See [docs/HARDWARE.md](docs/HARDWARE.md) for wiring and the Arduino setup.
`firmware/calum_sender` is the hub, `firmware/calum_receiver` every pipe
board (the Boards panel installs them without the Arduino IDE).

1.2 compiles on ESP32 Arduino core 2.0.14 (what the published files are
built with); the ESP-IDF 5 code paths for core 3.x are there but 1.2 hasn't
been compiled on 3.x yet.
`peers.h` exists in both sketch folders (Arduino needs it there). Keep the
two copies identical; a test checks this.

## Protocol

Line-based ASCII over USB serial, 115200 baud:

```
host → hub:  PAT <tempo> <rows> <cols> <row0bits> ... <rowNbits>
             PAT2 <tempo> <rows> <len>/<num>/<den>/<figures> ...       (1.4+)
             PLAY   STOP   PING   PIPES   INFO   NOTE <mask>
hub → host:  OK PAT <seq>   ACK <peer> <seq>   NAK <peer> <seq>
             OK PLAY   OK STOP   OK READY   PONG   STEP <n>   ERR <reason>
             PIPE <peer> <mac> <fw|old>   DUP <peer> <mac>   OK PIPES fw <version>

host → pipe: INFO   PIPE <A..H|->   TEST
pipe → host: INFO pipe <letter> fw <version> mac <mac>   OK PIPE <letter>   OK TEST
```

`PAT2` gives each row its length, its speed as num/den of the master beat,
and a figure digit 0–7 per step (0 off, 1 full, 2 detached, 3 staccato,
4–6 repeats, 7 offbeat). From 1.4 `STEP <n>` counts on from Play without
wrapping; each pipe wraps its own row. `NOTE <mask>` (live notes: bit i = pipe i held) gets no reply, so it never
waits behind a pattern. `PIPE` lines come when the hub finds a pipe (and in answer to `PIPES`);
`old` means a 1.1 pipe from its built-in list. `DUP` means a second board
claims a letter. A NAK for a pipe no board has claimed comes at once.

`tempo` is in steps per minute (one step = 60000/tempo ms). `OK PAT` means
the sender accepted the pattern; ACK/NAK per pipe follow as delivery
finishes. `STEP <n>` is sent once per step while playing. Implemented twice,
kept in step by tests: `app/protocol.py` (local app) and
`app/static/js/protocol.js` (browser).

Over the radio (`firmware/*/peers.h`), the hub unicasts one `PKT_PATTERN`
per pipe (with retry), broadcasts `PKT_TICK {step, tempo, rows}` every step,
and broadcasts `PKT_STOP` to stop. Pipes broadcast `PKT_HELLO {letter,
firmware}` every 3 s (and soon after the hub's `PKT_WHO` at its boot); a
pipe with a letter only accepts its own row. Live notes travel as a
broadcast `PKT_NOTE {mask}`, repeated every 150 ms while any key is held;
a pipe lets go if it hears none for 600 ms, so a lost "key up" can't leave
a valve open.

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
│       ├── js/room.js      # online rooms: host hub, guest backend, roles
│       ├── js/boards.js    # Boards panel: identify, install, set pipe letter
│       ├── js/rhythm.js    # figures, per-pipe length and speed, meter (as in the firmware)
│       ├── js/midi.js      # MIDI: devices, mapping, learn, pad-grid LEDs
│       ├── js/mlp.js       # gestures: learn poses by example (small MLP)
│       ├── js/motion.js    # gestures: phone motion, PS5 controller (WebHID), gamepads
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
  sound fix (audio unlocked in the tap, silent switch bypassed). Online
  rooms (PeerJS): play together over the internet, with roles (paint
  everything, own one pipe, co-host) and handing over the host.
- v1.2 (Oct 2026): pipes store their letter on the board and announce
  themselves; the hub finds them (no MAC table to edit). Boards panel:
  identify a board over USB, install hub or pipe firmware, set a pipe's
  letter, click its valve.
- v1.3 (Oct 2026): MIDI keyboards and pads play the pipes live (keys by
  pitch, sustain pedal, pads in a row, pad grids that show and edit the
  pattern, MIDI learn, record into the grid). Firmware: live notes.
  Gestures: teach poses with a phone, a PS5 controller or a gamepad, and
  play the pipes by moving; room guests play from their own phones.
- v1.4 (Oct 2026): figures inside a step (detached, staccato, repeats,
  offbeat), each pipe's own length and speed (polymeter, polyrhythm,
  phasing tempos), meters beyond 4 (3+3+2…). Firmware 1.4: the hub counts
  steps, each pipe times its own row and figures.

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
- Firmware: Arduino-ESP32 core (LGPL-2.1), ESP-IDF (Apache-2.0). Boards
  panel installer: esptool-js 0.5.7 (Espressif, Apache-2.0), loaded from
  unpkg when installing.
- `app/static/vendor/qrcode-generator/`: QR codes for sharing, by Kazuhiko
  Arase (MIT).
- Gestures: learning by example as in Wekinator (Rebecca Fiebrink); the
  PS5 controller's reports as documented in Linux's `hid-playstation` driver.
- `app/static/vendor/peerjs/`: PeerJS 1.5.5 (MIT), and its free public
  matchmaking server, for online rooms.

This project's own code has no licence file yet.
