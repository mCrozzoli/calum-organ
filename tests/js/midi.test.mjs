// Tests for MIDI controllers (js/midi.js): reading messages, which pipe a
// key plays, learned controls, sustain, recording, pad-grid LEDs.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("../../app/static/js/midi.js");

const on = (num, ch = 0, value = 100) => m.parseMessage([0x90 | ch, num, value]);
const off = (num, ch = 0) => m.parseMessage([0x80 | ch, num, 0]);
const cc = (num, value, ch = 0) => m.parseMessage([0xb0 | ch, num, value]);
const ctx = { pipeNotes: [48, 52, 55, 60, 64, 67, 71, 72], rows: 4, cols: 16, page: 0, profile: null };

test("messages", () => {
  assert.deepEqual(on(60), { type: "on", ch: 0, num: 60, value: 100 });
  assert.equal(m.parseMessage([0x90, 60, 0]).type, "off", "note on with velocity 0 is a release");
  assert.equal(off(60).type, "off");
  assert.deepEqual(cc(64, 127, 2), { type: "cc", ch: 2, num: 64, value: 127 });
  assert.equal(m.parseMessage([0xf8]), null, "clock ignored");
  assert.equal(m.controlKey(on(36, 9)), "n9:36");
  assert.equal(m.describeControl("n9:36"), "C2 (ch 10)");
  assert.equal(m.noteLabel(60), "C4");
});

test("which kind of controller", () => {
  assert.equal(m.deviceKind("Keystation 49 MK3"), "keyboard");
  assert.equal(m.deviceKind("nanoPAD2"), "pads");
  assert.equal(m.deviceKind("MPD218 Port A"), "pads");
  assert.equal(m.deviceKind("Launchpad Mini MK3 LPMiniMK3 MIDI"), "grid");
  assert.equal(m.profileFor("Launchpad Mini MK3 LPMiniMK3 DAW"), null, "the DAW port isn't the pads");
  assert.equal(m.profileFor("APC mini mk2").name, "APC mini mk2");
  assert.equal(m.profileFor("APC MINI").name, "APC mini");
  assert.equal(m.defaultSettings("Keystation 49").mode, "pitch");
  assert.equal(m.defaultSettings("nanoPAD2").mode, "row");
  assert.equal(m.defaultSettings("LPX MIDI").mode, "grid");
});

test("keyboard: each key plays the pipe tuned closest", () => {
  const s = m.defaultSettings("Keystation");
  assert.deepEqual(m.mapMessage(s, on(48), ctx), { kind: "pipe", pipe: 0, down: true });
  assert.deepEqual(m.mapMessage(s, on(53), ctx), { kind: "pipe", pipe: 1, down: true });
  assert.deepEqual(m.mapMessage(s, off(53), ctx), { kind: "pipe", pipe: 1, down: false });
  // only pipes in use (4 rows): a high key goes to D (60), not E–H
  assert.equal(m.mapMessage(s, on(84), ctx).pipe, 3);
  assert.equal(m.mapMessage(s, on(20), ctx).pipe, 0, "every key plays something");
  // quarter tones count
  assert.equal(m.nearestPipe(60.4, [60, 60.5], 2), 1);
  assert.deepEqual(m.mapMessage(s, cc(64, 127), ctx), { kind: "sustain", down: true });
  assert.deepEqual(m.mapMessage(s, cc(64, 0), ctx), { kind: "sustain", down: false });
  assert.equal(m.mapMessage(s, cc(1, 90), ctx), null, "mod wheel does nothing unless linked");
});

test("pads in a row from a base note", () => {
  const s = m.defaultSettings("nanoPAD2");
  assert.equal(m.mapMessage(s, on(36, 9), ctx).pipe, 0);
  assert.equal(m.mapMessage(s, on(39, 9), ctx).pipe, 3);
  assert.equal(m.mapMessage(s, on(40, 9), ctx), null, "pipe E isn't in the pattern");
  assert.equal(m.mapMessage(s, on(35, 9), ctx), null);
});

test("learned controls come first", () => {
  const s = m.defaultSettings("Keystation");
  s.bindings = { "n0:60": "pipe:2", "c0:20": "tempo", "c0:21": "playstop", "n0:59": "record", "c0:22": "sustain" };
  assert.deepEqual(m.mapMessage(s, on(60), ctx), { kind: "pipe", pipe: 2, down: true });
  assert.deepEqual(m.mapMessage(s, cc(20, 0), ctx), { kind: "tempo", tempo: 20 });
  assert.deepEqual(m.mapMessage(s, cc(20, 127), ctx), { kind: "tempo", tempo: 300 });
  assert.deepEqual(m.mapMessage(s, cc(21, 127), ctx), { kind: "playstop" });
  assert.equal(m.mapMessage(s, cc(21, 0), ctx), null, "a button acts when pressed, not let go");
  assert.deepEqual(m.mapMessage(s, on(59), ctx), { kind: "record" });
  assert.equal(m.mapMessage(s, off(59), ctx), null);
  assert.deepEqual(m.mapMessage(s, cc(22, 127), ctx), { kind: "sustain", down: true });
});

