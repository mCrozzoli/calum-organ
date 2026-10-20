// Tests for the browser-side modules (run: node --test tests/js).
// The demo organ stands in for the ESP32 sender, like sim/fake_esp.py does
// for the Python tests.
import { test } from "node:test";
import assert from "node:assert/strict";

// A minimal localStorage, installed before the backends module loads.
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
});

const protocol = await import("../../app/static/js/protocol.js");
const { SerialLink, LinkTimeout, SenderError } = await import("../../app/static/js/link.js");
const { DemoTransport } = await import("../../app/static/js/demo.js");
const { OnlineBackend } = await import("../../app/static/js/backends.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(5);
  }
  return false;
}
const ofType = (events, type) => events.filter((e) => e.type === type);

async function openDemo(options) {
  const events = [];
  const link = new SerialLink((e) => events.push(e), { ackTimeoutMs: 500, retries: 2 });
  await link.open(new DemoTransport(options), "demo");
  await waitFor(() => ofType(events, "ready").length);   // board "boots" on open
  return { link, events };
}

// ------------------------------------------------------------------ protocol
test("protocol: encode and decode round trip", () => {
  const grid = [[1, 0, 1, 0], [0, 1, 0, 1]];
  const line = protocol.encodePattern(120, grid);
  assert.equal(line, "PAT 120 2 4 1010 0101\n");
  assert.deepEqual(protocol.decodePattern(line).grid, grid);
});

test("protocol: same limits as the Python side", () => {
  assert.throws(() => protocol.encodePattern(19, [[1]]), protocol.ProtocolError);
  assert.throws(() => protocol.encodePattern(120, Array(9).fill([1])), protocol.ProtocolError);
  assert.throws(() => protocol.encodePattern(120, [new Array(33).fill(0)]), protocol.ProtocolError);
  assert.throws(() => protocol.encodePattern(120, [[1, 0], [1]]), protocol.ProtocolError);
  assert.throws(() => protocol.encodePattern(120, [[8]]), protocol.ProtocolError);
  assert.equal(protocol.encodePattern(120, [[2, 0, 7]]), "PAT 120 1 3 101\n", "the 1.3 frame: figures are just on");
  assert.deepEqual(protocol.decodeReply("STEP 7\r"), { kind: "STEP", detail: "7" });
  assert.deepEqual(protocol.decodeReply("hello"), { kind: "LOG", detail: "hello" });
});

// ------------------------------------------------------------------ link
test("link: pattern gets OK, then one ACK/NAK per row", async () => {
  const { link, events } = await openDemo({ offline: new Set(["C"]) });
  const seq = await link.sendPattern(120, [[1, 0], [0, 1], [1, 1]]);
  assert.equal(seq, 1);
  assert.ok(await waitFor(() => ofType(events, "peer").length === 3));
  const ok = Object.fromEntries(ofType(events, "peer").map((e) => [e.peer, e.ok]));
  assert.deepEqual(ok, { 0: true, 1: true, 2: false });
  await link.close();
});

test("link: play streams steps, stop ends them, steps are not logged", async () => {
  const { link, events } = await openDemo();
  await link.sendPattern(300, [[1, 0, 1, 0]]);       // 200 ms per step
  await link.sendPlay();
  assert.equal(link.playing, true);
  assert.ok(await waitFor(() => ofType(events, "step").length >= 5, 3000));
  // a 1.4 hub counts on (each pipe wraps its own row)
  assert.deepEqual(ofType(events, "step").slice(0, 5).map((e) => e.step), [0, 1, 2, 3, 4]);
  await link.sendStop();
  assert.equal(link.playing, false);
  const n = ofType(events, "step").length;
  await sleep(450);
  assert.equal(ofType(events, "step").length, n);
  assert.ok(!ofType(events, "log").some((e) => e.line.includes("STEP")));
  await link.close();
});

test("link: play without a pattern is refused by the sender", async () => {
  const { link } = await openDemo();
  await assert.rejects(link.sendPlay(), SenderError);
  await link.close();
});

test("link: overlapping requests each get their own OK", async () => {
  const { link } = await openDemo();
  const seqs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => link.sendPattern(120, [[i % 2, 1]])));
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  await link.close();
});

test("link: a silent device times out after the retries", async () => {
  const events = [];
  const link = new SerialLink((e) => events.push(e), { ackTimeoutMs: 50, retries: 2 });
  await link.open({ open: async () => {}, write: async () => {}, close: async () => {} }, "silent");
  await assert.rejects(link.sendPattern(120, [[1]]), LinkTimeout);
  assert.equal(ofType(events, "log").filter((e) => e.level === "warn").length, 2);
  await link.close();
});

