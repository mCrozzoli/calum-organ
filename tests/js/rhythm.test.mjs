// Tests for rhythm (js/rhythm.js): figures, per-pipe length and rate,
// meters, and the PAT2 frame. The pipe firmware follows the same rules.
import { test } from "node:test";
import assert from "node:assert/strict";

const r = await import("../../app/static/js/rhythm.js");
const protocol = await import("../../app/static/js/protocol.js");
const { FIG } = r;

const openAt = (code, steps = 100) => Array.from({ length: steps }, (_, k) => r.figureOpen(code, k / steps));
const share = (code) => openAt(code).filter(Boolean).length / 100;
const attacks = (code) => openAt(code).filter((v, k, a) => v && (k === 0 || !a[k - 1])).length;

test("figures: how long and how often the valve opens in a step", () => {
  assert.equal(share(FIG.OFF), 0);
  assert.equal(share(FIG.FULL), 1);
  assert.equal(share(FIG.DETACHED), 0.85);
  assert.equal(share(FIG.STACCATO), 0.3);
  assert.equal(attacks(FIG.REP2), 2);
  assert.equal(attacks(FIG.REP3), 3);
  assert.equal(attacks(FIG.REP4), 4);
  assert.equal(r.figureOpen(FIG.OFFBEAT, 0.2), false);
  assert.equal(r.figureOpen(FIG.OFFBEAT, 0.7), true);
  assert.equal(r.FIGURES.length, 7);
  // at 120 steps/min (500 ms a step) four repeats move the valve every 62.5 ms
  assert.equal(r.shortestMs(FIG.REP4, 500), 62.5);
  assert.equal(r.shortestMs(FIG.FULL, 500), Infinity);
});

test("two full steps side by side are one long note", () => {
  const cells = [FIG.FULL, FIG.FULL, 0, 0];
  const at = (pos) => r.rowAt(cells, 4, null, 120, pos).open;
  assert.ok(at(0.99) && at(1.0) && at(1.5), "no gap between the two steps");
  assert.equal(at(2.1), false);
  const det = [FIG.DETACHED, FIG.DETACHED];
  assert.equal(r.rowAt(det, 2, null, 120, 0.9).open, false, "detached leaves a gap: the next note starts again");
});

test("a row's own length (polymeter) and rate (polyrhythm)", () => {
  const cells = [1, 0, 0];
  // 3 steps against the master count: cell = count mod 3
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => r.rowAt(cells, 3, null, 120, n).cell), [0, 1, 2, 0, 1]);
  // 3:2 -> three cells in the time of two master steps
  const fast = { num: 3, den: 2 };
  assert.deepEqual([0, 2 / 3, 4 / 3, 2].map((p) => r.rowAt([1, 1, 1, 1], 4, fast, 120, p + 1e-9).cell), [0, 1, 2, 3]);
  // its own tempo: 180 against 120 is the same as 3:2
  assert.equal(r.rateValue({ bpm: 180 }, 120), 1.5);
  assert.deepEqual(r.rateFraction({ bpm: 121 }, 120), [121, 120]);
  assert.deepEqual(r.rateFraction({ num: 4, den: 3 }, 120), [4, 3]);
  assert.equal(r.rateLabel({ num: 3, den: 2 }), "3:2");
  assert.equal(r.rateLabel({ num: 1, den: 1 }), "");
  assert.equal(r.rateLabel({ bpm: 121 }), "121/min");
  assert.equal(r.rowAt(cells, 3, null, 120, -1).cell, -1, "stopped");
});

test("meters", () => {
  assert.deepEqual(r.parseMeter("3+3+2"), [3, 3, 2]);
  assert.deepEqual(r.parseMeter(" 7 "), [7]);
  assert.equal(r.parseMeter("3+x"), null);
  assert.equal(r.parseMeter("20+20"), null);
  assert.deepEqual(r.beatMarks([3, 3, 2], 10), [2, 0, 0, 1, 0, 0, 1, 0, 2, 0]);
  assert.deepEqual(r.beatMarks([4], 9), [2, 0, 0, 0, 2, 0, 0, 0, 2]);
});

test("a rhythm fits its grid", () => {
  const rh = r.defaultRhythm(2, 16);
  assert.deepEqual(rh, { meter: [4], rows: [{ len: 16, rate: { num: 1, den: 1 } }, { len: 16, rate: { num: 1, den: 1 } }] });
  rh.rows[1] = { len: 12, rate: { num: 3, den: 2 } };
  const wider = r.fitRhythm(rh, 3, 24, 16);
  assert.deepEqual(wider.rows.map((x) => x.len), [24, 12, 24], "full-length rows follow the grid; a shorter one keeps its length");
  assert.deepEqual(wider.rows[1].rate, { num: 3, den: 2 });
  assert.equal(r.fitRhythm(rh, 2, 8, 16).rows[1].len, 8, "never longer than the grid");
  assert.deepEqual(r.cleanRate({ num: 99, den: 1 }), { num: 1, den: 1 });
  assert.deepEqual(r.cleanRate({ bpm: 1000 }), { bpm: 600 });
  assert.equal(r.isPlain(r.defaultRhythm(3, 8)), true);
  assert.equal(r.isPlain(wider), false);
});

test("PAT2: lengths, rates and figures for a 1.4 hub", () => {
  const grid = [[1, 2, 3, 0], [4, 0, 7, 0]];
  const line = protocol.encodePattern2(120, grid, [{ len: 4, num: 1, den: 1 }, { len: 3, num: 3, den: 2 }]);
  assert.equal(line, "PAT2 120 2 4/1/1/1230 3/3/2/407\n");
  const back = protocol.decodePattern2(line);
  assert.equal(back.tempo, 120);
  assert.deepEqual(back.rows[1], { len: 3, num: 3, den: 2, cells: [4, 0, 7] });
  assert.throws(() => protocol.encodePattern2(120, grid, [{ len: 5, num: 1, den: 1 }, { len: 3, num: 1, den: 1 }]));
  assert.throws(() => protocol.encodePattern2(120, grid, [{ len: 4, num: 0, den: 1 }, { len: 3, num: 1, den: 1 }]));
  assert.throws(() => protocol.decodePattern2("PAT2 120 1 3/1/1/18"), protocol.ProtocolError);
});
