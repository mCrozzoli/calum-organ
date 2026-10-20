// Tests for gestures: the learner (js/mlp.js) and the controllers'
// data (js/motion.js). The sensors themselves need a phone or a PS5 pad.
import { test } from "node:test";
import assert from "node:assert/strict";

const { Learner, MLP, Hysteresis } = await import("../../app/static/js/mlp.js");
const mo = await import("../../app/static/js/motion.js");

function noisy(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2;
}

test("learns poses to pipes, quickly and the same way every time", async () => {
  const r = noisy(3);
  const poses = [[[0, 0, 1, 0, 0, 0], 0], [[1, 0, 0, 0, 0, 0], 0b1], [[0, 1, 0, 0, 0, 0], 0b100], [[-1, 0, 0, 0, 0, 0], 0b101]];
  const make = () => {
    const l = new Learner(6);
    for (const [p, m] of poses) for (let i = 0; i < 150; i++) l.add(p.map((v) => v + r()), m);
    return l;
  };
  const l = make();
  const t0 = Date.now();
  const res = await l.train();
  assert.ok(Date.now() - t0 < 5000, "trains in seconds");
  assert.ok(res.pipes > 0.95, `accuracy ${res.pipes}`);
  const mask = (x) => l.maskFor(l.predict(x).pipes);
  assert.equal(mask([0.9, 0.1, 0, 0, 0, 0]), 0b1);
  assert.equal(mask([-0.95, 0, 0.1, 0, 0, 0]), 0b101, "two pipes at once");
  assert.equal(mask([0, 0.05, 0.95, 0, 0, 0]), 0, "the silence pose");
  assert.deepEqual(l.counts(), { 0: 150, 1: 150, 4: 150, 5: 150 });
  // saved and loaded: same answers
  const back = Learner.fromJSON(JSON.parse(JSON.stringify(l)));
  assert.deepEqual(back.predict([1, 0, 0, 0, 0, 0]), l.predict([1, 0, 0, 0, 0, 0]));
});

test("needs two different poses", async () => {
  const l = new Learner(2);
  l.add([0, 0], 1);
  await assert.rejects(l.train(), /two different poses/);
  assert.throws(() => l.add([0], 1), /inputs/);
  await assert.rejects(l.train({ pipes: false }), /choose something/);
  await assert.rejects(l.train({ pipes: false, controls: ["tempo"] }), /different tempo/);
  assert.throws(() => MLP.fromJSON({ nIn: 2, nHidden: 2, nOut: 8, w1: [1], b1: [], w2: [], b2: [] }));
});

test("no flicker between poses", () => {
  const h = new Hysteresis(0.6, 0.4);
  assert.equal(h.update([0.55, 0, 0, 0, 0, 0, 0, 0]), 0, "not sure enough yet");
  assert.equal(h.update([0.65, 0, 0, 0, 0, 0, 0, 0]), 1);
  assert.equal(h.update([0.45, 0, 0, 0, 0, 0, 0, 0]), 1, "stays open in the middle band");
  assert.equal(h.update([0.35, 0.9, 0, 0, 0, 0, 0, 0]), 0b10);
});

// A DualSense USB input report (63 bytes after the report id).
function report({ lx = 128, l2 = 0, accel = [0, 8192, 0], gyro = [0, 0, 0], b0 = 0x08, b1 = 0, touch = null } = {}) {
  const d = new DataView(new ArrayBuffer(63));
  d.setUint8(0, lx); d.setUint8(1, 128); d.setUint8(2, 128); d.setUint8(3, 128);
  d.setUint8(4, l2); d.setUint8(7, b0); d.setUint8(8, b1);
  gyro.forEach((v, i) => d.setInt16(15 + i * 2, v, true));
  accel.forEach((v, i) => d.setInt16(21 + i * 2, v, true));
  d.setUint8(32, touch ? 0x01 : 0x80);
  if (touch) { d.setUint8(33, 0xc0); d.setUint8(34, 0x23); d.setUint8(35, 0x1c); }
  return d;
}

test("PS5 controller: input report", () => {
  const s = mo.parseDualSense(0x01, report({ lx: 255, l2: 255, accel: [100, 8192, -50], gyro: [400, 0, -400], b0: 0x28, b1: 0x01, touch: true }));
  assert.ok(Math.abs(s.lx - 127 / 128) < 1e-9);
  assert.equal(s.l2, 1);
  assert.deepEqual(s.accel, [100, 8192, -50]);
  assert.deepEqual(s.gyro, [400, 0, -400]);
  assert.equal(s.buttons.cross, true);
  assert.equal(s.buttons.square, false);
  assert.equal(s.buttons.l1, true);
  assert.ok(s.touch && s.touch.x > 0 && s.touch.y > 0);
  const f = mo.dualSenseFeatures(s);
  assert.equal(f.length, 15, "12 + touchpad x, y, touching");
  assert.equal(f[14], 1, "finger on the touchpad");
  assert.equal(f[1], 1, "gravity on y = 1");
  // Bluetooth full report: the same, one byte later
  const bt = new DataView(new ArrayBuffer(78));
  new Uint8Array(bt.buffer).set(new Uint8Array(report({ b0: 0x20 }).buffer), 1);
  assert.equal(mo.parseDualSense(0x31, bt).buttons.cross, true);
  assert.equal(mo.parseDualSense(0x01, new DataView(new ArrayBuffer(9))), null, "Bluetooth basic report: no motion");
});