test("link: a lost device fails the pending request and reports disconnected", async () => {
  const events = [];
  let lose;
  const link = new SerialLink((e) => events.push(e), { ackTimeoutMs: 1000, retries: 1 });
  await link.open({
    open: async (_onData, onLost) => { lose = onLost; },
    write: async () => {},
    close: async () => {},
  }, "flaky");
  const pending = link.sendPattern(120, [[1]]);
  await sleep(10);
  lose(new Error("unplugged"));
  await assert.rejects(pending);
  assert.equal(link.isOpen, false);
  assert.equal(ofType(events, "status").at(-1).connected, false);
});

test("link: nothing arrives after close", async () => {
  const { link, events } = await openDemo();
  await link.sendPattern(300, [[1]]);
  await link.sendPlay();
  await link.close();
  const n = events.length;
  await sleep(450);
  assert.equal(events.length, n);
});

// ------------------------------------------------------------------ online backend
test("online backend: demo connection is labelled as demo", async () => {
  const events = [];
  const b = new OnlineBackend((e) => events.push(e));
  const ports = await b.listPorts();
  assert.ok(ports.some((p) => p.id === "__demo__"));
  await b.connect("__demo__");
  assert.deepEqual(ofType(events, "status").at(-1),
                   { type: "status", connected: true, port: "demo organ", playing: false, demo: true });
  await b.disconnect();
});

test("online backend: presets are kept in browser storage", async () => {
  store.clear();
  const b = new OnlineBackend(() => {});
  await b.presets.save("waltz", { tempo: 90, grid: [[1, 0, 0]] });
  await b.presets.save("alpha", { tempo: 120, grid: [[1]] });
  assert.deepEqual(await b.presets.list(), ["alpha", "waltz"]);
  assert.deepEqual(await b.presets.load("waltz"), { name: "waltz", tempo: 90, grid: [[1, 0, 0]] });
  await b.presets.remove("alpha");
  assert.deepEqual(await b.presets.list(), ["waltz"]);
  await assert.rejects(b.presets.load("alpha"), /not found/);
  await assert.rejects(b.presets.save("bad", { tempo: 5, grid: [[1]] }), protocol.ProtocolError);
});

// ------------------------------------------------------------------ pipes the hub hears (1.2)
test("link: the hub's PIPE and DUP lines become events", async () => {
  const { link, events } = await openDemo({ offline: new Set(["C"]) });
  // the demo hub announces its pipes shortly after booting, like a real one
  assert.ok(await waitFor(() => ofType(events, "pipe").length === 7));
  assert.deepEqual(ofType(events, "pipe")[0], { type: "pipe", peer: 0, mac: "DE:E0:00:00:00:00", fw: "1.2" });
  assert.ok(!ofType(events, "pipe").some((e) => e.peer === 2), "offline pipe C stays silent");
  await link.listPipes();
  assert.equal(ofType(events, "pipe").length, 14);
  link._onLine("DUP 3 AA:BB:CC:DD:EE:FF");
  assert.deepEqual(ofType(events, "dup")[0], { type: "dup", peer: 3, mac: "AA:BB:CC:DD:EE:FF", fw: null });
  link._onLine("PIPE 9 AA:BB:CC:DD:EE:FF 1.2");     // out of range: ignored
  assert.equal(ofType(events, "pipe").length, 14);
  await link.close();
});

test("link: a 1.1 hub's answer to PIPES isn't flagged as an error", async () => {
  const events = [];
  const link = new SerialLink((e) => events.push(e), { ackTimeoutMs: 300, retries: 1 });
  const transport = { onData: null, async open(onData) { this.onData = onData; },
    async write(t) { if (t === "PIPES\n") setTimeout(() => this.onData("ERR unknown\n"), 5); },
    async close() {} };
  await link.open(transport, "old hub");
  await assert.rejects(link.listPipes(), SenderError);
  assert.ok(!events.some((e) => e.type === "log" && e.level === "err"));
  await link.close();
});

test("link: live notes go straight out and the hub's firmware is known", async () => {
  const { link } = await openDemo();
  assert.equal(await link.listPipes(), "1.4.0");
  const pat = link.sendPattern(120, [[1, 0]]);     // a request in flight…
  await link.sendNotes(0b101);                       // …doesn't hold up a note
  await pat;
  assert.equal(link.transport.sender.notes, 0b101);
  await link.sendStop();
  assert.equal(link.transport.sender.notes, 0, "Stop lets go of live notes");
  await link.close();
});
