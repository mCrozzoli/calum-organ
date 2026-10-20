// Playing together on the web: one browser hosts a room, others join it with
// a room code, over the internet or the same Wi-Fi.
//
// Browsers find each other through the free public PeerJS server; after that
// everything goes directly between them (WebRTC data channels). The host's
// browser is the hub: it owns the pattern, merges everyone's edits, drives
// the organ (Web Serial or the demo organ) and relays the organ's playhead.
//
//   RoomHost          runs in the host's page next to its organ backend
//   RoomGuestBackend  a guest's backend: speaks the same events as the local
//                     app's shared session (status, cells, pattern, presence,
//                     organ, step, transport), so the guest screen is shared
//
// Roles the host gives each person:
//   paint   paint any pipe's steps
//   pipe    paint only their own pipe's row
//   cohost  also play/stop, tempo, pipes/steps, presets and Clear
// The host can hand the room over to someone else; everyone stays in.

import { validatePattern } from "./protocol.js";

export const PERMS = ["paint", "pipe", "cohost"];
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";    // no 0/O, 1/I/L
const COLOURS = ["#5cd1ff", "#f2a93b", "#42d392", "#c792ea", "#ef5350", "#f4c542", "#7fdbca", "#ff9cac"];
const MAX_CELLS = 256;
const PEER_SCRIPT = new URL("../vendor/peerjs/peerjs.min.js", import.meta.url).href;

// ---------------------------------------------------------------- pure rules
export function makeCode(random = Math.random) {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return code;
}
export const cleanCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
export const isCode = (code) => code.length === 6 && [...code].every((c) => CODE_CHARS.includes(c));
export const peerIdFor = (code) => `calum-organ-room-${code.toLowerCase()}`;

export function cleanName(raw, fallback = "Guest") {
  const s = [...String(raw || "")].filter((ch) => ch >= " " && ch !== "\u007f").join("").trim().slice(0, 24).trim();
  return s || fallback;
}

// The cells a person may paint: [[row, col, 0|1], ...] within the grid, and
// only their own row for a "pipe" role. Malformed entries are dropped.
export function allowedCells(user, cells, rows, cols) {
  if (!Array.isArray(cells)) return [];
  return cells.slice(0, MAX_CELLS).filter((c) => Array.isArray(c) && c.length === 3
    && c.every(Number.isInteger) && (c[2] === 0 || c[2] === 1)
    && c[0] >= 0 && c[0] < rows && c[1] >= 0 && c[1] < cols
    && (user.perm !== "pipe" || c[0] === user.pipe));
}

export const mayConduct = (user) => user.perm === "cohost";   // play/stop, settings, presets

export function cleanPerm(perm, pipe) {
  if (!PERMS.includes(perm)) return { perm: "paint", pipe: null };
  if (perm !== "pipe") return { perm, pipe: null };
  return { perm, pipe: Number.isInteger(pipe) && pipe >= 0 && pipe < 8 ? pipe : 0 };
}

// ---------------------------------------------------------------- PeerJS
let peerLoading = null;
function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  peerLoading ||= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src: PEER_SCRIPT, async: true });
    s.onload = () => resolve(window.Peer);
    s.onerror = () => { peerLoading = null; reject(new Error("couldn't load PeerJS (offline?)")); };
    document.head.appendChild(s);
  });
  return peerLoading;
}