test("PS5 controller: light bar and rumble reports", () => {
  assert.equal((mo.crc32(new TextEncoder().encode("123456789")) ^ 0xffffffff) >>> 0, 0xcbf43926);
  const c = mo.dualSenseOutput({ rgb: [10, 20, 30], rumble: 99 });
  assert.equal(c.length, 47);
  assert.deepEqual([c[0], c[1], c[2], c[3], c[44], c[45], c[46]], [0x03, 0x04, 99, 99, 10, 20, 30]);
  const usb = mo.dualSenseReport(c, false);
  assert.equal(usb.id, 0x02);
  const bt = mo.dualSenseReport(c, true, 5);
  assert.equal(bt.id, 0x31);
  assert.equal(bt.data.length, 77);
  assert.equal(bt.data[0], 0x50);
  assert.equal(bt.data[2 + 44], 10);
  const crc = (mo.crc32([0xa2, 0x31, ...bt.data.subarray(0, 73)]) ^ 0xffffffff) >>> 0;
  assert.equal(new DataView(bt.data.buffer).getUint32(73, true), crc);
});

test("only the chosen inputs count", async () => {
  // input 0 tells the poses apart; input 1 is noise that differs by chance
  const l = new Learner(2);
  const r = noisy(11);
  for (let i = 0; i < 200; i++) {
    l.add([1 + r(), r() * 20], 0b1);
    l.add([-1 + r(), r() * 20], 0);
  }
  await l.train({ inputs: [0] });
  assert.deepEqual(l.inputs, [0]);
  assert.equal(l.maskFor(l.predict([1, 50]).pipes), 1, "a wild value on an unused input changes nothing");
  assert.equal(l.maskFor(l.predict([-1, -50]).pipes), 0);
});

test("learns a control value, gliding between poses", async () => {
  const l = new Learner(1);
  const r = noisy(5);
  for (let i = 0; i < 200; i++) {
    l.add([-1 + r()], 0, { tempo: 0.2 });
    l.add([1 + r()], 0, { tempo: 0.8 });
  }
  const res = await l.train({ pipes: false, controls: ["tempo"] });
  assert.equal(res.pipes, null);
  assert.ok(res.controls.tempo < 0.05, `error ${res.controls.tempo}`);
  const at = (x) => l.predict([x]).controls.tempo;
  assert.ok(Math.abs(at(-1) - 0.2) < 0.06 && Math.abs(at(1) - 0.8) < 0.06);
  assert.ok(at(0) > at(-1) && at(0) < at(1), "in between, in between");
  assert.equal(l.predict([0]).pipes, null, "pipes weren't learnt");
  const back = Learner.fromJSON(JSON.parse(JSON.stringify(l)));
  assert.deepEqual(back.controls, ["tempo"]);
  assert.equal(back.predict([0.3]).controls.tempo, l.predict([0.3]).controls.tempo);
});

test("shake and swing", () => {
  const m = new mo.Moves();
  assert.deepEqual(m.update([0, 0, 1], 0), [0, 0, 0]);
  let f;
  for (let t = 16; t <= 400; t += 16) f = m.update([0, 0, 1], t);
  assert.equal(f[0], 0, "still: no shake");
  for (let t = 416, k = 0; t <= 900; t += 16, k++) f = m.update([k % 2 ? 0.5 : -0.5, 0, 1], t);
  assert.ok(f[0] > 0.5, `shaking: ${f[0]}`);
  const s = new mo.Moves();
  s.update([0, 0, 1], 0);
  for (let t = 16, x = 0; t <= 160; t += 16) f = s.update([(x += 0.05), 0, 1], t);
  assert.ok(f[1] > 0.3 && Math.abs(f[2]) < 0.01, "a quick move to the right swings x");
  for (let t = 176; t <= 1500; t += 16) f = s.update([0.5, 0, 1], t);
  assert.ok(Math.abs(f[1]) < 0.05, "and fades");
});

test("every controller describes its inputs", () => {
  const phone = new mo.PhoneMotion(() => {});
  const ds = new mo.DualSense(() => {});
  const pad = new mo.AnyGamepad(() => {});
  for (const src of [phone, ds, pad]) {
    const ids = src.inputs.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.ok(ids.includes("shake") && ids.includes("swingX"), "everyone has moves");
  }
  assert.ok(phone.inputs.some((i) => i.group === "heading") && phone.inputs.some((i) => i.group === "touch"));
  assert.ok(ds.inputs.some((i) => i.id === "touchX"));
  assert.equal(mo.dualSenseFeatures(mo.parseDualSense(0x01, report({ touch: true }))).length + 3, ds.inputs.length);
  assert.ok(mo.PRESETS.some((p) => p.name === "Tilt only"));
});
