// Tests for the Boards panel's logic (js/boards.js): reading what a board
// says about itself, versions, which letter to offer, what to do next.
// The USB and flashing parts need real boards.
import { test } from "node:test";
import assert from "node:assert/strict";

const b = await import("../../app/static/js/boards.js");

test("a 1.2 pipe describes itself", () => {
  const info = b.parseBoard([
    "ets Jun  8 2016 00:22:57",
    "READY FW calum_receiver 1.2.0 pipe C mac 94:B9:7E:FA:30:8C",
    "INFO pipe C fw 1.2.0 mac 94:B9:7E:FA:30:8C",
  ]);
  assert.deepEqual(info, { kind: "pipe", fw: "1.2.0", pipe: 2, mac: "94:B9:7E:FA:30:8C", letters: true });
  assert.equal(b.parseBoard(["INFO pipe - fw 1.2.0 mac AA"]).pipe, null);
});

test("1.1 boards and the hub", () => {
  const oldPipe = b.parseBoard(["READY FW calum_receiver 1.1.0 mac 94:B9:7E:F9:10:F0"]);
  assert.deepEqual(oldPipe, { kind: "pipe", fw: "1.1.0", pipe: null, mac: "94:B9:7E:F9:10:F0", letters: false });
  const oldHub = b.parseBoard(["FW calum_sender 1.1.0 mac 08:3A:F2:00:00:01", "OK READY", "ERR unknown"]);
  assert.equal(oldHub.kind, "hub");
  assert.equal(oldHub.fw, "1.1.0");
  assert.equal(b.parseBoard(["INFO hub fw 1.2.0 mac 08:3A"]).kind, "hub");
  // something else entirely (blank board, other firmware)
  assert.equal(b.parseBoard(["rst:0x1 (POWERON_RESET)", "hello world"]).kind, null);
});

test("versions compare by number", () => {
  assert.equal(b.compareVersions("1.2.0", "1.1.0"), 1);
  assert.equal(b.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(b.compareVersions("1.2", "1.2.0"), 0);
  assert.equal(b.compareVersions(null, "1.2.0"), -1);
});

test("the letter offered for a new pipe", () => {
  const heard = Array(8).fill(null);
  assert.equal(b.suggestLetter(heard), 0);
  heard[0] = { mac: "AA", fw: "1.2" };
  heard[1] = { mac: "BB", fw: "old" };
  assert.equal(b.suggestLetter(heard), 2, "first letter nobody answers to");
  assert.equal(b.suggestLetter(heard, "aa"), 0, "a board the hub already knows keeps its letter");
  const full = Array(8).fill({ mac: "X", fw: "1.2" });
  full[5] = { mac: "Y", fw: "old" };
  assert.equal(b.suggestLetter(full), 5, "then a pipe still on 1.1");
});

test("what to do with a board", () => {
  const pipeC = { kind: "pipe", fw: "1.2.0", pipe: 2, letters: true };
  assert.deepEqual(b.plan(pipeC, "pipe", 2, "1.2.0"), { install: false, setLetter: false, canTest: true });
  assert.deepEqual(b.plan(pipeC, "pipe", 4, "1.2.0"), { install: false, setLetter: true, canTest: true });
  assert.equal(b.plan(pipeC, "hub", 0, "1.2.0").install, true, "becoming the hub needs the hub firmware");
  const old = { kind: "pipe", fw: "1.1.0", pipe: null, letters: false };
  assert.deepEqual(b.plan(old, "pipe", 0, "1.2.0"), { install: true, setLetter: false, canTest: false });
  assert.equal(b.plan({ kind: null }, "pipe", 0, "1.2.0").install, true);
});
