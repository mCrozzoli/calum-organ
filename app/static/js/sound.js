// Simulated pipe sound: SuperCollider's scsynth running in the browser
// (SuperSonic 0.71.0, vendor/), playing the SynthDefs compiled from
// sound/organ_synthdefs.scd. Same setup as the Dark Sonification web designs:
// postMessage transport, so it works on GitHub Pages without special headers.
//
// One persistent organPipe synth per pipe; its `gate` is the valve, so
// consecutive open steps sustain without re-attacking, as a real pipe would.
//
//   organPipe x 8 (head group) -> bus 16-17 dry, 18-19 reverb
//   organMaster (tail group)   -> reverb, volume, limiter -> out 0-1

import { PIPES, ROOMS, midiToFreq, placement } from "./stage.js";

const DRY_BUS = 16;      // no bus allocator in the browser; 16+ is private
const REV_BUS = 18;
const AUDITION_MS = 450;
// Reverb per room size: FreeVerb room size, and how much each pipe sends.
const ROOM_REVERB = { small: [0.35, 0.15], medium: [0.6, 0.25], large: [0.85, 0.4] };

export class OrganSound {
  constructor({ onLog = () => {}, onState = () => {} } = {}) {
    this.onLog = onLog;
    this.onState = onState;
    this.sonic = null;
    this.state = "off";            // off | starting | on | error
    this.pipeIds = [];
    this.wanted = new Array(PIPES).fill(false);    // what the sequencer asks for
    this.auditioning = new Array(PIPES).fill(0);   // timer ids
    this.sent = new Array(PIPES).fill(false);      // last gate sent
    this.meter = null;
    this.latencyMs = 0;
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
      }
      if (!this.sonic) await this._boot();
      this.applyStage(stage);
      this.latencyMs = Math.round((this.sonic.audioContext?.outputLatency || 0) * 1000);
      this._setState("on");
    } catch (e) {
      this._setState("error", { message: e.message || String(e) });
      throw e;
    }
  }

  async _boot() {
    const root = new URL("../", import.meta.url).href;     // app/static/
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

    await sonic.init();
    for (const def of ["organPipe", "organMaster"]) {
      await sonic.loadSynthDef(`${root}synthdefs/${def}.scsyndef`);
    }
    await sonic.sync();

    const voices = sonic.nextNodeId();
    const fx = sonic.nextNodeId();
    sonic.send("/g_new", voices, 0, 0);        // head: pipes
    sonic.send("/g_new", fx, 1, 0);            // tail: master runs last
    this.masterId = sonic.nextNodeId();
    sonic.send("/s_new", "organMaster", this.masterId, 0, fx,
               "in", DRY_BUS, "revIn", REV_BUS, "out", 0);
    this.pipeIds = [];
    for (let i = 0; i < PIPES; i++) {
      const id = sonic.nextNodeId();
      this.pipeIds.push(id);
      sonic.send("/s_new", "organPipe", id, 1, voices,
                 "out", DRY_BUS, "revOut", REV_BUS, "gate", 0);
    }
    await sonic.sync();
    this.sonic = sonic;
    this.sent.fill(false);
    this._setupMeter();
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
    const list = only === undefined ? [...Array(PIPES).keys()] : [only];
    for (const i of list) {
      const open = this.wanted[i] || this.auditioning[i] !== 0;
      if (open !== this.sent[i]) this._send(i, open);
    }
  }

  _send(i, open) {
    this.sent[i] = open;
    if (this.sonic && this.state !== "error") this.sonic.send("/n_set", this.pipeIds[i], "gate", open ? 1 : 0);
  }

  // Position, pitch, output mode, room and volume, all at once.
  applyStage(stage) {
    if (!this.sonic) return;
    for (let i = 0; i < PIPES; i++) this.setPipe(i, stage);
    const [roomSize, send] = ROOM_REVERB[stage.room] || ROOM_REVERB.medium;
    for (const id of this.pipeIds) {
      this.sonic.send("/n_set", id, "binaural", stage.output === "speakers" ? 0 : 1, "reverb", send);
    }
    this.sonic.send("/n_set", this.masterId, "amp", stage.volume, "room", roomSize);
  }

  setPipe(i, stage) {
    if (!this.sonic) return;
    const pipe = stage.pipes[i];
    const { azimuth, distance } = placement(pipe, stage.listener, ROOMS[stage.room] || ROOMS.medium);
    this.sonic.send("/n_set", this.pipeIds[i], "freq", midiToFreq(pipe.note),
                    "azimuth", azimuth, "distance", distance);
  }

  setVolume(v) {
    if (this.sonic) this.sonic.send("/n_set", this.masterId, "amp", v);
  }
}
