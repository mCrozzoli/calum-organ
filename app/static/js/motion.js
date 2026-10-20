// Controllers for gestures: what the learner (mlp.js) gets as inputs.
//
//   PhoneMotion   a phone's motion sensors (tilt + rotation), in the browser
//   DualSense     a PS5 controller on the computer, over WebHID (Chrome/Edge):
//                 tilt, rotation, sticks, triggers; light bar and rumble
//   Gamepad       any game controller (standard Gamepad API): sticks, triggers
//
// Each source keeps `features` (numbers, roughly -1..1, smoothed), described
// by `inputs` ([{id, label, group}]), `arm` (the hold-to-play button held),
// `record` (the hold-to-record button held) and calls onChange() when new
// data arrives. Every source also gets two kinds of movement, computed from
// its tilt (or left stick): shake (how much it's moving lately) and swing
// (the direction of the last quick move, fading out).

const SMOOTH = 0.35;           // 0..1: how much of each new reading to take
const smooth = (prev, next) => (prev ? next.map((v, i) => prev[i] + SMOOTH * (v - prev[i])) : next);

const input = (id, label, group) => ({ id, label, group });
const TILT = [input("tiltX", "tilt x", "tilt"), input("tiltY", "tilt y", "tilt"), input("tiltZ", "tilt z", "tilt")];
const TURN = [input("turnX", "turn x", "turn"), input("turnY", "turn y", "turn"), input("turnZ", "turn z", "turn")];
const TOUCH = [input("touchX", "touch x", "touch"), input("touchY", "touch y", "touch"), input("touching", "touching", "touch")];
const MOVES = [input("shake", "shake", "move"), input("swingX", "swing x", "move"), input("swingY", "swing y", "move")];

// Groups of inputs to pick from at once (the panel's presets).
export const PRESETS = [
  { name: "Tilt only", groups: ["tilt"] },
  { name: "Tilt + turn", groups: ["tilt", "turn"] },
  { name: "Tilt + moves", groups: ["tilt", "move"] },
  { name: "Sticks & triggers", groups: ["sticks", "triggers"] },
  { name: "Everything", groups: null },
];

// Movement from a 2–3 number position (tilt, or a stick), time-based so it
// means the same at 60 or 250 readings a second.
export class Moves {
  constructor() { this.prev = null; this.t = 0; this.shake = 0; this.swing = [0, 0]; }
  update(pos, now) {
    if (this.prev) {
      const dt = Math.max(0.001, Math.min(0.2, (now - this.t) / 1000));
      const d = pos.map((v, i) => v - this.prev[i]);
      const speed = Math.hypot(...d) / dt;                   // units per second
      this.shake += (speed - this.shake) * (1 - Math.exp(-dt / 0.4));
      const fade = Math.exp(-dt / 0.3);
      this.swing = [0, 1].map((i) => Math.max(-1, Math.min(1, this.swing[i] * fade + d[i] * 2.5)));
    }
    this.prev = pos;
    this.t = now;
    return [Math.min(2, this.shake / 3), this.swing[0], this.swing[1]];
  }
}
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---------------------------------------------------------------- phone
export class PhoneMotion {
  static get supported() { return typeof window !== "undefined" && "DeviceMotionEvent" in window; }
  constructor(onChange) {
    this.kind = "phone";
    this.label = "this phone's motion";
    this.inputs = [...TILT, ...TURN, input("headX", "heading x", "heading"), input("headY", "heading y", "heading"),
                   ...TOUCH, ...MOVES];
    this.features = null;
    this.arm = false;         // set by the on-screen hold-to-play button
    this.record = false;
    this.onChange = onChange;
    this.heading = [0, 0];    // compass, as a direction (no jump at north)
    this.touch = [0, 0, 0];   // the on-screen XY pad: x, y (-1..1), touching
    this.moves = new Moves();
    this._handler = (e) => this._motion(e);
    this._orient = (e) => {
      const deg = e.webkitCompassHeading ?? (e.alpha == null ? null : 360 - e.alpha);
      if (deg != null) this.heading = [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
    };
  }

  // The XY pad in the panel: x, y from -1 to 1, or null when the finger lifts.
  setTouch(x, y) {
    this.touch = x == null ? [this.touch[0], this.touch[1], 0] : [x, y, 1];
  }

  // Must run in a tap: iPhone asks for permission.
  async start() {
    let answer = "granted";
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      try { answer = await DeviceMotionEvent.requestPermission(); } catch (_) { answer = "denied"; }
    }
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try { await DeviceOrientationEvent.requestPermission(); } catch (_) { /* compass stays 0 */ }
    }
    window.addEventListener("deviceorientationabsolute", this._orient);
    window.addEventListener("deviceorientation", this._orient);
    window.addEventListener("devicemotion", this._handler);
    // What counts is whether motion data arrives (some browsers answer
    // "denied" here and send it anyway, or have no sensors at all).
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        window.removeEventListener("devicemotion", this._handler);
        reject(new Error(answer !== "granted"
          ? "motion sensors weren't allowed (iPhone: Settings → Safari → Motion & Orientation Access)"
          : "no motion sensors answered (a computer, or a page that isn't secure?)"));
      }, 2000);
      const once = () => { clearTimeout(t); window.removeEventListener("devicemotion", once); resolve(); };
      window.addEventListener("devicemotion", once);
    });
  }

  _motion(e) {
    const g = e.accelerationIncludingGravity || {};
    const r = e.rotationRate || {};
    const tilt = [(g.x || 0) / 9.81, (g.y || 0) / 9.81, (g.z || 0) / 9.81];
    const next = [...tilt, (r.alpha || 0) / 360, (r.beta || 0) / 360, (r.gamma || 0) / 360,
                  ...this.heading, ...this.touch];
    const base = smooth(this.features?.slice(0, next.length), next);
    this.features = [...base, ...this.moves.update(base.slice(0, 3), nowMs())];
    this.onChange();
  }

  stop() {
    window.removeEventListener("devicemotion", this._handler);
    window.removeEventListener("deviceorientationabsolute", this._orient);
    window.removeEventListener("deviceorientation", this._orient);
  }
  feedback() {}
}

