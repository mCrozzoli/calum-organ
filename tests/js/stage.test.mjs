// Tests for the listening stage geometry and settings (js/stage.js).
import { test } from "node:test";
import assert from "node:assert/strict";

const st = await import("../../app/static/js/stage.js");
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("note names and frequencies", () => {
  assert.equal(st.noteName(60), "C4");
  assert.equal(st.noteName(69), "A4");
  assert.equal(st.noteName(61), "C#4");
  assert.equal(st.noteName(st.MIN_NOTE), "C2");
  assert.equal(st.noteName(st.MAX_NOTE), "C6");
  assert.ok(near(st.midiToFreq(69), 440));
  assert.ok(near(st.midiToFreq(57), 220));
});

test("placement: front, right, left, behind, distance", () => {
  const me = { x: 0.5, y: 0.5 };
  const at = (x, y) => st.placement({ x, y }, me, 12);
  assert.ok(near(at(0.5, 0).azimuth, 0));                     // straight ahead (top)
  assert.ok(near(at(1, 0.5).azimuth, Math.PI / 2));           // right
  assert.ok(near(at(0, 0.5).azimuth, -Math.PI / 2));          // left
  assert.ok(near(Math.abs(at(0.5, 1).azimuth), Math.PI));     // behind
  assert.ok(near(at(1, 0.5).distance, 6));                    // half of a 12 m room
  assert.equal(at(0.5, 0.5).distance, 0.3);                   // never closer than 0.3 m
});

test("default layout: 8 pipes in the room, in front of the listener", () => {
  const d = st.defaultStage();
  assert.equal(d.pipes.length, st.PIPES);
  for (const p of d.pipes) {
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    assert.ok(Math.abs(st.placement(p, d.listener, 12).azimuth) < Math.PI / 2, "in front");
  }
  // A on the left, H on the right
  assert.ok(st.placement(d.pipes[0], d.listener, 12).azimuth < 0);
  assert.ok(st.placement(d.pipes[7], d.listener, 12).azimuth > 0);
});

test("describe() says where a pipe is", () => {
  const me = { x: 0.5, y: 0.5 };
  assert.equal(st.describe({ x: 0.5, y: 0.25 }, me, 12), "3.0 m ahead");
  assert.equal(st.describe({ x: 0.75, y: 0.25 }, me, 12), "4.2 m front right");
  assert.equal(st.describe({ x: 0.25, y: 0.75 }, me, 12), "4.2 m behind left");
  assert.equal(st.describe({ x: 0.9, y: 0.51 }, me, 12), "4.8 m right");     // a hair behind: still "right"
});

test("stored settings are cleaned, never trusted", () => {
  const d = st.defaultStage();
  assert.deepEqual(st.sanitizeStage(null), d);
  assert.deepEqual(st.sanitizeStage("nonsense"), d);
  const s = st.sanitizeStage({
    pipes: [{ x: 2, y: -1, note: 200 }, { x: "a", note: 1.5 }],
    listener: { x: 0.1 },
    room: "constructor",
    output: "bluetooth",
    volume: 7,
  });
  assert.deepEqual(s.pipes[0], { x: 1, y: 0, note: st.MAX_NOTE });
  assert.deepEqual(s.pipes[1], d.pipes[1]);
  assert.deepEqual(s.listener, { x: 0.1, y: d.listener.y });
  assert.equal(s.room, "medium");
  assert.equal(s.output, "headphones");
  assert.equal(s.volume, 1);
});
