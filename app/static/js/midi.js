// MIDI controllers: play the pipes live from a keyboard or pads, and drive
// the app from knobs and buttons (Web MIDI: Chrome and Edge).
//
//   keyboard   plug and play: each key plays the pipe tuned closest to it
//              (the pitches in the Listen panel); the sustain pedal holds
//   pads       plug and play: consecutive pads from a base note play A, B, C…
//   pad grid   Launchpad Mini MK3 / X, APC mini / mk2: the 8×8 pads show and
//              edit the pattern (rows = pipes, 8 steps a page), the side
//              buttons play the pipes live
//   learn      any key, pad, button or knob can be linked to a pipe, Play/Stop,
//              Record, Clear, Tempo or Sustain; saved per controller
//
// The pure parts (parsing, mapping, LED frames) are exported for tests; the
// app (app.js) decides what each action does.

export const ACTIONS = ["pipe", "playstop", "record", "clear", "tempo", "sustain"];
const PAD_NAMES = /\b(pad|mpd|lpd|nanopad|maschine|mpc|fire|beatstep)/i;

// ---------------------------------------------------------------- messages
// -> {type: "on"|"off"|"cc", ch: 0..15, num, value} or null (clock, sysex…)
export function parseMessage(data) {
  if (!data || data.length < 2) return null;
  const status = data[0] & 0xf0;
  const ch = data[0] & 0x0f;
  const num = data[1];
  const value = data[2] ?? 0;
  if (status === 0x90) return { type: value > 0 ? "on" : "off", ch, num, value };
  if (status === 0x80) return { type: "off", ch, num, value };
  if (status === 0xb0) return { type: "cc", ch, num, value };
  return null;
}

// The key a learned control is saved under: "n9:36" (note 36, channel 10).
export const controlKey = (msg) => `${msg.type === "cc" ? "c" : "n"}${msg.ch}:${msg.num}`;

export function describeControl(key) {
  const m = /^([nc])(\d+):(\d+)$/.exec(key);
  if (!m) return key;
  const ch = +m[2] + 1;
  return m[1] === "c" ? `knob/button CC ${m[3]} (ch ${ch})` : `${noteLabel(+m[3])} (ch ${ch})`;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteLabel = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

// ---------------------------------------------------------------- devices
export function deviceKind(name) {
  if (profileFor(name)) return "grid";
  return PAD_NAMES.test(name) ? "pads" : "keyboard";
}

// Default settings for a newly seen controller.
export function defaultSettings(name) {
  const kind = deviceKind(name);
  return {
    enabled: true,
    mode: kind === "grid" ? "grid" : kind === "pads" ? "row" : "pitch",
    base: 36,                 // "row" mode: the note that plays pipe A
    bindings: {},             // controlKey -> "pipe:3" | "playstop" | "record" | "clear" | "tempo" | "sustain"
  };
}

// ---------------------------------------------------------------- mapping
// Pitch mode: the pipe tuned closest to the key (among the pipes in use).
export function nearestPipe(note, pipeNotes, rows) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < Math.min(rows, pipeNotes.length); i++) {
    const d = Math.abs(pipeNotes[i] - note);
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}

// What a message means for this controller, or null.
//   {kind: "pipe", pipe, down}   {kind: "sustain", down}   {kind: "tempo", tempo}
//   {kind: "playstop" | "record" | "clear"}
//   {kind: "cell", row, col}     {kind: "page", delta}      (pad grids)
// ctx: {pipeNotes, rows, cols, page, profile}
export function mapMessage(settings, msg, ctx) {
  if (!msg) return null;
  const bound = settings.bindings?.[controlKey(msg)];
  if (bound) return fromBinding(bound, msg);

  if (settings.mode === "grid" && ctx.profile) {
    const hit = ctx.profile.decode(msg);
    if (hit?.pad) {
      if (msg.type !== "on" && !(msg.type === "cc" && msg.value > 0)) return null;
      const [row, c] = hit.pad;
      const col = ctx.page * 8 + c;
      return row < ctx.rows && col < ctx.cols ? { kind: "cell", row, col } : null;
    }
    if (hit?.pipe !== undefined) {
      if (hit.pipe >= ctx.rows) return null;
      return { kind: "pipe", pipe: hit.pipe, down: isDown(msg) };
    }
    if (hit?.page) return isDown(msg) ? { kind: "page", delta: hit.page } : null;
    if (hit?.tempo !== undefined) return { kind: "tempo", tempo: knobTempo(msg.value) };
    if (hit) return null;
  }

  if (msg.type === "cc") {
    if (msg.num === 64) return { kind: "sustain", down: msg.value >= 64 };   // sustain pedal
    return null;
  }
  if (settings.mode === "row") {
    const pipe = msg.num - settings.base;
    if (pipe < 0 || pipe >= ctx.rows) return null;
    return { kind: "pipe", pipe, down: msg.type === "on" };
  }
  if (settings.mode === "pitch") {
    return { kind: "pipe", pipe: nearestPipe(msg.num, ctx.pipeNotes, ctx.rows), down: msg.type === "on" };
  }
  return null;
}

