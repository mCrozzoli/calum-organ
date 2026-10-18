// A simulated ESP32 sender, so the app can be tried without hardware.
// JavaScript twin of sim/fake_esp.py: answers PAT with OK + ACK/NAK per
// row, keeps time after PLAY and reports STEP <n>, and announces itself
// with OK READY like a real board does when the port opens.

import * as protocol from "./protocol.js";

export class FakeSender {
  // write(text): deliver sender output to the host.
  // offline: pipe letters to treat as unreachable, e.g. new Set(["C"]).
  constructor(write, { offline = new Set() } = {}) {
    this._write = write;
    this._offline = offline;
    this._buf = "";
    this.seq = 0;
    this.tempo = 120;
    this._curSteps = 0;
    this._nextSteps = 0;
    this._step = 0;
    this._timer = null;
    this.patterns = [];      // every pattern received (for tests)
  }

  get playing() { return this._timer !== null; }

  feed(text) {
    this._buf += text;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._handle(line);
    }
  }

  _handle(line) {
    if (line.startsWith("PAT")) {
      let pat;
      try {
        pat = protocol.decodePattern(line);
      } catch (e) {
        this._write(`ERR ${e.message}\n`);
        return;
      }
      this.seq = (this.seq + 1) & 0xffff;
      this.tempo = pat.tempo;
      this._nextSteps = pat.cols;
      if (!this.playing) this._curSteps = pat.cols;
      this.patterns.push(pat);
      this._write(`OK PAT ${this.seq}\n`);
      for (let peer = 0; peer < pat.rows; peer++) {
        const kind = this._offline.has(String.fromCharCode(65 + peer)) ? "NAK" : "ACK";
        this._write(`${kind} ${peer} ${this.seq}\n`);
      }
    } else if (line === "PLAY") {
      if (this._nextSteps === 0) { this._write("ERR no pattern\n"); return; }
      this.stopClock();
      this._step = 0;
      this._curSteps = this._nextSteps;
      this._write("OK PLAY\n");
      this._nextTick = now();
      this._tick();
    } else if (line === "STOP") {
      this.stopClock();
      this._write("OK STOP\n");
    } else if (line === "PING") {
      this._write("PONG\n");
    } else {
      this._write(`ERR unknown: ${line}\n`);
    }
  }

  _tick() {
    if (this._step === 0) this._curSteps = this._nextSteps;
    const step = this._step;
    this._step = step + 1 >= this._curSteps ? 0 : step + 1;
    this._write(`STEP ${step}\n`);
    this._nextTick += 60000 / this.tempo;
    this._timer = setTimeout(() => this._tick(), Math.max(0, this._nextTick - now()));
  }

  stopClock() {
    clearTimeout(this._timer);
    this._timer = null;
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Transport for SerialLink that talks to a FakeSender instead of USB.
export class DemoTransport {
  constructor(options = {}) {
    this.options = options;
    this.sender = null;
  }

  async open(onData) {
    // A few ms of latency, like a real USB round trip.
    // Output still in flight after close() is dropped.
    const s = new FakeSender((text) => setTimeout(() => { if (this.sender === s) onData(text); }, 2),
                             this.options);
    this.sender = s;
    setTimeout(() => { if (this.sender === s) onData("OK READY\n"); }, 30);
  }

  async write(text) {
    if (!this.sender) throw new Error("demo closed");
    this.sender.feed(text);
  }

  async close() {
    this.sender?.stopClock();
    this.sender = null;
  }
}
