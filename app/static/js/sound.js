// Simulated pipe sound: SuperCollider's scsynth running in the browser
// (SuperSonic 0.71.0, vendor/), playing the SynthDefs compiled from
// sound/organ_synthdefs.scd. Same setup as the Dark Sonification web designs:
// postMessage transport, so it works on GitHub Pages without special headers.
//
// Three sources (corpus.js): the recorded organ (organSample playing
// corpus/*.ogg), or the synth (organPipe) as a stopped pipe modelled on that
// recording or as an open pipe. One persistent synth per pipe; its `gate` is
// the valve, so consecutive open steps sustain without re-attacking, as a
// real pipe would.
//
//   8 pipe synths (head group) -> bus 16-17 dry, 18-19 reverb
//   organMaster (tail group)   -> reverb, volume, limiter -> out 0-1

import { PIPES, ROOMS, midiToFreq, placement } from "./stage.js";
import { DEFAULT_SOURCE, samplePlan, synthPlan } from "./corpus.js";

const DRY_BUS = 16;      // no bus allocator in the browser; 16+ is private
const REV_BUS = 18;
const AUDITION_MS = 450;
// Reverb per room size: FreeVerb room size, and how much each pipe sends.
const ROOM_REVERB = { small: [0.35, 0.15], medium: [0.6, 0.25], large: [0.85, 0.4] };
// Per source: SynthDef, level (matched offline: within 0.5 dB of each
// other), and reverb share (the recordings already carry their chapel).
const KINDS = {
  recorded: { def: "organSample", amp: 0.5, reverb: 0.5 },
  stopped: { def: "organPipe", amp: 0.2, reverb: 1 },
  open: { def: "organPipe", amp: 0.2, reverb: 1 },
};

export class OrganSound {
  constructor({ onLog = () => {}, onState = () => {} } = {}) {
    this.onLog = onLog;
    this.onState = onState;
    this.sonic = null;
    this.state = "off";            // off | starting | on | error
    this.source = null;            // the source the pipe synths are playing
    this.corpus = null;
    this.buffersLoaded = false;
    this.pipeIds = [];
    this.wanted = new Array(PIPES).fill(false);    // what the sequencer asks for
    this.auditioning = new Array(PIPES).fill(0);   // timer ids
    this.sent = new Array(PIPES).fill(false);      // last gate sent
    this.meter = null;
    this.latencyMs = 0;
    this.root = new URL("../", import.meta.url).href;     // app/static/
  }

  get active() { return this.state === "on"; }

  _setState(s, detail) {
    this.state = s;
    this.onState(s, detail);
  }

  // Must be called from a click (browsers only start audio after a gesture).
  async start(stage) {
    if (this.state === "on" || this.state === "starting") return;
    this._setState("starting");
    try {
      if (this.sonic && !(await this.sonic.resume())) {
        // The audio thread was reclaimed (e.g. long in the background): rebuild.
        await this.sonic.destroy().catch(() => {});
        this.sonic = null;
        this.source = null;
        this.buffersLoaded = false;
      }
      if (!this.sonic) await this._boot();
      await this._useSource(stage.source || DEFAULT_SOURCE);
      this.applyStage(stage);
      this.latencyMs = Math.round((this.sonic.audioContext?.outputLatency || 0) * 1000);
      this._setState("on");
      this._sync();
    } catch (e) {
      this._setState("error", { message: e.message || String(e) });
      throw e;
    }
  }

  async _boot() {
    const root = this.root;
    const { SuperSonic } = await import(`${root}vendor/supersonic/supersonic.js`);
    const sonic = new SuperSonic({
      baseURL: `${root}vendor/supersonic/`,
      coreBaseURL: `${root}vendor/supersonic-core/`,
    });
    // scsynth's own messages: only problems go to the app log.
    sonic.on("debug", (m) => {
      if (/error|fail|not found|exception|not installed/i.test(m.text)) this.onLog(`scsynth: ${m.text.trim()}`, "err");
    });
    sonic.on("in", (msg) => { if (msg[0] === "/fail") this.onLog(`scsynth: ${msg.slice(1).join(" ")}`, "err"); });
    sonic.on("error", (e) => this.onLog(`sound engine: ${e.message || e}`, "err"));

    const corpus = fetch(`${root}corpus/corpus.json`).then((r) => {
      if (!r.ok) throw new Error(`corpus.json: HTTP ${r.status}`);
      return r.json();
    });
    await sonic.init();
    for (const def of ["organPipe", "organSample", "organMaster"]) {
      await sonic.loadSynthDef(`${root}synthdefs/${def}.scsyndef`);
    }
    await sonic.sync();
    this.corpus = await corpus;

    this.voices = sonic.nextNodeId();
    const fx = sonic.nextNodeId();
    sonic.send("/g_new", this.voices, 0, 0);   // head: pipes
    sonic.send("/g_new", fx, 1, 0);            // tail: master runs last
    this.masterId = sonic.nextNodeId();
    sonic.send("/s_new", "organMaster", this.masterId, 0, fx,
               "in", DRY_BUS, "revIn", REV_BUS, "out", 0);
    await sonic.sync();
    this.sonic = sonic;
    this._setupMeter();
  }