const isDown = (msg) => (msg.type === "cc" ? msg.value >= 64 : msg.type === "on");
export const knobTempo = (v) => Math.round(20 + (v / 127) * 280);

function fromBinding(target, msg) {
  if (target.startsWith("pipe:")) return { kind: "pipe", pipe: parseInt(target.slice(5), 10), down: isDown(msg) };
  if (target === "tempo") return msg.type === "cc" ? { kind: "tempo", tempo: knobTempo(msg.value) } : null;
  if (target === "sustain") return { kind: "sustain", down: isDown(msg) };
  // Buttons act when pressed, not when let go.
  return isDown(msg) ? { kind: target } : null;
}

// ---------------------------------------------------------------- live notes
// Which pipes are held: keys (several keys can hold one pipe) + sustain.
export class LiveNotes {
  constructor() {
    this.held = new Map();        // source key -> pipe
    this.sustain = false;
    this.sustained = new Set();
  }

  // source: something unique per key/pad ("device|n0:60")
  press(source, pipe) { this.held.set(source, pipe); }
  release(source) {
    const pipe = this.held.get(source);
    this.held.delete(source);
    if (pipe !== undefined && this.sustain) this.sustained.add(pipe);
  }
  setSustain(down) {
    this.sustain = down;
    if (!down) this.sustained.clear();
  }
  clear() { this.held.clear(); this.sustained.clear(); this.sustain = false; }

  get mask() {
    let m = 0;
    for (const p of this.held.values()) m |= 1 << p;
    for (const p of this.sustained) m |= 1 << p;
    return m & 0xff;
  }
}

// Recording: a key pressed in the second half of a step lands on the next
// one (people play slightly early far more than late).
export function recordStep(playhead, lastStepAt, stepMs, now, cols) {
  if (playhead < 0) return -1;
  return now - lastStepAt > stepMs / 2 ? (playhead + 1) % cols : playhead;
}

// ---------------------------------------------------------------- pad grids
// An LED frame: 64 pad colours (row 0 = top = pipe A) + 8 side buttons.
// Colours are names; each profile turns them into its own palette.
export function gridFrame({ grid, rows, cols, playhead, page, live }) {
  const pads = new Array(64).fill("off");
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const col = page * 8 + c;
      if (r >= rows || col >= cols) continue;
      const on = grid[r]?.[col] === 1;
      const head = col === playhead;
      pads[r * 8 + c] = head ? (on ? "hit" : "head") : on ? "on" : "dim";
    }
  }
  const side = Array.from({ length: 8 }, (_, i) => (i >= rows ? "off" : (live >> i) & 1 ? "hit" : "dim"));
  return { pads, side };
}

// Messages to change the LEDs from frame `prev` (or everything) to `next`.
export function ledMessages(profile, next, prev = null) {
  const out = [];
  next.pads.forEach((colour, k) => {
    if (prev && prev.pads[k] === colour) return;
    out.push(profile.padLed(Math.floor(k / 8), k % 8, colour));
  });
  next.side.forEach((colour, i) => {
    if (prev && prev.side[i] === colour) return;
    out.push(profile.sideLed(i, colour));
  });
  return out;
}

// Launchpads in Programmer mode: pads are notes 11..88 (row 1 = bottom),
// the right column CC 19..89, the top row CC 91..98 (arrows 91–94).
function launchpad(id, pattern) {
  const PAL = { off: 0, dim: 1, on: 13, head: 21, hit: 5 };   // grey, yellow, green, red
  return {
    name: id,
    match: (n) => pattern.test(n) && !/DAW/i.test(n),
    init: [[0xf0, 0x00, 0x20, 0x29, 0x02, id === "Launchpad X" ? 0x0c : 0x0d, 0x0e, 0x01, 0xf7]],
    exit: [[0xf0, 0x00, 0x20, 0x29, 0x02, id === "Launchpad X" ? 0x0c : 0x0d, 0x0e, 0x00, 0xf7]],
    sysex: true,
    decode(msg) {
      if (msg.type !== "cc") {
        const row = 8 - Math.floor(msg.num / 10);
        const c = (msg.num % 10) - 1;
        return row >= 0 && row < 8 && c >= 0 && c < 8 ? { pad: [row, c] } : null;
      }
      if (msg.num % 10 === 9 && msg.num >= 19 && msg.num <= 89) return { pipe: 8 - Math.floor(msg.num / 10) };
      if (msg.num === 93) return { page: -1 };
      if (msg.num === 94) return { page: 1 };
      return msg.num >= 91 ? {} : null;
    },
    padLed: (r, c, colour) => [0x90, (8 - r) * 10 + c + 1, PAL[colour]],
    sideLed: (i, colour) => [0xb0, (8 - i) * 10 + 9, PAL[colour]],
  };
}

