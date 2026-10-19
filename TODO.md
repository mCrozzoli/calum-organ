# TODO

## Check on the real organ

v1.1 has only been tested against the simulator and demo organ.

- [ ] Web Serial with the real sender in Chrome: connect, play, stop,
      unplug mid-play (the page should say disconnected; pipes close after 2 s).
- [ ] Web firmware update for sender and receivers (check that the BOOT
      button is needed or not on Calum's boards).
- [ ] Lost-beat recovery: play with a pipe at the edge of radio range.
- [ ] Opening the port resets some ESP32 boards: confirm the app resends
      the pattern after the sender's `OK READY`.
- [ ] Android Chrome: does Web Serial reach the board over USB-OTG?
- [ ] iPhone: simulated sound now plays with the silent switch on? (Audio
      is unlocked in the tap and the page asks for "playback".)
- [ ] Playing together at the venue: guests' phones on the venue Wi-Fi or
      the laptop's hotspot (some venue networks isolate devices from each
      other; the hotspot always works); macOS firewall prompt (Allow);
      latency from a phone's paint to the pipes.
- [ ] Online rooms with real people: phones on mobile data and on the
      venue Wi-Fi joining a room; a handover where the new host plugs the
      sender into their laptop. If some networks block direct connections,
      consider a TURN relay (PeerJS's public server has none).
- [ ] Listen to the simulated pipes on headphones and on speakers: does
      the placement read as intended? Tune the pipe tone against the real
      pipes (`sound/organ_synthdefs.scd`).

## Bluetooth (deferred, 2026-10-19)

Considered for playing together and set aside for Wi-Fi via the laptop,
which allows any number of devices, iPhones included. Facts measured then:

- No iOS browser supports Web Bluetooth: iPhones and iPads couldn't join.
- The ESP32 Arduino core (2.0.14) allows **3** BLE connections
  (`CONFIG_BTDM_CTRL_BLE_MAX_CONN=3`); more needs a custom ESP-IDF build.
- ESP-NOW + a BLE GATT server compiles to 1.48 MB: too big for the default
  1.31 MB app partition, so the "Huge APP" partition scheme (the web updater
  can flash it).
- BLE shares the radio with ESP-NOW: the beat to the pipes could wobble.
  Test on the hardware before relying on it.
- If wanted for small groups without any network: a GATT service on the
  sender carrying the same line protocol (write = commands, notify =
  STEP/ACK), and a third backend in `backends.js` using Web Bluetooth.

## Listening stage

- [ ] Set the default pitches to the real pipes' notes once known.
- [ ] Record Calum's own pipes (one note each, valve open ~6 s) and build
      them into the corpus with `tools/build_corpus.py`: the simulation would
      then sound like the real organ.
- [ ] Optional: the organ's blower noise under the pipes (VSCO 2 CE has
      `Keys/Organ/Rode_Blower.wav`, CC0).
- [ ] Include the stage layout and pitches in preset export/import.
- [ ] Optional: a measured-HRTF mode for convincing front/back (e.g.
      a Web Audio `PannerNode` fed by a multichannel SuperSonic output, or
      an HRTF convolution in SuperCollider).
- [ ] Let the stage plan the real installation too (print or export the
      room layout).

## Accessibility: keyboard and screen-reader access to the grid

The grid is a `<canvas>`, so it can only be used with a mouse or touch.

- [ ] Arrow keys move a visible focus cell, Enter/Space toggles it, Home/End
      jump to the first/last step, and a modifier key (e.g. Shift+arrows)
      paints while moving.
- [ ] Announce the focused cell and its state, e.g. "Pipe B, step 5, on".
      Options: an ARIA `grid` of real buttons layered over the canvas, or
      swap the canvas for a DOM grid (max 8×32 = 256 cells, which is fine).
- [ ] Don't rely on colour alone: pipe status dots (up to date / missed)
      need a text or shape difference. Check contrast of the muted text.
- [ ] Announce transport and delivery changes ("Playing", "Pipe C missed
      the pattern") through the existing `aria-live` truth bar.
- [ ] Space currently means play/stop globally. Decide how that coexists
      with Space = toggle cell when the grid has focus.

## MIDI controllers as an interface

Goal: play and program the organ from a MIDI controller (pad grid,
keyboard, knobs and transport buttons) as well as the screen.

### Detection (open questions)

- [ ] **Where does MIDI live: the browser or the Python server?**
  - *Web MIDI API (browser):* no install, hot-plug events built in.
    Works in Chrome/Edge (Firefox needs a permission prompt). **Safari
    doesn't support it.** Calum's default browser matters.
  - *Python (`python-rtmidi` or `mido`):* works whatever the browser, and
    keeps working with the tab closed. But it adds a compiled dependency
    (the launcher today installs only pyserial) and needs polling for
    hot-plug.
- [ ] Hot-plug: a controller plugged in or out mid-session should show up
      or disappear without restarting, with a status like
      "MIDI: Launchpad Mini connected".
- [ ] Multiple controllers at once? Pick one, or merge all inputs.
- [ ] Ignore the MIDI-over-Bluetooth / IAC virtual ports unless chosen.

### Mapping (open questions)

- [ ] **What do controls mean?** Candidate modes:
  - *Program mode:* a pad grid mirrors the step grid (pad = pipe × step)
    and lights its LEDs to show the pattern and playhead. This needs
    per-device LED feedback (Launchpad, APC, Push each differ).
  - *Live mode:* note on/off opens and closes a pipe **immediately**,
    played like a keyboard, alongside or instead of the sequencer.
  - *Controls:* a CC knob sets tempo, buttons do play/stop/clear and
    preset next/previous.
- [ ] **MIDI learn:** click a target in the UI ("Pipe C", "Tempo",
      "Play"), then touch a control to bind it. This is easier than
      writing a per-device profile.
- [ ] Ship ready-made profiles for the controllers Calum actually owns.
      **Which ones does Calum own?**
- [ ] Note → pipe default (e.g. 8 consecutive notes from C3, or match the
      pipes' real pitches if they're tuned). **What notes are the pipes?**
- [ ] Velocity: ignore it (valves are on/off), or use it as a threshold?
- [ ] Save mappings with the app (`~/.calum_organ/midi.json`), and per
      preset if needed.
- [ ] Optional MIDI clock in/out to sync with a DAW or drum machine.

### Firmware and protocol work this implies

- [ ] Live mode needs a new message that bypasses the step sequencer, e.g.
      serial `NOTE <peer> <on|off>` → broadcast `PKT_NOTE`. Latency budget:
      USB + radio should stay under about 10 ms to feel playable. Measure it.
- [ ] Decide how live notes and a running pattern combine (OR them? live
      overrides?), and make sure Stop / the 2 s watchdog also releases
      notes held from MIDI so a valve can't stick open.
- [ ] Simulator support (`sim/fake_esp.py`) so mapping can be tested
      without hardware.
