// Serial link to the ESP32 sender, in the browser.
// JavaScript twin of app/serial_link.py: requests (PAT / PLAY / STOP) go out
// one at a time and each waits for its own OK; sender lines become events:
//   log {line, level}   status {connected, port, playing}   peer {peer, ok, seq}
//   step {step}         transport {playing}                  ready
//   pipe {peer, mac, fw}  (the hub found a pipe board)      dup {peer, mac}
//
// The byte transport is pluggable: WebSerialTransport (a real USB port, via
// the Web Serial API) or DemoTransport (demo.js, a simulated organ).

import * as protocol from "./protocol.js";

export class LinkTimeout extends Error {}
export class SenderError extends Error {}      // sender answered ERR
export class LinkClosed extends Error {}

const BAUD = 115200;

export class SerialLink {
  constructor(onEvent, { ackTimeoutMs = 1000, retries = 3 } = {}) {
    this.onEvent = onEvent || (() => {});
    this.ackTimeoutMs = ackTimeoutMs;
    this.retries = retries;
    this.transport = null;
    this.label = null;
    this.playing = false;
    this._buf = "";
    this._waiter = null;
    this._chain = Promise.resolve();
  }

  get isOpen() { return this.transport !== null; }

  _emit(type, payload = {}) {
    try { this.onEvent({ type, ...payload }); } catch (e) { console.error(e); }
  }

  // ------------------------------------------------------------ lifecycle
  async open(transport, label) {
    if (this.transport) throw new Error("link already open");
    this._buf = "";
    this.transport = transport;    // set first: data may arrive during open()
    this.label = label;
    try {
      await transport.open((chunk) => this._onData(chunk), (err) => this._onLost(err));
    } catch (e) {
      this.transport = null;
      throw e;
    }
    this._emit("log", { line: `opened ${label} @ ${BAUD}`, level: "info" });
    this._emit("status", { connected: true, port: label, playing: false });
  }

  async close() {
    const t = this.transport;
    if (!t) return;
    this.transport = null;
    this._failWaiter(new LinkClosed("link closed"));
    try { await t.close(); } catch (_) { /* already gone */ }
    this._setPlaying(false);
    this._emit("log", { line: "closed", level: "info" });
    this._emit("status", { connected: false, port: null, playing: false });
  }

  _onLost(err) {
    if (!this.transport) return;    // we closed it ourselves
    this.transport = null;
    this._failWaiter(new LinkClosed(String(err && err.message || err)));
    this._emit("log", { line: `serial lost: ${err && err.message || err}`, level: "err" });
    this._setPlaying(false);
    this._emit("status", { connected: false, port: null, playing: false });
  }