test("held keys and the sustain pedal", () => {
  const live = new m.LiveNotes();
  live.press("k|60", 2);
  live.press("k|62", 2);              // two keys on one pipe
  assert.equal(live.mask, 0b100);
  live.release("k|60");
  assert.equal(live.mask, 0b100, "still held by the other key");
  live.release("k|62");
  assert.equal(live.mask, 0);
  live.setSustain(true);
  live.press("k|48", 0);
  live.release("k|48");
  assert.equal(live.mask, 0b1, "pedal holds it");
  live.setSustain(false);
  assert.equal(live.mask, 0);
  live.press("a", 7);
  live.clear();
  assert.equal(live.mask, 0);
});

test("recording lands on the nearest step", () => {
  // 120 steps/min: 500 ms a step; the playhead reached step 3 at t=1000
  assert.equal(m.recordStep(3, 1000, 500, 1100, 16), 3);
  assert.equal(m.recordStep(3, 1000, 500, 1300, 16), 4, "late in the step: the next one");
  assert.equal(m.recordStep(15, 1000, 500, 1400, 16), 0, "wraps");
  assert.equal(m.recordStep(-1, 0, 500, 100, 16), -1, "not playing");
});

test("pad grid: pads edit the pattern, side buttons play", () => {
  const lp = m.profileFor("LPMiniMK3 MIDI");
  const s = m.defaultSettings("LPMiniMK3 MIDI");
  const g = { ...ctx, profile: lp, page: 1 };
  // top-left pad (note 81) = pipe A, step 9 on page 2
  assert.deepEqual(m.mapMessage(s, on(81), g), { kind: "cell", row: 0, col: 8 });
  assert.equal(m.mapMessage(s, off(81), g), null);
  assert.equal(m.mapMessage(s, on(11), g), null, "bottom row = pipe H: not in a 4-pipe pattern");
  assert.deepEqual(m.mapMessage(s, cc(79, 127), g), { kind: "pipe", pipe: 1, down: true });
  assert.deepEqual(m.mapMessage(s, cc(79, 0), g), { kind: "pipe", pipe: 1, down: false });
  assert.deepEqual(m.mapMessage(s, cc(94, 127), g), { kind: "page", delta: 1 });
  const apc = m.profileFor("APC mini mk2");
  assert.deepEqual(m.mapMessage(m.defaultSettings("APC mini mk2"), on(56), { ...ctx, profile: apc }), { kind: "cell", row: 0, col: 0 });
  assert.deepEqual(m.mapMessage(m.defaultSettings("APC mini mk2"), cc(56, 64), { ...ctx, profile: apc }),
                   { kind: "tempo", tempo: m.knobTempo(64) });
  assert.equal(lp.init[0][5], 0x0d, "Mini MK3 programmer-mode SysEx");
  assert.equal(m.profileFor("LPX MIDI").init[0][5], 0x0c);
});

test("pad grid LEDs", () => {
  const grid = [[1, 0, 0, 0, 0, 0, 0, 0, 1], [0, 1, 0, 0, 0, 0, 0, 0, 0]];
  const f = m.gridFrame({ grid, rows: 2, cols: 9, heads: [1, 1], page: 0, live: 0b10 });
  assert.equal(f.pads[0], "on");
  assert.equal(f.pads[1], "head");
  assert.equal(f.pads[9], "hit", "pipe B at the playhead");
  assert.equal(f.pads[2 * 8], "off", "pipe C isn't in use");
  assert.deepEqual(f.side.slice(0, 3), ["dim", "hit", "off"]);
  const lp = m.profileFor("LPMiniMK3 MIDI");
  const all = m.ledMessages(lp, f);
  assert.equal(all.length, 72);
  assert.deepEqual(all[0], [0x90, 81, 13], "top-left pad lit yellow");
  const f2 = m.gridFrame({ grid, rows: 2, cols: 9, heads: [2, 2], page: 0, live: 0 });
  const diff = m.ledMessages(lp, f2, f);
  assert.equal(diff.length, 5, "only what changed: two playhead pads x2 rows + one side button");
  const page2 = m.gridFrame({ grid, rows: 2, cols: 9, heads: [-1, -1], page: 1, live: 0 });
  const own = m.gridFrame({ grid: [[0, 0, 3]], rows: 1, cols: 3, heads: [2], page: 0, live: 0 });
  assert.equal(own.pads[2], "hit", "a figure is lit; each row has its own playhead");
  assert.equal(page2.pads[0], "on", "step 9 of pipe A");
  assert.equal(page2.pads[1], "off", "beyond the last step");
});
