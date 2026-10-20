// Rhythm: what each cell plays (a figure), how fast each pipe's row runs
// (its rate against the master beat), how long it is, and the meter.
// The same rules run in the pipe firmware (calum_receiver.ino, 1.4+), so the
// preview, the simulated sound and the playheads match the organ.
//
//   master position  the hub's step count + how far into the current step
//   row position     master position × the row's rate
//   cell             floor(row position) mod the row's length
//   phase            how far into that cell (0..1): the figure decides
//                    whether the valve is open at this moment

export const FIG = { OFF: 0, FULL: 1, DETACHED: 2, STACCATO: 3, REP2: 4, REP3: 5, REP4: 6, OFFBEAT: 7 };

// glyph: drawn in the cell; brush order in the palette.
export const FIGURES = [
  { code: FIG.FULL, name: "full", glyph: "", help: "open the whole step; joins the next full step into one long note" },
  { code: FIG.DETACHED, name: "detached", glyph: "◐", help: "most of the step, so the next note starts again" },
  { code: FIG.STACCATO, name: "staccato", glyph: "·", help: "short" },
  { code: FIG.REP2, name: "2 repeats", glyph: "⁚", help: "two quick notes in the step" },
  { code: FIG.REP3, name: "3 repeats", glyph: "⁝", help: "three quick notes (a triplet)" },
  { code: FIG.REP4, name: "4 repeats", glyph: "⁞", help: "four quick notes" },
  { code: FIG.OFFBEAT, name: "offbeat", glyph: "◑", help: "only the second half of the step" },
];

export const isFigure = (v) => Number.isInteger(v) && v >= 0 && v <= 7;

// Is the valve open, for this figure, this far (0..1) into its step?
export function figureOpen(code, phase) {
  switch (code) {
    case FIG.FULL: return true;
    case FIG.DETACHED: return phase < 0.85;
    case FIG.STACCATO: return phase < 0.3;
    case FIG.REP2: return (phase * 2) % 1 < 0.5;
    case FIG.REP3: return (phase * 3) % 1 < 0.5;
    case FIG.REP4: return (phase * 4) % 1 < 0.5;
    case FIG.OFFBEAT: return phase >= 0.5;
    default: return false;
  }
}

// The shortest open or closed moment a figure asks of the valve, in ms, at
// this step length (to warn when it's faster than a solenoid can follow).
export function shortestMs(code, stepMs) {
  const part = { [FIG.DETACHED]: 0.15, [FIG.STACCATO]: 0.3, [FIG.REP2]: 0.25, [FIG.REP3]: 1 / 6,
                 [FIG.REP4]: 0.125, [FIG.OFFBEAT]: 0.5 }[code];
  return part ? part * stepMs : Infinity;
}

// ---------------------------------------------------------------- rates
// A row's rate: a ratio to the master beat ({num, den}) or its own tempo
// ({bpm}), which is a ratio to the current master tempo.
export const RATIOS = [[1, 2], [2, 3], [3, 4], [4, 5], [1, 1], [5, 4], [4, 3], [3, 2], [2, 1]];
export const ONE = Object.freeze({ num: 1, den: 1 });

export function rateValue(rate, masterTempo) {
  if (rate?.bpm) return rate.bpm / masterTempo;
  return rate?.num && rate?.den ? rate.num / rate.den : 1;
}
// As two whole numbers for the hub (PAT2): {bpm} -> bpm/tempo.
export function rateFraction(rate, masterTempo) {
  if (rate?.bpm) return [Math.round(rate.bpm), masterTempo];
  return [rate?.num || 1, rate?.den || 1];
}
export function rateLabel(rate) {
  if (rate?.bpm) return `${rate.bpm}/min`;
  return rate && !(rate.num === rate.den) ? `${rate.num}:${rate.den}` : "";
}

// Where a row is at this master position.
export function rowAt(cells, len, rate, masterTempo, masterPos) {
  if (masterPos < 0) return { cell: -1, phase: 0, open: false };
  const pos = masterPos * rateValue(rate, masterTempo);
  const whole = Math.floor(pos);
  const cell = ((whole % len) + len) % len;
  const phase = pos - whole;
  return { cell, phase, open: figureOpen(cells[cell] || 0, phase) };
}

// ---------------------------------------------------------------- meter
// "4", "3", "3+3+2", "2+2+3"… -> [3, 3, 2]; null if it doesn't make sense.
export function parseMeter(text) {
  const parts = String(text).split("+").map((t) => parseInt(t.trim(), 10));
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 1 || n > 16)) return null;
  if (parts.reduce((a, b) => a + b, 0) > 32) return null;
  return parts;
}
export const meterText = (m) => m.join("+");
export const METERS = ["4", "3", "2", "5", "7", "3+3+2", "2+2+3", "3+2+2", "2+3"];

// Per column: 2 = start of a bar (the whole grouping), 1 = start of a beat, 0 = inside a beat.
export function beatMarks(meter, cols) {
  const bar = meter.reduce((a, b) => a + b, 0);
  const starts = new Set();
  let at = 0;
  for (const g of meter) { starts.add(at); at += g; }
  return Array.from({ length: cols }, (_, j) => (j % bar === 0 ? 2 : starts.has(j % bar) ? 1 : 0));
}

// ---------------------------------------------------------------- the whole rhythm
// rhythm = {meter: [4], rows: [{len, rate}]}: defaults for a grid.
export function defaultRhythm(rows, cols) {
  return { meter: [4], rows: Array.from({ length: rows }, () => ({ len: cols, rate: { ...ONE } })) };
}

// Make a rhythm fit a grid (rows added/removed, lengths no longer than the grid).
export function fitRhythm(rhythm, rows, cols, oldCols = cols) {
  const meter = Array.isArray(rhythm?.meter) && parseMeter(meterText(rhythm.meter)) ? rhythm.meter.slice() : [4];
  const out = [];
  for (let i = 0; i < rows; i++) {
    const r = rhythm?.rows?.[i];
    let len = Number.isInteger(r?.len) ? r.len : cols;
    if (len === oldCols) len = cols;              // rows that were full-length stay full-length
    out.push({ len: Math.max(1, Math.min(cols, len)), rate: cleanRate(r?.rate) });
  }
  return { meter, rows: out };
}

export function cleanRate(rate) {
  if (rate?.bpm && Number.isFinite(rate.bpm)) return { bpm: Math.max(5, Math.min(600, Math.round(rate.bpm))) };
  const num = Number.isInteger(rate?.num) ? rate.num : 1;
  const den = Number.isInteger(rate?.den) ? rate.den : 1;
  if (num < 1 || den < 1 || num > 16 || den > 16) return { ...ONE };
  return { num, den };
}

export const isPlain = (rh) => rh.rows.every((r, i, a) => r.len === a[0].len && !r.rate.bpm && r.rate.num === r.rate.den);
