// Learning gestures by example (in the spirit of Wekinator): record a few
// seconds of a pose for each set of pipes, train, then play. A small
// multilayer perceptron, in plain JavaScript (no library): inputs are the
// controller's numbers (tilt, rotation, sticks…), one output per pipe (A–H),
// each "how sure am I this pipe should be open" from 0 to 1.

const PIPES = 8;

// Small, seeded random numbers: the same examples train the same model.
function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class MLP {
  constructor(nIn, nHidden = 24, nOut = PIPES, seed = 1) {
    const r = rng(seed);
    const init = (n, fan) => Float64Array.from({ length: n }, () => (r() * 2 - 1) * Math.sqrt(6 / fan));
    Object.assign(this, { nIn, nHidden, nOut });
    this.w1 = init(nIn * nHidden, nIn + nHidden);
    this.b1 = new Float64Array(nHidden);
    this.w2 = init(nHidden * nOut, nHidden + nOut);
    this.b2 = new Float64Array(nOut);
  }

  forward(x) {
    const { nIn, nHidden, nOut } = this;
    const h = new Float64Array(nHidden);
    for (let j = 0; j < nHidden; j++) {
      let s = this.b1[j];
      for (let i = 0; i < nIn; i++) s += x[i] * this.w1[i * nHidden + j];
      h[j] = Math.tanh(s);
    }
    const y = new Float64Array(nOut);
    for (let k = 0; k < nOut; k++) {
      let s = this.b2[k];
      for (let j = 0; j < nHidden; j++) s += h[j] * this.w2[j * nOut + k];
      y[k] = 1 / (1 + Math.exp(-s));
    }
    return { h, y };
  }

  toJSON() {
    return { nIn: this.nIn, nHidden: this.nHidden, nOut: this.nOut,
             w1: [...this.w1], b1: [...this.b1], w2: [...this.w2], b2: [...this.b2] };
  }

  static fromJSON(o) {
    const m = new MLP(o.nIn, o.nHidden, o.nOut);
    for (const k of ["w1", "b1", "w2", "b2"]) {
      if (!Array.isArray(o[k]) || o[k].length !== m[k].length) throw new Error("model doesn't fit");
      m[k] = Float64Array.from(o[k]);
    }
    return m;
  }
}

// Controls a pose can also set, besides the pipes (values 0..1 inside the
// model; the app turns them into steps/min or steps).
export const CONTROLS = ["tempo", "loop", "section"];

// Examples, normalisation, training and playing for one controller.
// Each example keeps every input and every taught value, so changing which
// inputs or outputs are used only needs training again, not re-teaching.
export class Learner {
  constructor(nIn) {
    this.nIn = nIn;
    this.examples = [];        // [{x: number[nIn], mask, values: {tempo: 0..1, …}}]
    this.model = null;
    this.inputs = null;        // which inputs the model uses (indices)
    this.controls = [];        // which controls it learnt, in output order (after the 8 pipes)
    this.mean = null;
    this.std = null;
  }

  add(x, mask, values = {}) {
    if (x.length !== this.nIn) throw new Error("wrong number of inputs");
    const v = {};
    for (const c of CONTROLS) if (Number.isFinite(values[c])) v[c] = Math.max(0, Math.min(1, values[c]));
    this.examples.push({ x: Array.from(x), mask: mask & 0xff, values: v });
  }

  clear() { this.examples = []; this.model = null; }

  // How many examples per set of pipes: {mask: count}.
  counts() {
    const out = {};
    for (const e of this.examples) out[e.mask] = (out[e.mask] || 0) + 1;
    return out;
  }

  _pick(x) { return this.inputs.map((i) => (x[i] - this.mean[i]) / this.std[i]); }

