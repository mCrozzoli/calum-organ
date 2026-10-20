# TODO

## Check on the real organ

v1.1 and v1.2 have only been tested against the simulator and demo organ.

- [ ] Web Serial with the real sender in Chrome: connect, play, stop,
      unplug mid-play (the page should say disconnected; pipes close after 2 s).
- [ ] Boards panel (1.2) on real boards: install the hub and each pipe,
      set letters, Click the valve; is BOOT needed on Calum's boards? The
      USB part was only tested with a simulated board.
- [ ] 1.2 radio: the hub finds every pipe (✓ in Boards) within a few
      seconds of power-up; a pipe added mid-play gets its row; two boards
      on one letter show the warning. Compile 1.2 on ESP32 core 3.x too.
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

## MIDI (built in 1.3): still to check

Built: keyboards by pitch, sustain, pads in a row, Launchpad Mini MK3 / X
and APC mini / mk2 pad grids, MIDI learn, record. Tested only with
simulated devices.

- [ ] Calum's own controllers: which ones? Check each profile on the real
      device (APC mini mk2 arrow buttons and colours are from the manual,
      unverified).
- [ ] Latency from key to pipe (USB + radio): aim for under ~10 ms.
- [ ] Set the Listen panel's pitches to the real pipes, so keys map right.
- [ ] Maybe: velocity as a threshold, MIDI clock in/out, live notes from
      guests in a room, live notes through the local app.