export const PROFILES = [
  launchpad("Launchpad Mini MK3", /LPMiniMK3|Launchpad Mini MK3/i),
  launchpad("Launchpad X", /LPX|Launchpad X/i),
  {
    // APC mini mk2: pads 0..63 (bottom-left 0), RGB by palette index with
    // brightness in the channel; scene buttons 112..119 (top to bottom).
    name: "APC mini mk2",
    match: (n) => /APC mini mk2/i.test(n),
    init: [],
    decode(msg) {
      if (msg.type === "cc") return msg.num === 56 ? { tempo: true } : null;   // master fader
      if (msg.num < 64) return { pad: [7 - Math.floor(msg.num / 8), msg.num % 8] };
      if (msg.num >= 112 && msg.num <= 119) return { pipe: msg.num - 112 };
      if (msg.num === 0x66) return { page: -1 };
      if (msg.num === 0x67) return { page: 1 };
      return msg.num >= 100 ? {} : null;
    },
    padLed: (r, c, colour) => [0x96, (7 - r) * 8 + c, { off: 0, dim: 1, on: 13, head: 21, hit: 5 }[colour]],
    sideLed: (i, colour) => [0x90, 112 + i, colour === "off" || colour === "dim" ? 0 : 1],
  },
  {
    // APC mini (first model): pads 0..63, LED colour by velocity
    // (1 green, 3 red, 5 yellow); scene buttons 82..89; arrows 64..67.
    name: "APC mini",
    match: (n) => /APC MINI/i.test(n) && !/mk2/i.test(n),
    init: [],
    decode(msg) {
      if (msg.type === "cc") return msg.num === 56 ? { tempo: true } : null;
      if (msg.num < 64) return { pad: [7 - Math.floor(msg.num / 8), msg.num % 8] };
      if (msg.num >= 82 && msg.num <= 89) return { pipe: msg.num - 82 };
      if (msg.num === 66) return { page: -1 };
      if (msg.num === 67) return { page: 1 };
      return msg.num >= 64 ? {} : null;
    },
    padLed: (r, c, colour) => [0x90, (7 - r) * 8 + c, { off: 0, dim: 0, on: 5, head: 1, hit: 3 }[colour]],
    sideLed: (i, colour) => [0x90, 82 + i, colour === "hit" ? 1 : 0],
  },
];

export function profileFor(name) {
  return PROFILES.find((p) => p.match(String(name || ""))) || null;
}

// ---------------------------------------------------------------- Web MIDI
// Keeps track of controllers (plugging in and out included) and passes on
// their messages: onMessage(device, msg, raw). device = {id, name, profile, output}.
export class MidiPorts {
  constructor({ onMessage, onDevices }) {
    this.onMessage = onMessage;
    this.onDevices = onDevices;
    this.access = null;
    this.sysex = false;
    this.devices = [];
  }

  static get supported() { return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator; }

  // sysex: needed only to switch a Launchpad into its pad-grid mode
  // (the browser asks the person for permission).
  async enable({ sysex = false } = {}) {
    const access = await navigator.requestMIDIAccess({ sysex });
    if (this.access) this.access.onstatechange = null;
    this.access = access;
    this.sysex = sysex;
    access.onstatechange = () => this._refresh();
    this._refresh();
    return this.devices;
  }

  _refresh() {
    const outputs = [...this.access.outputs.values()];
    const devices = [];
    for (const input of this.access.inputs.values()) {
      if (input.state !== "connected") continue;
      const name = input.name || "MIDI device";
      // Ignore the computer's own virtual buses unless chosen in Learn.
      if (/IAC|Bus \d|Through/i.test(name) && !/key|pad|launch|apc/i.test(name)) continue;
      const output = outputs.find((o) => o.name === name && o.state === "connected")
        || outputs.find((o) => o.manufacturer === input.manufacturer && profileFor(o.name) && profileFor(name));
      const device = { id: input.id, name, profile: profileFor(name), output: output || null };
      input.onmidimessage = (e) => {
        const msg = parseMessage(e.data);
        if (msg) this.onMessage(device, msg, e.data);
      };
      devices.push(device);
    }
    this.devices = devices;
    this.onDevices(devices);
  }

  send(device, bytes) {
    try { device.output?.send(bytes); } catch (_) { /* unplugged, or sysex not allowed */ }
  }
}
