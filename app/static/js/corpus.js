// What each sound source needs per pipe. Pure functions, no audio.
//
// The corpus (corpus/corpus.json, built by tools/build_corpus.py) holds
// recorded organ notes every three semitones, plus a model of that organ
// (harmonic levels and attack time per note) that the synth can use.

export const SOURCES = {
  recorded: "Recorded organ",
  stopped: "Synth: stopped pipe",
  open: "Synth: open pipe",
};
export const DEFAULT_SOURCE = "recorded";

// A classic open flue pipe (principal / diapason): every harmonic present,
// falling away steadily. Levels relative to the fundamental.
export const OPEN_PIPE = [1, 0.42, 0.2, 0.11, 0.06, 0.035, 0.02, 0.01];

const closest = (list, midi) =>
  list.reduce((best, s, i) => (Math.abs(s.midi - midi) < Math.abs(list[best].midi - midi) ? i : best), 0);

// Recorded organ: which note to play, and how much faster or slower, so it
// sounds at `midi` (quarter tones included). At most 1.5 semitones away.
export function samplePlan(corpus, midi) {
  const i = closest(corpus.samples, midi);
  const s = corpus.samples[i];
  return { buf: i, rate: 2 ** ((midi - s.midi) / 12), loopStart: s.loopStart, loopEnd: s.loopEnd };
}

// Synth: the harmonic levels and attack time for a pipe at `midi`.
export function synthPlan(source, corpus, midi) {
  if (source === "stopped" && corpus?.model?.length) {
    const m = corpus.model[closest(corpus.model, midi)];
    return { harm: m.harmonics, attack: m.attack };
  }
  // Open pipe: low pipes speak more slowly than high ones.
  const attack = Math.min(0.2, Math.max(0.03, 0.2 - ((midi - 36) / 48) * 0.17));
  return { harm: OPEN_PIPE, attack: Math.round(attack * 1000) / 1000 };
}