// Open a Peer with a fixed id, retrying while the previous owner (e.g. the
// host who just handed over) is still releasing it.
async function openPeer(id, tries = 1) {
  const Peer = await loadPeer();
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
        // Only errors while opening are fatal here; once open, a later error
        // (e.g. "no such room yet" while a host hands over) must not destroy it.
        const failed = (e) => { peer.off("open", opened); peer.destroy(); reject(e); };
        const opened = () => { peer.off("error", failed); resolve(peer); };
        peer.once("open", opened);
        peer.once("error", failed);
      });
    } catch (e) {
      if (attempt >= tries || e?.type !== "unavailable-id") throw friendly(e);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function friendly(e) {
  const type = e?.type || "";
  if (type === "unavailable-id") return new Error("that room code is already in use");
  if (type === "peer-unavailable") return new Error("no room with that code (is the host's page open?)");
  if (type === "network" || type === "server-error" || type === "socket-error")
    return new Error("can't reach the matchmaking server (check the internet connection)");
  if (type === "browser-incompatible") return new Error("this browser can't do peer-to-peer connections");
  return e instanceof Error ? e : new Error(String(e));
}

// ---------------------------------------------------------------- host
export class RoomHost {
  // hooks: getSnapshot() -> {session:{tempo,grid,rev}, organ:{...}}
  //        onCells(cells, user)  onReplace(tempo, grid, user)
  //        onTransport("play"|"stop", user)  onUsers(users)  onLog(text)
  constructor(hooks) {
    this.hooks = hooks;
    this.peer = null;
    this.code = null;
    this.conns = new Map();          // peer id -> DataConnection
    this.users = [];                 // [{id, name, role, perm, pipe, colour}]
    this.rev = 0;
    this._colour = 0;
  }

  get open() { return !!this.peer; }

  // retries: after a handover, the previous host may still hold the id for a moment.
  async start({ code = makeCode(), name = "Host", retries = 1 } = {}) {
    this.peer = await openPeer(peerIdFor(code), retries);
    this.code = code;
    this.users = [{ id: this.peer.id, name: cleanName(name, "Host"), role: "host", perm: "cohost", pipe: null, colour: COLOURS[0] }];
    this._colour = 0;
    this.peer.on("connection", (conn) => this._accept(conn));
    this.peer.on("error", () => { /* a guest's connection failing: handled per connection */ });
    this.peer.on("disconnected", () => this.peer && !this.peer.destroyed && this.peer.reconnect());
    this._users();
    return code;
  }

  get me() { return this.users[0]; }

  _accept(conn) {
    conn.on("data", (msg) => this._message(conn, msg));
    conn.on("close", () => this._drop(conn.peer));
    conn.on("error", () => this._drop(conn.peer));
  }

  _message(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    let user = this.users.find((u) => u.id === conn.peer);
    if (msg.t === "hello") {
      if (!user) {
        const name = cleanName(msg.name);
        user = { id: conn.peer, name, role: "guest", perm: "paint", pipe: null,
                 colour: COLOURS[1 + (this._colour++ % (COLOURS.length - 1))] };
        // After a handover everyone rejoins and keeps their role and colour
        // (the previous host comes back with a new id: matched by name).
        const known = this.hooks.knownUsers?.() || [];
        const was = known.find((u) => u.id === conn.peer) || known.find((u) => u.wasHost && u.name === name);
        if (was) Object.assign(user, cleanPerm(was.perm, was.pipe), { colour: was.colour || user.colour });
        this.users.push(user);
      }
      this.conns.set(conn.peer, conn);
      const snap = this.hooks.getSnapshot();
      conn.send({ t: "welcome", you: user.id, perm: user.perm, pipe: user.pipe, code: this.code, ...snap, users: this.users });
      this._users();
      return;
    }
    if (!user) return;                               // must say hello first
    if (msg.t === "cells") {
      const { rows, cols } = this.hooks.getSize();
      const cells = allowedCells(user, msg.cells, rows, cols);
      if (cells.length) this.hooks.onCells(cells, user);
    } else if (msg.t === "replace" && mayConduct(user)) {
      try {
        validatePattern(msg.tempo, msg.grid);
        this.hooks.onReplace(msg.tempo, msg.grid, user);
      } catch (_) { /* ignore a bad pattern */ }
    } else if (msg.t === "transport" && mayConduct(user) && (msg.action === "play" || msg.action === "stop")) {
      this.hooks.onTransport(msg.action, user);
    } else if (msg.t === "live") {
      // Gestures from a guest's phone: which pipes they hold open now. A
      // guest who owns one pipe can only play that one.
      const mask = Number.isInteger(msg.mask) ? msg.mask & 0xff : 0;
      this.hooks.onLive?.(user.perm === "pipe" ? mask & (1 << user.pipe) : mask, user);
    } else if (msg.t === "rename") {
      user.name = cleanName(msg.name);
      this._users();
    }
  }

  _drop(id) {
    this.conns.delete(id);
    const before = this.users.length;
    this.users = this.users.filter((u) => u.id !== id || u.role === "host");
    if (this.users.length !== before) this._users();
  }

  _users() {
    this.broadcast({ t: "users", users: this.users });
    this.hooks.onUsers?.(this.users);
  }

  broadcast(msg) {
    for (const conn of this.conns.values()) {
      try { if (conn.open) conn.send(msg); } catch (_) { /* gone */ }
    }
  }

  // ---- what the host's page reports
  cells(cells, byId) {
    this.rev += 1;
    this.broadcast({ t: "cells", cells, rev: this.rev, by: byId });
  }
  pattern(tempo, grid, byId) {
    this.rev += 1;
    this.broadcast({ t: "pattern", tempo, grid, rev: this.rev, by: byId });
  }
  organ(status) { this.broadcast({ t: "organ", ...status }); }  // connected, demo, playing, port, seq, sending, error
  step(step) { this.broadcast({ t: "step", step }); }
  peerAck(p) { this.broadcast({ t: "peer", ...p }); }

  // ---- managing people
  rename(name) {
    this.me.name = cleanName(name, "Host");
    this._users();
  }

  setRole(id, perm, pipe) {
    const user = this.users.find((u) => u.id === id && u.role !== "host");
    if (!user) return;
    Object.assign(user, cleanPerm(perm, pipe));
    this.conns.get(id)?.send({ t: "role", perm: user.perm, pipe: user.pipe });
    this._users();
  }

  remove(id) {
    const conn = this.conns.get(id);
    try { conn?.send({ t: "end", reason: "The host removed you from the room." }); } catch (_) {}
    setTimeout(() => conn?.close(), 300);
    this._drop(id);
  }

  // Hand the room to `id`: they reopen it under the same code with this
  // session; everyone else reconnects to them automatically.
  async handover(id) {
    const conn = this.conns.get(id);
    if (!conn) throw new Error("that person has left");
    const snap = this.hooks.getSnapshot();
    const users = this.users.filter((u) => u.id !== id)
      .map((u) => (u.role === "host" ? { ...u, role: "guest", perm: "cohost", wasHost: true } : u));
    conn.send({ t: "handover", code: this.code, session: snap.session, users });
    await new Promise((r) => setTimeout(r, 500));
    this.close(false);
  }

  close(announce = true) {
    if (announce) this.broadcast({ t: "end", reason: "The host ended the session." });
    const peer = this.peer;
    this.peer = null;
    setTimeout(() => peer?.destroy(), announce ? 300 : 0);
    this.conns.clear();
  }
}

// ---------------------------------------------------------------- guest
const PRESETS_KEY = "calumOrgan.presets.v1";
const readPresets = () => { try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || {}; } catch (_) { return {}; } };