  // Adam on cross-entropy, in chunks so the page stays responsive.
  //   inputs:   indices of the inputs to use (default: all)
  //   pipes:    learn the pipes (8 outputs)
  //   controls: names from CONTROLS to learn as smooth values
  // Returns {pipes: share of examples exactly right | null, controls: {name: mean error 0..1}}.
  async train({ inputs = null, pipes = true, controls = [], epochs = 150, hidden = 24, lr = 0.01, batch = 32,
                maxExamples = 2000, seed = 1, onProgress = () => {} } = {}) {
    inputs = inputs?.length ? inputs : [...Array(this.nIn).keys()];
    controls = controls.filter((c) => CONTROLS.includes(c));
    if (!pipes && !controls.length) throw new Error("choose something for the gestures to play first");
    if (pipes && Object.keys(this.counts()).length < 2) throw new Error("teach at least two different poses first");
    for (const c of controls) {
      const vals = new Set(this.examples.filter((e) => c in e.values).map((e) => e.values[c].toFixed(3)));
      if (vals.size < 2) throw new Error(`teach at least two poses with different ${c} values first`);
    }
    const r = rng(seed + 7);
    let data = this.examples;
    if (data.length > maxExamples) {           // keep it quick: an even sample
      const step = data.length / maxExamples;
      data = Array.from({ length: maxExamples }, (_, i) => data[Math.floor(i * step)]);
    }
    this.mean = Array.from({ length: this.nIn }, (_, i) => data.reduce((s, e) => s + e.x[i], 0) / data.length);
    this.std = Array.from({ length: this.nIn }, (_, i) => {
      const v = data.reduce((s, e) => s + (e.x[i] - this.mean[i]) ** 2, 0) / data.length;
      return Math.sqrt(v) || 1;
    });
    this.inputs = inputs;
    const n = inputs.length;
    const nOut = PIPES + controls.length;
    const xs = data.map((e) => this._pick(e.x));
    // targets, and which of them count (a value this example wasn't taught doesn't)
    const ts = data.map((e) => [...Array.from({ length: PIPES }, (_, k) => (e.mask >> k) & 1),
                                ...controls.map((c) => e.values[c] ?? 0)]);
    const ws = data.map((e) => [...Array(PIPES).fill(pipes ? 1 : 0), ...controls.map((c) => (c in e.values ? 1 : 0))]);
    const m = new MLP(n, hidden, nOut, seed);
    const params = ["w1", "b1", "w2", "b2"];
    const mom = Object.fromEntries(params.map((p) => [p, new Float64Array(m[p].length)]));
    const vel = Object.fromEntries(params.map((p) => [p, new Float64Array(m[p].length)]));
    let t = 0;
    const order = xs.map((_, i) => i);
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let b = 0; b < order.length; b += batch) {
        const g = Object.fromEntries(params.map((p) => [p, new Float64Array(m[p].length)]));
        const idx = order.slice(b, b + batch);
        for (const i of idx) {
          const x = xs[i];
          const { h, y } = m.forward(x);
          const dy = y.map((v, k) => (v - ts[i][k]) * ws[i][k]);   // sigmoid + cross-entropy
          const dh = new Float64Array(m.nHidden);
          for (let j = 0; j < m.nHidden; j++) {
            let s = 0;
            for (let k = 0; k < nOut; k++) {
              g.w2[j * nOut + k] += h[j] * dy[k];
              s += m.w2[j * nOut + k] * dy[k];
            }
            dh[j] = s * (1 - h[j] * h[j]);
          }
          for (let k = 0; k < nOut; k++) g.b2[k] += dy[k];
          for (let ii = 0; ii < n; ii++) {
            for (let j = 0; j < m.nHidden; j++) g.w1[ii * m.nHidden + j] += x[ii] * dh[j];
          }
          for (let j = 0; j < m.nHidden; j++) g.b1[j] += dh[j];
        }
        t++;
        for (const p of params) {
          const w = m[p], gm = g[p], mo = mom[p], ve = vel[p];
          for (let q = 0; q < w.length; q++) {
            const gq = gm[q] / idx.length;
            mo[q] = 0.9 * mo[q] + 0.1 * gq;
            ve[q] = 0.999 * ve[q] + 0.001 * gq * gq;
            w[q] -= (lr * (mo[q] / (1 - 0.9 ** t))) / (Math.sqrt(ve[q] / (1 - 0.999 ** t)) + 1e-8);
          }
        }
      }
      if (ep % 10 === 9) {
        onProgress((ep + 1) / epochs);
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    this.model = m;
    this.pipes = pipes;
    this.controls = controls;
    const result = { pipes: null, controls: {} };
    if (pipes) {
      let right = 0;
      for (const e of data) if (this.maskFor(this.predict(e.x).pipes) === e.mask) right++;
      result.pipes = right / data.length;
    }
    for (const c of controls) {
      const taught = data.filter((e) => c in e.values);
      result.controls[c] = taught.reduce((s, e) => s + Math.abs(this.predict(e.x).controls[c] - e.values[c]), 0) / taught.length;
    }
    return result;
  }

  // {pipes: probability per pipe (null if not learnt), controls: {name: 0..1}}, or null before training.
  predict(x) {
    if (!this.model) return null;
    const y = this.model.forward(this._pick(x)).y;
    const controls = {};
    this.controls.forEach((c, i) => { controls[c] = y[PIPES + i]; });
    return { pipes: this.pipes ? Array.from(y.slice(0, PIPES)) : null, controls };
  }

  maskFor(probs, threshold = 0.5) {
    let m = 0;
    (probs || []).forEach((p, k) => { if (p >= threshold) m |= 1 << k; });
    return m;
  }

  toJSON() {
    return { nIn: this.nIn, examples: this.examples, mean: this.mean, std: this.std, inputs: this.inputs,
             pipes: this.pipes, controls: this.controls, model: this.model ? this.model.toJSON() : null };
  }

  static fromJSON(o) {
    const l = new Learner(o.nIn);
    l.examples = Array.isArray(o.examples)
      ? o.examples.filter((e) => e.x?.length === o.nIn).map((e) => ({ ...e, values: e.values || {} })) : [];
    if (o.model && o.mean && o.std && Array.isArray(o.inputs)) {
      l.model = MLP.fromJSON(o.model);
      if (l.model.nIn !== o.inputs.length) throw new Error("model doesn't fit");
      Object.assign(l, { mean: o.mean, std: o.std, inputs: o.inputs, pipes: o.pipes !== false,
                         controls: (o.controls || []).filter((c) => CONTROLS.includes(c)) });
    }
    return l;
  }
}

// Pipes open above `on` and close below `off`: no flicker at the edge
// between two poses.
export class Hysteresis {
  constructor(on = 0.6, off = 0.4) {
    Object.assign(this, { on, off, mask: 0 });
  }
  update(probs) {
    let m = this.mask;
    probs.forEach((p, k) => {
      if (p >= this.on) m |= 1 << k;
      else if (p <= this.off) m &= ~(1 << k);
    });
    this.mask = m & 0xff;
    return this.mask;
  }
  reset() { this.mask = 0; }
}
