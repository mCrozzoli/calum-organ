// Tests for playing together online (js/room.js): codes, roles, and the
// host's handling of guests' messages. PeerJS itself isn't loaded here: the
// host is driven with fake connections.
import { test } from "node:test";
import assert from "node:assert/strict";

const room = await import("../../app/static/js/room.js");

test("room codes", () => {
  let k = 0;
  const code = room.makeCode(() => (k++ % 10) / 10);
  assert.equal(code.length, 6);
  assert.ok(room.isCode(code));
  assert.equal(room.cleanCode(" k7pq-2m "), "K7PQ2M");
  assert.ok(!room.isCode("K7PQ2"));            // too short
  assert.ok(!room.isCode("K7PQ20"));           // 0 is never used (looks like O)
  assert.equal(room.peerIdFor("K7PQ2M"), "calum-organ-room-k7pq2m");
});

test("names are cleaned", () => {
  assert.equal(room.cleanName("  Ana  "), "Ana");
  assert.equal(room.cleanName("\u0000\u001b"), "Guest");
  assert.equal(room.cleanName("x".repeat(40)).length, 24);
});

test("what each role may paint", () => {
  const cells = [[0, 0, 1], [1, 3, 0], [2, 2, 1]];
  assert.deepEqual(room.allowedCells({ perm: "paint" }, cells, 4, 8), cells);
  assert.deepEqual(room.allowedCells({ perm: "pipe", pipe: 1 }, cells, 4, 8), [[1, 3, 0]]);
  assert.deepEqual(room.allowedCells({ perm: "cohost" }, cells, 4, 8), cells);
  // outside the grid, malformed, or not 0/1: dropped
  const bad = [[4, 0, 1], [0, 8, 1], [-1, 0, 1], [0, 0, 8], [0, 0], "x", [0.5, 0, 1]];
  assert.deepEqual(room.allowedCells({ perm: "paint" }, [[0, 0, 5]], 4, 8), [[0, 0, 5]], "figures are cells too");
  assert.deepEqual(room.allowedCells({ perm: "paint" }, bad, 4, 8), []);
  assert.deepEqual(room.allowedCells({ perm: "paint" }, "nope", 4, 8), []);
});

test("roles are sanitised", () => {
  assert.deepEqual(room.cleanPerm("admin"), { perm: "paint", pipe: null });
  assert.deepEqual(room.cleanPerm("cohost", 3), { perm: "cohost", pipe: null });
  assert.deepEqual(room.cleanPerm("pipe", 5), { perm: "pipe", pipe: 5 });
  assert.deepEqual(room.cleanPerm("pipe", 99), { perm: "pipe", pipe: 0 });
});

// A host with fake guests: records what it does and what it sends.
function fakeHost() {
  const calls = [];
  const grid = [[0, 0, 0, 0], [0, 0, 0, 0]];
  const host = new room.RoomHost({
    getSnapshot: () => ({ session: { tempo: 120, grid, rev: 0 }, organ: { connected: false } }),
    getSize: () => ({ rows: 2, cols: 4 }),
    knownUsers: () => host._known || [],
    onCells: (cells, user) => calls.push(["cells", cells, user.id]),
    onReplace: (tempo, g, user) => calls.push(["replace", tempo, user.id]),
    onTransport: (action, user) => calls.push(["transport", action, user.id]),
    onUsers: () => {},
  });
  host.code = "K7PQ2M";
  host.users = [{ id: "host", name: "Host", role: "host", perm: "cohost", pipe: null, colour: "#000" }];
  const guest = (id) => {
    const sent = [];
    const conn = { peer: id, open: true, sent, send: (m) => sent.push(m), close() {} };
    host._accept = () => {};
    return conn;
  };
  return { host, calls, guest };
}

test("a guest must say hello, then gets the session", () => {
  const { host, calls, guest } = fakeHost();
  const ana = guest("ana");
  host._message(ana, { t: "cells", cells: [[0, 0, 1]] });
  assert.deepEqual(calls, [], "ignored before hello");
  host._message(ana, { t: "hello", name: "Ana" });
  const welcome = ana.sent.find((m) => m.t === "welcome");
  assert.equal(welcome.perm, "paint");
  assert.equal(welcome.code, "K7PQ2M");
  assert.equal(welcome.session.tempo, 120);
  assert.deepEqual(welcome.users.map((u) => u.name), ["Host", "Ana"]);
});