// ---------------------------------------------------------------- DualSense
const SONY = 0x054c;
const DUALSENSE_IDS = [0x0ce6, 0x0df2];          // DualSense, DualSense Edge

// One input report, as the controller sends it over USB (report 0x01, 63
// bytes) or Bluetooth (report 0x31: one extra byte first). Layout as in
// Linux's hid-playstation driver.
export function parseDualSense(reportId, data) {
  let o;
  if (reportId === 0x01 && data.byteLength >= 40) o = 0;          // USB
  else if (reportId === 0x31 && data.byteLength >= 41) o = 1;     // Bluetooth, full report
  else return null;                                                // Bluetooth, basic report
  const u8 = (i) => data.getUint8(o + i);
  const s16 = (i) => data.getInt16(o + i, true);
  const b0 = u8(7), b1 = u8(8), b2 = u8(9);
  const stick = (v) => (v - 128) / 128;
  const touch = (i) => {
    const t0 = u8(32 + i * 4);
    if (t0 & 0x80) return null;                                      // not touching
    const x = u8(33 + i * 4) | ((u8(34 + i * 4) & 0x0f) << 8);
    const y = (u8(34 + i * 4) >> 4) | (u8(35 + i * 4) << 4);
    return { x: x / 1919, y: y / 1079 };
  };
  return {
    lx: stick(u8(0)), ly: stick(u8(1)), rx: stick(u8(2)), ry: stick(u8(3)),
    l2: u8(4) / 255, r2: u8(5) / 255,
    gyro: [s16(15), s16(17), s16(19)],
    accel: [s16(21), s16(23), s16(25)],
    buttons: {
      square: !!(b0 & 0x10), cross: !!(b0 & 0x20), circle: !!(b0 & 0x40), triangle: !!(b0 & 0x80),
      l1: !!(b1 & 0x01), r1: !!(b1 & 0x02), options: !!(b1 & 0x20), ps: !!(b2 & 0x01), touchpad: !!(b2 & 0x02),
    },
    touch: touch(0),
  };
}

export function dualSenseFeatures(s) {
  return [
    s.accel[0] / 8192, s.accel[1] / 8192, s.accel[2] / 8192,      // ~1 = gravity
    s.gyro[0] / 4000, s.gyro[1] / 4000, s.gyro[2] / 4000,          // turning
    s.lx, s.ly, s.rx, s.ry, s.l2, s.r2,
    s.touch ? s.touch.x * 2 - 1 : 0, s.touch ? s.touch.y * 2 - 1 : 0, s.touch ? 1 : 0,
  ];
}

const DUALSENSE_INPUTS = [...TILT, ...TURN,
  input("lx", "left stick x", "sticks"), input("ly", "left stick y", "sticks"),
  input("rx", "right stick x", "sticks"), input("ry", "right stick y", "sticks"),
  input("l2", "L2", "triggers"), input("r2", "R2", "triggers"), ...TOUCH, ...MOVES];

// CRC-32 (as in zlib): Bluetooth output reports end with one.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes, crc = 0xffffffff) {
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

// The 47 bytes that set rumble and the light bar (common to USB and BT).
export function dualSenseOutput({ rumble = 0, rgb = [0, 0, 0], setup = false }) {
  const c = new Uint8Array(47);
  c[0] = 0x01 | 0x02;                  // rumble (compatible vibration + haptics select)
  c[1] = 0x04;                         // light bar colour
  c[2] = rumble; c[3] = rumble;        // right, left motor
  if (setup) { c[38] = 0x02; c[41] = 0x02; }   // take the light bar over from its start-up fade
  c[44] = rgb[0]; c[45] = rgb[1]; c[46] = rgb[2];
  return c;
}