export class RoomGuestBackend {
  constructor(onEvent, code) {
    this.onEvent = onEvent;
    this.code = code;
    this.kind = "room";
    this.shared = true;
    this.role = "guest";
    this.canQuit = false;
    this.canEnterPath = false;
    this.usbSupported = true;
    this.peer = null;
    this.conn = null;
    this.name = "";
    this._ended = false;
  }

  async start(name = "") {
    this.name = name;
    this.peer = await openPeer(null);
    // "no such peer" arrives on the Peer, not on the connection
    this.peer.on("error", (e) => { if (e?.type === "peer-unavailable") this._lost?.(); });
    this.peer.on("disconnected", () => { if (!this._ended && !this.peer.destroyed) this.peer.reconnect(); });
    this._connect(true, Date.now() + 15000);    // a wrong code is reported in ~15 s
  }

  // Connect to the room; after a drop (the host handing over, a reload),
  // keep trying for a while before giving up.
  _connect(first, deadline = Date.now() + 45000) {
    if (this._ended) return;
    const conn = this.peer.connect(peerIdFor(this.code), { reliable: true, serialization: "json" });
    this.conn = conn;
    let opened = false;
    let done = false;
    conn.on("open", () => {
      opened = true;
      conn.send({ t: "hello", name: this.name });
    });
    conn.on("data", (msg) => this._message(msg));
    const lost = () => {
      if (done || this.conn !== conn || this._ended) return;
      done = true;
      if (Date.now() > deadline) {
        this._ended = true;
        this.onEvent({ type: "offline", reason: first && !opened
          ? "No room with that code, or the host's page is closed."
          : "The host left and the room didn't come back." });
        return;
      }
      if (opened) this.onEvent({ type: "reconnecting" });
      // Once in, a drop (e.g. a handover) gets a fresh 45 s to come back.
      setTimeout(() => this._connect(first && !opened, opened ? Date.now() + 45000 : deadline), 1500);
    };
    this._lost = lost;
    conn.on("close", lost);
    conn.on("error", lost);
  }