test("the host enforces each role", () => {
  const { host, calls, guest } = fakeHost();
  const ana = guest("ana");
  host._message(ana, { t: "hello", name: "Ana" });
  const grid = [[1, 0, 0, 0], [0, 0, 0, 0]];

  // paint: any cell, but no play/stop or whole-pattern changes
  host._message(ana, { t: "cells", cells: [[1, 2, 1]] });
  host._message(ana, { t: "transport", action: "play" });
  host._message(ana, { t: "replace", tempo: 90, grid });
  assert.deepEqual(calls, [["cells", [[1, 2, 1]], "ana"]]);

  // own pipe A: only row 0
  calls.length = 0;
  host.setRole("ana", "pipe", 0);
  assert.deepEqual(ana.sent.at(-2), { t: "role", perm: "pipe", pipe: 0 });
  host._message(ana, { t: "cells", cells: [[1, 2, 0], [0, 1, 1]] });
  assert.deepEqual(calls, [["cells", [[0, 1, 1]], "ana"]]);

  // co-host: play/stop and whole patterns (validated)
  calls.length = 0;
  host.setRole("ana", "cohost");
  host._message(ana, { t: "transport", action: "play" });
  host._message(ana, { t: "transport", action: "explode" });
  host._message(ana, { t: "replace", tempo: 90, grid });
  host._message(ana, { t: "replace", tempo: 90, grid: [[9]] });          // not a figure
  assert.deepEqual(calls, [["transport", "play", "ana"], ["replace", 90, "ana"]]);

  // nobody can change the host's role
  host.setRole("host", "paint");
  assert.equal(host.users[0].perm, "cohost");
});

test("people leaving and renaming", () => {
  const { host, guest } = fakeHost();
  const ana = guest("ana");
  const bo = guest("bo");
  host._message(ana, { t: "hello", name: "Ana" });
  host._message(bo, { t: "hello", name: "Bo" });
  assert.notEqual(host.users[1].colour, host.users[2].colour);
  host._message(bo, { t: "rename", name: "Bob" });
  assert.equal(host.users[2].name, "Bob");
  host._drop("ana");
  assert.deepEqual(host.users.map((u) => u.name), ["Host", "Bob"]);
  assert.deepEqual(bo.sent.at(-1).users.map((u) => u.name), ["Host", "Bob"]);
});

test("after a handover, people rejoin with their roles", () => {
  const { host, guest } = fakeHost();
  host._known = [
    { id: "ana", name: "Ana", role: "guest", perm: "pipe", pipe: 2, colour: "#111" },
    { id: "old-host", name: "Host", role: "guest", perm: "cohost", colour: "#222", wasHost: true },
  ];
  const ana = guest("ana");
  host._message(ana, { t: "hello", name: "Ana" });
  assert.deepEqual(ana.sent[0].perm, "pipe");
  assert.equal(ana.sent[0].pipe, 2);
  // the previous host comes back with a new id: recognised by name
  const old = guest("new-id");
  host._message(old, { t: "hello", name: "Host" });
  assert.equal(old.sent[0].perm, "cohost");
  // someone new is just a painter
  const cy = guest("cy");
  host._message(cy, { t: "hello", name: "Cy" });
  assert.equal(cy.sent[0].perm, "paint");
});

test("a guest's backend turns room messages into the app's events", () => {
  const events = [];
  const g = new room.RoomGuestBackend((e) => events.push(e), "K7PQ2M");
  g._message({ t: "welcome", you: "me", perm: "pipe", pipe: 1, code: "K7PQ2M",
               session: { tempo: 100, grid: [[0]], rev: 4 },
               organ: { connected: true, demo: true, playing: false, seq: 7 }, users: [] });
  g._message({ t: "organ", connected: true, demo: false, playing: true, port: "usb", seq: 8, sending: false });
  g._message({ t: "step", step: 3 });
  g._message({ t: "end", reason: "bye" });
  assert.equal(events[0].type, "status");
  assert.equal(events[0].perm, "pipe");
  assert.equal(events[0].session.rev, 4);
  assert.equal(events[0].organ.seq, 7);
  assert.deepEqual(events[1], { type: "status", connected: true, demo: false, playing: true, port: "usb", window: null });
  assert.deepEqual(events[2], { type: "room-live", live: 0 });
  assert.deepEqual(events[3], { type: "organ", state: "sent", seq: 8, error: null });
  assert.deepEqual(events[4], { type: "step", step: 3 });
  assert.deepEqual(events[5], { type: "offline", reason: "bye" });
});

test("guests' gestures: the host gets them, limited to their pipe", () => {
  const { host, guest } = fakeHost();
  const got = [];
  host.hooks.onLive = (mask, user) => got.push([mask, user.id]);
  const ana = guest("ana");
  host._message(ana, { t: "hello", name: "Ana" });
  host._message(ana, { t: "live", mask: 0b1011 });
  host.setRole("ana", "pipe", 1);
  host._message(ana, { t: "live", mask: 0b1011 });
  host._message(ana, { t: "live", mask: "lots" });
  assert.deepEqual(got, [[0b1011, "ana"], [0b10, "ana"], [0, "ana"]]);
});
