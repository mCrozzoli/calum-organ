// Tests for choosing what each sound source plays (js/corpus.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { samplePlan, synthPlan, OPEN_PIPE, SOURCES, DEFAULT_SOURCE } = await import("../../app/static/js/corpus.js");
const st = await import("../../app/static/js/stage.js");
const corpus = JSON.parse(readFileSync(new URL("../../app/static/corpus/corpus.json", import.meta.url)));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("recorded organ: nearest note, never more than 1.5 semitones of shifting", () => {
  for (let midi = 36; midi <= 84.5; midi += 0.5) {
    const p = samplePlan(corpus, midi);
    const s = corpus.samples[p.buf];
    const shift = 12 * Math.log2(p.rate);
    assert.ok(Math.abs(shift) <= 1.6, `${midi}: shift ${shift}`);
    assert.ok(near(s.midi + shift, midi, 1e-6), "plays exactly the asked pitch");
    assert.equal(p.loopStart, s.loopStart);
    assert.equal(p.loopEnd, s.loopEnd);
  }
});

test("recorded organ: quarter tones come out a quarter tone apart", () => {
  const a = samplePlan(corpus, 60), b = samplePlan(corpus, 60.5);
  assert.equal(a.buf, b.buf);
  assert.ok(near(b.rate / a.rate, 2 ** (1 / 24)));
});

test("synth: open pipe vs the stopped pipe measured from the recording", () => {
  const open = synthPlan("open", corpus, 48);
  assert.deepEqual(open.harm, OPEN_PIPE);
  assert.ok(synthPlan("open", corpus, 36).attack > synthPlan("open", corpus, 84).attack, "low pipes speak slower");
  const stopped = synthPlan("stopped", corpus, 48);
  assert.equal(stopped.harm.length, 8);
  assert.ok(stopped.harm[1] < 0.05 && stopped.harm[2] > stopped.harm[1], "stopped pipe: odd harmonics");
  // without a corpus the stopped pipe falls back to the open one
  assert.deepEqual(synthPlan("stopped", null, 48).harm, OPEN_PIPE);
});

test("stage keeps a valid source", () => {
  assert.equal(st.defaultStage().source, DEFAULT_SOURCE);
  assert.equal(st.sanitizeStage({ source: "open" }).source, "open");
  assert.equal(st.sanitizeStage({ source: "toString" }).source, DEFAULT_SOURCE);
  assert.ok(Object.keys(SOURCES).includes(DEFAULT_SOURCE));
});