  // Make the pipe synths play `source`, loading the recordings the first time.
  async _useSource(source) {
    if (!KINDS[source]) source = DEFAULT_SOURCE;
    if (source === "recorded" && !this.buffersLoaded) {
      // One at a time: loading all 17 in parallel races SuperSonic's buffer
      // pool growth and runs out of memory (seen in Chrome, 0.71.0).
      for (const [i, s] of this.corpus.samples.entries()) {
        await this.sonic.loadSample(i, `${this.root}corpus/${s.file}`);
      }
      await this.sonic.sync();
      this.buffersLoaded = true;
    }
    const def = KINDS[source].def;
    if (this.source && KINDS[this.source].def === def) {
      this.source = source;          // same synth, different settings
      return;
    }
    // Swap synths: let the old valves close (release), then free them.
    const old = this.pipeIds;
    for (const id of old) this.sonic.send("/n_set", id, "gate", 0);
    if (old.length) setTimeout(() => this.sonic.send("/n_free", ...old), 250);
    this.pipeIds = [];
    for (let i = 0; i < PIPES; i++) {
      const id = this.sonic.nextNodeId();
      this.pipeIds.push(id);
      this.sonic.send("/s_new", def, id, 1, this.voices,
                      "out", DRY_BUS, "revOut", REV_BUS, "gate", 0);
    }
    this.sent.fill(false);
    this.source = source;
  }

  // Switch source while sound is on (re-opens the pipes the sequencer holds).
  async setSource(source, stage) {
    if (!this.sonic || this.state !== "on") return;
    await this._useSource(source);
    this.applyStage(stage);
    this._sync();
  }

  // Left/right level meter: shows the stereo placement (and lets tests
  // check that sound really comes out where the stage says).
  _setupMeter() {
    const ctx = this.sonic.audioContext;
    if (!ctx || !this.sonic.node) return;
    const split = ctx.createChannelSplitter(2);
    const make = () => Object.assign(ctx.createAnalyser(), { fftSize: 1024 });
    const left = make();
    const right = make();
    this.sonic.node.connect(split);       // in addition to the speakers
    split.connect(left, 0);
    split.connect(right, 1);
    this.meter = { left, right, buf: new Float32Array(1024) };
  }

  // -> [leftDb, rightDb], or null when there is no sound engine.
  levels() {
    if (!this.meter || this.state !== "on") return null;
    const { left, right, buf } = this.meter;
    const db = (an) => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    };
    return [db(left), db(right)];
  }

  async stop() {
    if (this.state !== "on") return;
    this.wanted.fill(false);
    this.auditioning.forEach((t, i) => { clearTimeout(t); this.auditioning[i] = 0; });
    this._sync();
    this._setState("off");
    // Let the valves' release ring out, then stop the audio thread.
    await new Promise((r) => setTimeout(r, 200));
    if (this.state === "off") await this.sonic.suspend();
  }

  // ------------------------------------------------------------ control
  // The sequencer: open or close pipe i's valve.
  setGate(i, open) {
    this.wanted[i] = !!open;
    this._sync(i);
  }

  closeAll() {
    this.wanted.fill(false);
    this._sync();
  }

  // Click a pipe on the stage to hear it.
  audition(i) {
    if (this.state !== "on") return;
    clearTimeout(this.auditioning[i]);
    // Re-open from closed so the attack (and chiff) is heard.
    if (this.sent[i]) this._send(i, false);
    this.auditioning[i] = setTimeout(() => { this.auditioning[i] = 0; this._sync(i); }, AUDITION_MS);
    this._sync(i);
  }

  _sync(only) {
    if (this.state !== "on") return;
    const list = only === undefined ? [...Array(PIPES).keys()] : [only];
    for (const i of list) {
      const open = this.wanted[i] || this.auditioning[i] !== 0;
      if (open !== this.sent[i]) this._send(i, open);
    }
  }

  _send(i, open) {
    this.sent[i] = open;
    if (this.sonic) this.sonic.send("/n_set", this.pipeIds[i], "gate", open ? 1 : 0);
  }

  // Position, pitch, output mode, room and volume, all at once.
  applyStage(stage) {
    if (!this.sonic || !this.source) return;
    const kind = KINDS[this.source];
    const [roomSize, send] = ROOM_REVERB[stage.room] || ROOM_REVERB.medium;
    for (let i = 0; i < PIPES; i++) {
      this.setPipe(i, stage);
      this.sonic.send("/n_set", this.pipeIds[i], "binaural", stage.output === "speakers" ? 0 : 1,
                      "reverb", send * kind.reverb, "amp", kind.amp);
    }
    this.sonic.send("/n_set", this.masterId, "amp", stage.volume, "room", roomSize);
  }

  setPipe(i, stage) {
    if (!this.sonic || !this.source) return;
    const pipe = stage.pipes[i];
    const id = this.pipeIds[i];
    const { azimuth, distance } = placement(pipe, stage.listener, ROOMS[stage.room] || ROOMS.medium);
    this.sonic.send("/n_set", id, "azimuth", azimuth, "distance", distance);
    if (this.source === "recorded") {
      const p = samplePlan(this.corpus, pipe.note);
      this.sonic.send("/n_set", id, "buf", p.buf, "rate", p.rate,
                      "loopStart", p.loopStart, "loopEnd", p.loopEnd);
    } else {
      const p = synthPlan(this.source, this.corpus, pipe.note);
      this.sonic.send("/n_set", id, "freq", midiToFreq(pipe.note), "attack", p.attack);
      this.sonic.send("/n_setn", id, "harm", p.harm.length, ...p.harm);
    }
  }

  setVolume(v) {
    if (this.sonic) this.sonic.send("/n_set", this.masterId, "amp", v);
  }
}
