// The UI talks to the organ through one of two backends with the same shape:
//
//   LocalBackend   the page was opened by the double-click app (Organ.command):
//                  the Python server owns the USB port, presets live in
//                  ~/.calum_organ/presets, events arrive over Server-Sent Events.
//   OnlineBackend  the page is on its own (GitHub Pages, or any static host):
//                  the browser owns the USB port via Web Serial (Chrome/Edge),
//                  presets live in this browser's storage. Also offers a demo
//                  organ so the app works with no hardware at all.
//
// Both emit the same events to onEvent: status, log, peer, step, transport,
// ready. The local app adds a shared session (app/session.py): many pages,
// one pattern. Events: cells, pattern, organ, presence, sharing, quit,
// offline. Its role is "host" (the laptop's own page) or "guest" (a phone or
// laptop that joined over Wi-Fi with the code).

import { validatePattern } from "./protocol.js";
import { SerialLink, WebSerialTransport, describePort } from "./link.js";
import { DemoTransport } from "./demo.js";

// askCode(): ask the person for the join code (a guest who typed the
// address instead of scanning the QR code). Resolves to the code or null.
export async function createBackend(onEvent, { askCode = async () => null } = {}) {
  // The local app (and its guest listener) is plain http; the online
  // version is https. Only probe for the app where it can be.
  if (location.protocol !== "http:") return new OnlineBackend(onEvent);
  try {
    let r = await fetch("api/status", { cache: "no-store" });
    if (r.status === 401) {                      // a guest without the code yet
      let code = new URLSearchParams(location.search).get("join");
      for (let tries = 0; tries < 3 && r.status === 401; tries++) {
        if (!code) code = await askCode(tries > 0);
        if (!code) break;
        await fetch(`api/join?code=${encodeURIComponent(code)}`, { cache: "no-store" });
        r = await fetch("api/status", { cache: "no-store" });
        code = null;
      }
      // keep the code out of the address bar (and out of shared links)
      history.replaceState(null, "", location.pathname);
    }
    if (r.ok) {
      const snap = await r.json();
      if (snap.type === "status") return new LocalBackend(onEvent, snap.role || "host");
    }
    if (r.status === 401) throw new JoinError();
  } catch (e) {
    if (e instanceof JoinError) throw e;
    /* no server: static hosting */
  }
  return new OnlineBackend(onEvent);
}

export class JoinError extends Error {
  constructor() { super("join code needed"); }
}

