# Calum Pipe Madness — Folder Audit (2026-10-17)

> **Status (v1.1, same day):** all items in §4 and the UI problems in §5
> were fixed, including lost-beat recovery, preset delete, the
> unsaved-changes warning and a Quit button. Keyboard/screen-reader access
> to the grid is tracked in `../TODO.md` along with MIDI controllers. The
> old folders listed in §2 were moved to the macOS Trash
> ("Calum Pipe Madness - old versions (2026-10-17)") and
> `calum-organ-v1.0/` became `calum-organ/`. Everything below is the
> original audit of v1.0.

## 1. What the project is

A **step sequencer for a pipe organ made of solenoid valves**. You draw a
rhythm grid on a computer; each grid row is one pipe. The pattern goes over
USB to an **ESP32 "sender"**, which sends it wirelessly (**ESP-NOW**) to up to
**8 ESP32 "receivers"** (pipes A–H). Each receiver switches a relay on GPIO22
that opens or closes its valve, step by step, at the set tempo.

```
Browser UI ──HTTP/SSE──▶ Python server ──USB serial──▶ ESP32 sender ──ESP-NOW──▶ 8× receivers ──relay──▶ pipes
```

## 2. Which version is the latest

**`calum-organ-v1.0/`** (8 Apr 2026). It is the newest and the most complete.

| Folder | Date | What it is | Status |
|---|---|---|---|
| `calum_pipe_madness_v4.zip` | Mar 2023 | earliest archive | obsolete |
| `release_v1 (v5)/`, `release_v1/` | Apr–May 2023 | Jupyter/Tk UI, first sender/receiver | obsolete |
| `release_v2 (v6)/`, `v6/` | Jun–Jul 2023 | Tk + OSC/SLIP | obsolete |
| `release_v3 (v7)/`, `release_v4 (v7)/`, `v7/` | Jul–Sep 2023 | Tk + OSC/SLIP, `release_v4.zip` | obsolete |
| `v8/` | Sep–Dec 2023 | last of the 2023 line, plus an ESP8266 sender | last legacy version |
| `calum-organ/` (v0.9) | 7–8 Apr 2026 | full rewrite with a PyQt6 desktop UI and a Tk setup wizard | replaced by v1.0 |
| **`calum-organ-v1.0/`** | **8 Apr 2026** | **same rewrite, with a browser UI and only pyserial** | **current** |
| `calum-organ-v1.0.zip` | 8 Apr 2026 | zip of v1.0 | see note below |

The firmware, the protocol, the presets and the simulator are the same in
v0.9 and v1.0. Only the UI layer is different.

Note: `calum-organ-v1.0.zip` (5 MB) contains the `.venv` and `__MACOSX`
junk: 2,196 of its 2,304 files. That venv was built at an older path
(`~/Documents/Calum Pipe Madness/…`), so its pip scripts are broken. The
launcher still works because it only uses `.venv/bin/python`. Rezip without
`.venv` before sending it to anyone.

## 3. What works (verified)

- **Protocol, presets, server:** tests pass (`test_protocol` 15/15,
  `test_presets` 5/5, `test_server` 3/3).
- **End-to-end with the simulator:** I started the server and
  `sim.fake_esp --pty`, then connected, painted cells and pressed Play. PAT
  frames, OK/ACK replies, the live log, peer ACK counters and the playhead
  all work.
- **Firmware design is sound:** fixed-size packed packet (the old v8
  String-in-struct bug is fixed), per-peer retry, a double-buffered receiver
  that swaps patterns at step 0, non-blocking timing.

## 4. What is broken or missing

### Hardware behaviour (most important)
1. **Play and Stop do nothing on the real organ.** The sender firmware only
   replies `OK PLAY` / `OK STOP`. Nothing is sent to the receivers.
   Receivers start looping as soon as they get a pattern and never stop.
   The only way to silence them is to Clear, which sends an all-zero
   pattern.
2. **The pipes are not synchronised with each other.** Each receiver runs its
   own `millis()` clock from its own boot time and swaps patterns at its own
   step 0. Pipes drift apart and can start out of phase. There is no shared
   start or beat signal.
3. **The UI playhead is a browser timer (a fake).** It is not linked to the
   hardware, so the "OPEN / closed" labels and the orange pipes in the peer
   panel show what *should* happen, not what is happening.
4. **A tempo change does not reach the hardware.** Changing tempo only
   restarts the browser playhead. Changing rows or cols and loading a preset
   also send nothing until the next cell edit or Play.
