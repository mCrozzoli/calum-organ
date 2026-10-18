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