  // ------------------------------------------------------------ reading
  _onData(chunk) {
    if (!this.transport) return;
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl).replace(/\r$/, "");
      this._buf = this._buf.slice(nl + 1);
      this._onLine(line);
    }
    if (this._buf.length > 4096) this._buf = "";   // garbage without newlines
  }

  _onLine(line) {
    const ack = protocol.decodeReply(line);
    if (ack.kind === "") return;
    if (ack.kind === "STEP") {
      // Once per step: drives the playhead, too noisy to log.
      const step = parseInt(ack.detail, 10);
      if (Number.isNaN(step)) return;
      if (!this.playing) this._setPlaying(true);   // STEP proves it's running
      this._emit("step", { step });
      return;
    }
    if (ack.kind === "ERR" && this._waiter?.expect === "PIPES") {
      // A 1.1 hub doesn't know PIPES: not an error worth flagging.
      this._emit("log", { line: "hub firmware 1.1: it can't list its pipes (update it in Boards)", level: "info" });
      this._offerReply(ack);
      return;
    }
    this._emit("log", { line: `<< ${line}`, level: classify(ack) });
    if (ack.kind === "ACK" || ack.kind === "NAK") {
      const [peer, seq] = ack.detail.split(/\s+/).map((t) => parseInt(t, 10));
      if (!Number.isNaN(peer)) this._emit("peer", { peer, ok: ack.kind === "ACK", seq: seq || 0 });
    } else if (ack.kind === "PIPE" || ack.kind === "DUP") {
      const [peer, mac, fw] = ack.detail.split(/\s+/);
      const i = parseInt(peer, 10);
      if (i >= 0 && i < 8 && mac) this._emit(ack.kind === "PIPE" ? "pipe" : "dup", { peer: i, mac, fw: fw || null });
    } else if (ack.kind === "OK" && (ack.detail === "PLAY" || ack.detail === "STOP")) {
      this._setPlaying(ack.detail === "PLAY");
    } else if (ack.kind === "OK" && ack.detail === "READY") {
      // Sender (re)booted, e.g. reset by opening the port: no pattern, stopped.
      this._setPlaying(false);
      this._emit("ready");
    }
    this._offerReply(ack);
  }

  _setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    this._emit("transport", { playing });
  }

  // ------------------------------------------------------------ requests
  _offerReply(ack) {
    const w = this._waiter;
    if (!w) return;
    if (ack.kind === "OK" && ack.detail.startsWith(w.expect)) w.resolve(ack);
    else if (ack.kind === "ERR") w.reject(new SenderError(`hub: ${ack.detail}`));
  }

  _failWaiter(err) {
    if (this._waiter) this._waiter.reject(err);
  }

  _waitFor(expect) {
    return new Promise((resolve, reject) => {
      const done = (fn) => (v) => {
        clearTimeout(timer);
        if (this._waiter === w) this._waiter = null;
        fn(v);
      };
      const w = { expect, resolve: done(resolve), reject: done(reject) };
      const timer = setTimeout(() => w.reject(new LinkTimeout("timeout")), this.ackTimeoutMs);
      this._waiter = w;
    });
  }

  // Serialised: each request runs after the previous one settles.
  request(frame, expect) {
    const run = () => this._request(frame, expect);
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async _request(frame, expect) {
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      if (!this.transport) throw new LinkClosed("link not open");
      const reply = this._waitFor(expect);   // listen before writing
      try {
        this._emit("log", { line: `>> ${frame.trimEnd()}`, level: "send" });
        await this.transport.write(frame);
      } catch (e) {
        this._failWaiter(e);
        reply.catch(() => {});
        throw e;
      }
      try {
        return await reply;
      } catch (e) {
        if (!(e instanceof LinkTimeout)) throw e;
        this._emit("log", { line: `timeout (attempt ${attempt}/${this.retries})`, level: "warn" });
      }
    }
    throw new LinkTimeout(`${expect} failed: no reply from the hub`);
  }

  async sendPattern(tempo, grid) {
    const ack = await this.request(protocol.encodePattern(tempo, grid), "PAT");
    const seq = parseInt(ack.detail.split(/\s+/)[1], 10);
    return Number.isNaN(seq) ? null : seq;
  }
  sendPlay() { return this.request(protocol.encodePlay(), "PLAY"); }
  sendStop() { return this.request(protocol.encodeStop(), "STOP"); }
  // Hub 1.2+: list the pipes it knows (PIPE lines, then OK PIPES). A 1.1
  // hub answers ERR unknown.
  listPipes() { return this.request("PIPES\n", "PIPES"); }
}

function classify(ack) {
  if (ack.kind === "OK" || ack.kind === "ACK" || ack.kind === "PONG") return "ok";
  if (ack.kind === "NAK") return "warn";
  if (ack.kind === "ERR") return "err";
  return "info";
}

// ---------------------------------------------------------------------------
// Web Serial transport (Chrome / Edge)
// ---------------------------------------------------------------------------
const WRITE_TIMEOUT_MS = 2000;

export class WebSerialTransport {
  constructor(port) {
    this.port = port;
    this._closing = false;
  }

  async open(onData, onLost) {
    await this.port.open({ baudRate: BAUD });
    this._writer = this.port.writable.getWriter();
    this._encoder = new TextEncoder();
    this._loop = this._readLoop(onData, onLost);
  }

  async _readLoop(onData, onLost) {
    const decoder = new TextDecoder();
    while (this.port.readable && !this._closing) {
      this._reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (value) onData(decoder.decode(value, { stream: true }));
        }
      } catch (_) {
        // Non-fatal errors (framing, overrun) leave port.readable usable and
        // the loop continues; a lost device sets it to null and we exit.
      } finally {
        this._reader.releaseLock();
      }
    }
    if (!this._closing) onLost(new Error("USB device disconnected"));
  }

  async write(text) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LinkTimeout("serial write timed out")), WRITE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this._writer.write(this._encoder.encode(text)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    this._closing = true;
    try { await this._reader?.cancel(); } catch (_) {}
    try { await this._loop; } catch (_) {}
    try { this._writer?.releaseLock(); } catch (_) {}
    await this.port.close();
  }
}

// Friendly names for the USB-serial chips found on ESP32 boards.
const USB_CHIPS = {
  0x10c4: "CP210x",
  0x1a86: "CH340",
  0x303a: "ESP32 native USB",
  0x0403: "FTDI",
};

export function describePort(port) {
  const info = port.getInfo ? port.getInfo() : {};
  const chip = USB_CHIPS[info.usbVendorId];
  if (chip) return { label: `ESP32 board (${chip})`, likely: true };
  if (info.usbVendorId !== undefined) {
    return { label: `USB serial ${hex(info.usbVendorId)}:${hex(info.usbProductId)}`, likely: false };
  }
  return { label: "Serial port", likely: false };
}

const hex = (n) => (n === undefined ? "?" : n.toString(16).padStart(4, "0"));