5. **The firmware won't compile as shipped.** Both sketches `#include
   "peers.h"`, but it only exists in `firmware/shared/`. You have to copy it
   in by hand (the README mentions this).
6. **Arduino-ESP32 core 3.x incompatibility (likely).** The receive callback
   uses the old `(const uint8_t *mac, …)` signature. Core 3.x needs
   `esp_now_recv_info_t*`, and newer cores also changed the send callback.
   Pin core 2.x or update the callbacks.
7. On the sender, the last retry for each peer is fired without waiting for
   its result, so a final NAK can arrive after `OK PAT`.

### Software
8. **`test_serial_link.py` fails and then hangs pytest forever.**
   `send_pattern` returns as soon as `OK PAT` arrives. The simulator sends
   `OK PAT` *before* the 8 ACKs, so only about 6 peer events have arrived
   (measured: 6 at return, 8 after 300 ms). The test's PTY teardown then
   deadlocks on `os.read`. Running `pytest` in the README never finishes.
9. **Every cell you paint sends a full pattern with retries**, and these
   requests run in parallel. With the simulator this was fine. With real
   hardware (sender blocks about 30 ms per peer per retry), parallel sends
   share one reply queue and call `_drain()` on each other, which will
   likely cause spurious retries and timeouts. Debounce or coalesce sends.
10. **Fast drags skip cells.** There is no interpolation between mousemove
    points. Observed: a drag across 7 cells painted only 3.
11. **The simulator ACKs all 8 peers even when rows=4.** Real firmware only
    sends to `rows` peers, so the simulator makes E–H look alive.
12. **Preset names are not sanitised.** `../x` writes outside the preset
    folder. Saving over an existing name happens without a warning, and
    presets cannot be deleted.
13. Rows/cols inputs are not clamped. Typing 20 or leaving the field empty
    produces an invalid grid, which the server then rejects.
14. The pyproject pins `pytest<9`, but a current install brings in 9.x
    (harmless).

## 5. Interaction design review

**Good**
- One double-click launcher, the browser opens automatically, likely ports
  marked ★.
- Direct manipulation: click/drag to paint, right-click to erase, Space and
  C shortcuts.
- Every edit while connected is sent to the organ live, which suits
  performance.
- The peer panel (one "organ" per row with pipe, state and ACK dot) is a
  strong concept.
- Dark, high-contrast theme. The colour-coded log is useful for debugging.

**Problems, roughly by impact**
1. **It looks like it shows the hardware, but it doesn't.** The playhead,
   "OPEN" and Play/Stop all suggest control and feedback that don't exist
   (see §4.1–4.3). This is the biggest UX issue: the performer will trust
   the screen and the organ will do something else.
2. **The Play button has no playing state.** It looks the same while
   playing. Make Play and Stop one toggle with a clear running indicator.
3. **The grid has no orientation.** There are no row labels (A–D) next to
   the rows, no step numbers, no beat or bar grouping (every 4th column),
   and no tempo meaning ("bpm" here is really *steps* per minute).
4. **Peers beyond `rows` are not dimmed.** E–H look active even when only
   4 rows exist.
5. **The port dropdown does not show the connected port** (it still showed
   Bluetooth-Incoming-Port while connected to ttys003). The status pill is
   tiny, top-right.
6. **Browser `prompt()` and `alert()` are used** for manual port, preset
   name and send failure. They are jarring, especially mid-performance.
7. **It doesn't work on a phone.** There are no touch events (mouse only),
   the canvas uses a fixed 32 px cell and overflows on mobile, and the
   Connect button falls off-screen. The README's "drive it from a phone"
   claim doesn't hold.
8. **The log takes about 40% of the screen** and shows 9+ lines per edit.
   Collapse it by default, as a debug drawer.
9. Load is a two-step action (choose, then press Load). Load on select
   instead, add "unsaved changes" awareness and a delete option.
10. You can't quit from the UI. Closing the tab leaves the server running.
11. Accessibility: the canvas grid has no keyboard navigation and no
    screen-reader semantics. Status is shown by colour only (dots).

## 6. Suggested next steps (priority order)

1. **Make Play/Stop real and synchronise the pipes.** Add a `cmd` field to
   `PipePacket` (PLAY/STOP/PATTERN). Broadcast one "start at step 0" message
   to all peers at once (ESP-NOW broadcast MAC `FF:FF:FF:FF:FF:FF`).
   Optionally send a periodic beat or step-sync packet from the sender so
   the receivers stay locked.
2. Resend the pattern when tempo, rows, cols or a preset changes. Debounce
   edits (about 50 ms) and serialise sends on the server.
3. Fix the serial test: wait for ACKs or relax the assert, and make the
   teardown non-blocking.
4. Put `peers.h` next to each sketch (or use a symlink or build script) and
   pin or adapt the ESP32 core version.
5. UI pass: Play toggle state, row/step labels with beat grouping, dim
   unused peers, pointer events (touch), responsive cells, in-page
   dialogs, a collapsible log.
6. Housekeeping: archive everything except `calum-organ-v1.0/` into
   `_archive/`, and rezip v1.0 without `.venv`.