  _message(m) {
    if (!m || typeof m !== "object") return;
    const ev = (o) => this.onEvent(o);
    switch (m.t) {
      case "welcome":
        this.you = m.you;
        ev({ type: "status", role: "guest", you: m.you, perm: m.perm, pipe: m.pipe, room: m.code,
             connected: !!m.organ?.connected, demo: !!m.organ?.demo, playing: !!m.organ?.playing,
             port: m.organ?.port || null, session: m.session,
             organ: { seq: m.organ?.seq ?? null, error: m.organ?.error || null, pending: !!m.organ?.sending },
             users: m.users, peers: {} });
        break;
      case "cells": ev({ type: "cells", cells: m.cells, rev: m.rev, by: m.by }); break;
      case "pattern": ev({ type: "pattern", tempo: m.tempo, grid: m.grid, rev: m.rev, by: m.by }); break;
      case "users": ev({ type: "presence", users: m.users }); break;
      case "role": ev({ type: "role", perm: m.perm, pipe: m.pipe }); break;
      case "organ":
        ev({ type: "status", connected: !!m.connected, demo: !!m.demo, playing: !!m.playing, port: m.port || null });
        ev({ type: "room-live", live: (m.live || 0) & 0xff });
        ev({ type: "organ", state: m.error ? "error" : m.sending ? "sending" : "sent", seq: m.seq ?? null, error: m.error || null });
        break;
      case "step": ev({ type: "step", step: m.step }); break;
      case "peer": ev({ type: "peer", peer: m.peer, ok: m.ok, seq: m.seq }); break;
      case "handover":
        this._ended = true;            // this connection's job is done
        ev({ type: "become-host", code: m.code, session: m.session, users: m.users });
        break;
      case "end":
        this._ended = true;
        ev({ type: "offline", reason: m.reason });
        break;
    }
  }

  _send(msg) {
    if (!this.conn?.open) throw new Error("not connected to the room");
    this.conn.send(msg);
  }

  async sendCells(cells) { this._send({ t: "cells", cells }); return {}; }
  async replacePattern(tempo, grid) { this._send({ t: "replace", tempo, grid }); return {}; }
  async play() { this._send({ t: "transport", action: "play" }); }
  async stop() { this._send({ t: "transport", action: "stop" }); }
  rename(name) { this.name = name; try { this._send({ t: "rename", name }); } catch (_) {} }
  // Pipes this guest's gestures hold open (sent on change and every 300 ms
  // while any are held: the host lets go after a second without it).
  sendLive(mask) { try { this._send({ t: "live", mask }); } catch (_) {} }
  async listPorts() { return []; }

  leave() {
    this._ended = true;
    try { this.conn?.close(); } catch (_) {}
    this.peer?.destroy();
  }

  // A co-host loads their own presets (kept in their browser).
  presets = {
    list: async () => Object.keys(readPresets()).sort(),
    load: async (name) => {
      const p = readPresets()[name];
      if (!p) throw new Error("not found");
      validatePattern(p.tempo, p.grid);
      return { name, tempo: p.tempo, grid: p.grid };
    },
    save: async (name, p) => {
      validatePattern(p.tempo, p.grid);
      const all = readPresets();
      all[name] = { tempo: p.tempo, grid: p.grid };
      localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
    },
    remove: async (name) => {
      const all = readPresets();
      delete all[name];
      localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
    },
  };
}