// The report to send: USB 0x02 = the 47 bytes; Bluetooth 0x31 = a header,
// the 47 bytes and a CRC over [0xA2, 0x31, …].
export function dualSenseReport(common, bluetooth, seq = 0) {
  if (!bluetooth) return { id: 0x02, data: common };
  const d = new Uint8Array(77);
  d[0] = (seq & 0x0f) << 4;
  d[1] = 0x10;
  d.set(common, 2);
  const crc = crc32([0xa2, 0x31, ...d.subarray(0, 73)]) ^ 0xffffffff;
  new DataView(d.buffer).setUint32(73, crc >>> 0, true);
  return { id: 0x31, data: d };
}

export class DualSense {
  static get supported() { return typeof navigator !== "undefined" && "hid" in navigator; }
  constructor(onChange) {
    this.kind = "dualsense";
    this.label = "the PS5 controller";
    this.inputs = DUALSENSE_INPUTS;
    this.moves = new Moves();
    this.features = null;
    this.arm = false;          // L1 held
    this.record = false;       // ✕ held
    this.onChange = onChange;
    this.device = null;
    this.bluetooth = false;
    this._seq = 0;
    this._last = { rumble: -1, rgb: "" };
  }

  // Must run in a click: Chrome shows its device chooser.
  async start() {
    const [device] = await navigator.hid.requestDevice({
      filters: DUALSENSE_IDS.map((productId) => ({ vendorId: SONY, productId })),
    });
    if (!device) throw new Error("no controller chosen");
    if (!device.opened) await device.open();
    this.device = device;
    device.addEventListener("inputreport", (e) => this._report(e));
    // Over Bluetooth it sends a basic report (no motion) until this is read.
    try { await device.receiveFeatureReport(0x05); } catch (_) { /* USB: not needed */ }
    this.feedback({ setup: true, rgb: [0, 0, 40] });
  }

  _report(e) {
    if (e.reportId === 0x31) this.bluetooth = true;
    const s = parseDualSense(e.reportId, e.data);
    if (!s) return;
    this.state = s;
    const raw = dualSenseFeatures(s);
    const base = smooth(this.features?.slice(0, raw.length), raw);
    this.features = [...base, ...this.moves.update(base.slice(0, 3), nowMs())];
    this.arm = s.buttons.l1;
    this.record = s.buttons.cross;
    this.onChange();
  }

  // Light bar colour and rumble (0..255); only sent when something changes.
  feedback({ rgb = [0, 0, 0], rumble = 0, setup = false } = {}) {
    if (!this.device?.opened) return;
    const key = rgb.join(",");
    if (!setup && key === this._last.rgb && rumble === this._last.rumble) return;
    this._last = { rgb: key, rumble };
    const { id, data } = dualSenseReport(dualSenseOutput({ rgb, rumble, setup }), this.bluetooth, this._seq++);
    this.device.sendReport(id, data).catch(() => {});
  }

  stop() {
    this.feedback({ rgb: [0, 0, 0], rumble: 0 });
    setTimeout(() => this.device?.close().catch(() => {}), 50);
  }
}

// ---------------------------------------------------------------- any gamepad
export class AnyGamepad {
  static get supported() { return typeof navigator !== "undefined" && "getGamepads" in navigator; }
  constructor(onChange) {
    this.kind = "gamepad";
    this.label = "the game controller";
    this.inputs = [input("lx", "left stick x", "sticks"), input("ly", "left stick y", "sticks"),
                   input("rx", "right stick x", "sticks"), input("ry", "right stick y", "sticks"),
                   input("lt", "left trigger", "triggers"), input("rt", "right trigger", "triggers"), ...MOVES];
    this.moves = new Moves();      // moves of the left stick
    this.features = null;
    this.arm = false;          // left bumper (L1 / LB) held
    this.record = false;       // bottom face button (✕ / A) held
    this.onChange = onChange;
    this._raf = 0;
  }

  async start() {
    const pad = () => [...navigator.getGamepads()].find(Boolean);
    if (!pad()) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no controller found: plug it in and press a button")), 8000);
        window.addEventListener("gamepadconnected", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    this.label = pad().id.replace(/\(.*?\)/g, "").trim() || this.label;
    const loop = () => {
      const p = pad();
      if (p) {
        const a = (i) => p.axes[i] || 0;
        const b = (i) => p.buttons[i]?.value || 0;
        const base = smooth(this.features?.slice(0, 6), [a(0), a(1), a(2), a(3), b(6), b(7)]);
        this.features = [...base, ...this.moves.update(base.slice(0, 2), nowMs())];
        this.arm = !!p.buttons[4]?.pressed;
        this.record = !!p.buttons[0]?.pressed;
        this.onChange();
      }
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() { cancelAnimationFrame(this._raf); }
  feedback() {}
}
