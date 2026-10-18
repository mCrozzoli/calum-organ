// The listening stage: where each simulated pipe stands and what note it
// plays. Pure functions only (no audio, no DOM), so they can be tested.
//
// Stage coordinates: a square seen from above, x 0..1 left to right,
// y 0..1 top to bottom. The listener stands somewhere in it, facing the top.

export const PIPES = 8;
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const MIN_NOTE = 36;    // C2
export const MAX_NOTE = 84;    // C6
// C major pentatonic from C3: sounds good whatever the pattern.
export const DEFAULT_NOTES = [48, 50, 52, 55, 57, 60, 62, 64];
// Side of the square, in metres.
export const ROOMS = { small: 6, medium: 12, large: 24 };
export const OUTPUTS = ["headphones", "speakers"];

export const noteName = (midi) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
export const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function defaultStage() {
  // Pipes on an arc in front of the listener, A on the left.
  const pipes = DEFAULT_NOTES.map((note, i) => {
    const a = ((-70 + (140 * i) / (PIPES - 1)) * Math.PI) / 180;
    return { x: round3(0.5 + 0.32 * Math.sin(a)), y: round3(0.55 - 0.32 * Math.cos(a)), note };
  });
  return {
    pipes,
    listener: { x: 0.5, y: 0.62 },
    room: "medium",
    output: "headphones",
    volume: 0.7,
  };
}

// -> { azimuth (radians: 0 front, +pi/2 right, -pi/2 left, pi behind),
//      distance (metres) } of a pipe as heard by the listener.
export function placement(pipe, listener, roomMetres) {
  const dx = (pipe.x - listener.x) * roomMetres;
  const ahead = (listener.y - pipe.y) * roomMetres;
  return { azimuth: Math.atan2(dx, ahead), distance: Math.max(0.3, Math.hypot(dx, ahead)) };
}

// A short spoken description, for screen readers and tooltips.
export function describe(pipe, listener, roomMetres) {
  const { azimuth, distance } = placement(pipe, listener, roomMetres);
  const deg = (azimuth * 180) / Math.PI;
  const a = Math.abs(deg);
  const lr = deg > 0 ? "right" : "left";
  const side = a < 15 ? "ahead" : a > 165 ? "behind"
    : a < 75 ? `front ${lr}` : a > 105 ? `behind ${lr}` : lr;
  return `${distance.toFixed(1)} m ${side}`;
}

// Anything read back from storage goes through here: wrong or missing
// fields fall back to the defaults instead of breaking the page.
export function sanitizeStage(raw) {
  const d = defaultStage();
  if (!raw || typeof raw !== "object") return d;
  const unit = (v, fallback) => (Number.isFinite(v) ? clamp(v, 0, 1) : fallback);
  const pipes = d.pipes.map((p, i) => {
    const r = Array.isArray(raw.pipes) ? raw.pipes[i] : null;
    if (!r || typeof r !== "object") return p;
    const note = Number.isInteger(r.note) ? clamp(r.note, MIN_NOTE, MAX_NOTE) : p.note;
    return { x: unit(r.x, p.x), y: unit(r.y, p.y), note };
  });
  const l = raw.listener && typeof raw.listener === "object" ? raw.listener : {};
  return {
    pipes,
    listener: { x: unit(l.x, d.listener.x), y: unit(l.y, d.listener.y) },
    room: typeof raw.room === "string" && Object.hasOwn(ROOMS, raw.room) ? raw.room : d.room,
    output: OUTPUTS.includes(raw.output) ? raw.output : d.output,
    volume: Number.isFinite(raw.volume) ? clamp(raw.volume, 0, 1) : d.volume,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