async function api(path, options = {}) {
  const opts = { ...options };
  if (opts.body !== undefined && typeof opts.body !== "string") {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------------------------------------------------------------------------
export class LocalBackend {
  constructor(onEvent, role = "host") {
    this.onEvent = onEvent;
    this.kind = "local";
    this.shared = true;            // one pattern, edited by everyone connected
    this.role = role;
    this.canQuit = role === "host";
    this.canEnterPath = role === "host";   // "Other port…" asks for a /dev path
    this.usbSupported = true;
    this._stopped = false;
    this._es = null;
    this.name = "";
  }

  start(name = "") {
    this.name = name;
    this._listen();
  }

  // A new name shows up for everyone once the event stream reconnects.
  rename(name) {
    this.name = name;
    this._es?.close();
    this._listen();
  }

  _listen() {
    const es = new EventSource(`api/events?name=${encodeURIComponent(this.name)}`);
    this._es = es;
    es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      this.onEvent(ev);
    };
    es.onerror = () => {
      es.close();
      if (this._stopped || this._es !== es) return;
      this.onEvent({ type: "offline" });
      setTimeout(() => { if (this._es === es) this._listen(); }, 1500);
    };
  }

  async listPorts() {
    const ports = await api("api/ports");
    return [
      ...ports.map((p) => ({
        id: p.device,
        label: `${p.likely ? "★ " : ""}${p.device.replace(/^\/dev\//, "")}`,
        title: p.description,
      })),
      { id: "__manual__", label: "Other port…" },
    ];
  }

  connect(id) { return api("api/connect", { method: "POST", body: { port: id } }); }
  disconnect() { return api("api/disconnect", { method: "POST" }); }

  // Shared session: painting is sent as cells, so simultaneous painters
  // don't overwrite each other; the host replaces the whole pattern for
  // settings, presets and Clear. The server sends the result to the organ.
  sendCells(cells, by) { return api("api/session/cells", { method: "POST", body: { cells, by } }); }
  replacePattern(tempo, grid, by) {
    return api("api/session/pattern", { method: "POST", body: { tempo, grid, by } });
  }
  shareInfo() { return api("api/share"); }
  share(on) { return api("api/share", { method: "POST", body: { on } }); }
  play() { return api("api/play", { method: "POST" }); }
  stop() { return api("api/stop", { method: "POST" }); }

  async quit() {
    this._stopped = true;
    try {
      await api("api/quit", { method: "POST", body: {} });
    } catch (e) {
      this._stopped = false;
      throw e;
    }
  }

  presets = {
    list: () => api("api/presets"),
    load: (name) => api(`api/presets/${encodeURIComponent(name)}`),
    save: (name, p) => api(`api/presets/${encodeURIComponent(name)}`,
                           { method: "POST", body: { tempo: p.tempo, grid: p.grid } }),
    remove: (name) => api(`api/presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  };
}

// ---------------------------------------------------------------------------
const PRESETS_KEY = "calumOrgan.presets.v1";

function readPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || {}; } catch (_) { return {}; }
}
function writePresets(all) {
  // Throws if storage is blocked (private window, etc.): surfaced to the UI.
  localStorage.setItem(PRESETS_KEY, JSON.stringify(all));
}

export class OnlineBackend {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.kind = "online";
    this.canQuit = false;
    this.canEnterPath = false;
    this.usbSupported = typeof navigator !== "undefined" && "serial" in navigator;
    this._ports = new Map();
    this._demo = false;
    this.link = new SerialLink((ev) => {
      if (ev.type === "status") ev.demo = ev.connected && this._demo;
      this.onEvent(ev);
      // A rebooted (maybe just updated) hub: ask again what it is and hears.
      if (ev.type === "ready") this._askHub();
    });
  }

  start() {
    if (this.usbSupported) {
      // Plugging a board in or out updates the port menu.
      navigator.serial.addEventListener("connect", () => this.onEvent({ type: "ports" }));
      navigator.serial.addEventListener("disconnect", () => this.onEvent({ type: "ports" }));
    }
    this.onEvent({ type: "status", connected: false, port: null, playing: false });
  }

  async listPorts() {
    const out = [];
    this._ports.clear();
    if (this.usbSupported) {
      // Ports this site was already allowed to use (no chooser needed).
      (await navigator.serial.getPorts()).forEach((port, i) => {
        const d = describePort(port);
        const id = `port:${i}`;
        this._ports.set(id, port);
        out.push({ id, label: `${d.likely ? "★ " : ""}${d.label}`, likely: d.likely });
      });
      out.sort((a, b) => Number(b.likely) - Number(a.likely));
      out.push({ id: "__choose__", label: "Choose USB device…" });
    } else {
      out.push({ id: "__choose__", label: "USB needs Chrome or Edge", disabled: true });
    }
    out.push({ id: "__demo__", label: "Demo organ (no hardware)" });
    return out;
  }

  async connect(id) {
    let transport, label;
    if (id === "__demo__") {
      transport = new DemoTransport();
      label = "demo organ";
      this._demo = true;
    } else {
      if (!this.usbSupported) throw new Error("this browser can't use USB: open the page in Chrome or Edge");
      // requestPort() shows Chrome's device chooser (needs the click that got us here).
      const port = id === "__choose__" ? await navigator.serial.requestPort() : this._ports.get(id);
      if (!port) throw new Error("that port is gone: refresh the list");
      transport = new WebSerialTransport(port);
      label = describePort(port).label;
      this._demo = false;
    }
    try {
      await this.link.open(transport, label);
    } catch (e) {
      if (e && e.name === "InvalidStateError") {
        throw new Error("the port is busy: close other apps or tabs using the board (Arduino Serial Monitor, the double-click app)");
      }
      throw e;
    }
    this._askHub();
  }

  // Which pipes does the hub hear, and which firmware is it? (A 1.1 hub
  // doesn't know PIPES: fine.)
  _askHub() {
    this.link.listPipes().catch(() => {})
      .finally(() => this.onEvent({ type: "hub", fw: this.link.hubFw }));
  }

  get hubFw() { return this.link.hubFw; }
  sendNotes(mask) { return this.link.sendNotes(mask); }

  disconnect() { return this.link.close(); }
  sendPattern(tempo, grid) { return this.link.sendPattern(tempo, grid); }
  play() { return this.link.sendPlay(); }
  stop() { return this.link.sendStop(); }

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
      writePresets(all);
    },
    remove: async (name) => {
      const all = readPresets();
      if (!(name in all)) throw new Error("not found");
      delete all[name];
      writePresets(all);
    },
  };
}
