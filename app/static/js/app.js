// Calum Organ v1.2 — frontend
// Pure vanilla JS modules, no build step. Runs in two places:
//   - opened by the double-click app (Organ.command): talks to the local
//     Python server (LocalBackend)
//   - opened from the web (GitHub Pages): talks to the board directly over
//     Web Serial, or to a demo organ (OnlineBackend)
//
// The screen must never claim more than the organ is doing:
//   - Connected: the playhead moves only on STEP messages from the sender
//     (the organ's clock), Play/Stop state comes from the sender's OK, and
//     each pipe shows whether it has received the latest pattern.
//   - Not connected: a local timer animates a clearly labelled PREVIEW.
//   - Demo organ: labelled DEMO and drawn like the preview; nothing real moves.

import { createBackend, JoinError, OnlineBackend } from "./backends.js";
import { LETTERS, inspect, install, setPipeLetter, testValve, latestVersion, plan, suggestLetter, sameMac } from "./boards.js";
import { RoomHost, RoomGuestBackend, cleanCode, isCode, makeCode } from "./room.js";
import { validatePattern } from "./protocol.js";
import { OrganSound } from "./sound.js";
import { SOURCES } from "./corpus.js";
import { PIPES, ROOMS, MIN_NOTE, MAX_NOTE, noteName, isQuarterTone, defaultStage, sanitizeStage, describe } from "./stage.js";

const MAX_PIPES = 8;
const BEAT = 4;          // steps per beat group
const GAP = 3;           // px between cells
const BEAT_EXTRA = 5;    // extra px between beat groups
const LABEL_W = 22;      // row-label column
const HEADER_H = 18;     // step-number row
const SEND_DEBOUNCE_MS = 60;

const state = {
  rows: 4,
  cols: 16,
  tempo: 120,
  grid: [],
  connected: false,
  demo: false,           // connected to the simulated organ
  port: null,
  playing: false,        // connected: organ's state; else: preview running
  transportBusy: false,
  playhead: -1,
  lastStepAt: 0,
  sentSeq: null,         // pattern seq the sender last accepted
  dirty: false,          // edits not yet accepted by the sender
  sending: false,
  sendError: null,
  peers: [],
  boards: [],            // per pipe: {mac, fw} the hub reported (fw "old": its 1.1 list)
  presetName: "",       // preset the screen was loaded from / saved as
  savedKey: null,       // patternKey() at last save/load; null = never saved
  quitting: false,
  // shared session (local app): one pattern, many pages
  shared: false,
  role: "host",          // "host" (runs the organ) or "guest" (joined)
  perm: "paint",         // a guest's permission: "paint", "pipe" or "cohost"
  myPipe: null,          // the row a "pipe" guest may paint
  rev: null,             // the session revision this page shows
  you: null,             // this page's connection id
  users: [],             // who's connected: {id, name, role, colour}
  sharing: { on: false },
  flashes: new Map(),    // "i,j" -> {colour, until}: someone else just painted it
};

function makeGrid(rows, cols) {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}
function freshPeers() {
  return Array.from({ length: MAX_PIPES }, () => ({ seq: null, ok: null }));
}
state.grid = makeGrid(state.rows, state.cols);
state.peers = freshPeers();

let backend = null;
let room = null;           // RoomHost while this page hosts an online room
// Live = a real organ is connected (not the demo).
const isLive = () => state.connected && !state.demo;
// The real pipes are in earshot: a room guest may be far from the organ.
const hearsOrgan = () => isLive() && backend?.kind !== "room";
const inRoomAsGuest = () => backend?.kind === "room";
const conducts = () => state.role === "host" || state.perm === "cohost";
const mayPaintRow = (i) => state.perm !== "pipe" || i === state.myPipe;

// ---------------------------------------------------------------- unsaved changes
const patternKey = () => JSON.stringify([state.tempo, state.grid]);
const isBlank = () => state.grid.every((row) => row.every((v) => !v));
function isModified() {
  return state.savedKey === null ? !isBlank() : patternKey() !== state.savedKey;
}
function markSaved(name) {
  state.presetName = name;
  state.savedKey = patternKey();
}
function renderPresetState() {
  const mod = isModified();
  savePresetBtn.classList.toggle("modified", mod);
  savePresetBtn.title = mod ? "Unsaved changes: save the current pattern" : "Save the current pattern";
  deletePresetBtn.disabled = !presetSelect.value;
}

const pipeName = (i) => String.fromCharCode(65 + i);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- DOM refs
const $ = (id) => document.getElementById(id);
const portSelect = $("portSelect");
const connectBtn = $("connectBtn");
const refreshPortsBtn = $("refreshPorts");
const rowsInput = $("rowsInput");
const colsInput = $("colsInput");
const tempoInput = $("tempoInput");
const playBtn = $("playBtn");
const clearBtn = $("clearBtn");
const presetSelect = $("presetSelect");
const savePresetBtn = $("savePreset");
const deletePresetBtn = $("deletePreset");
const quitBtn = $("quitBtn");
const moreMenu = $("moreMenu");
const truthBar = $("truthBar");
const modeBadge = $("modeBadge");
const truthText = $("truthText");
const syncText = $("syncText");
const logEl = $("log");
const logWrap = $("logWrap");
const logCount = $("logCount");
const autoScrollEl = $("autoScroll");
const peersEl = $("peers");
const gridWrap = $("gridWrap");
const canvas = $("grid");
const ctx = canvas.getContext("2d");

// ---------------------------------------------------------------- toasts
function toast(text, level = "info") {
  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.textContent = text;
  el.addEventListener("click", () => el.remove());
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), level === "err" ? 8000 : 4000);
}

// ---------------------------------------------------------------- text dialog
// In-page replacement for prompt(). Resolves to the text, or null on cancel.
// validate(v) -> error text (blocks OK) or null; note(v) -> hint text or null.
function askText({ label, value = "", placeholder = "", validate = () => null, note = () => null }) {
  const dlg = $("textDialog");
  const input = $("textDialogInput");
  const err = $("textDialogError");
  $("textDialogLabel").textContent = label;
  input.value = value;
  input.placeholder = placeholder;
  err.textContent = "";
  const check = () => {
    const v = input.value.trim();
    const msg = v ? validate(v) : "Required";
    err.textContent = v ? (msg || note(v) || "") : "";
    err.classList.toggle("note", !msg);
    $("textDialogOk").disabled = !!msg;
  };
  input.oninput = check;
  // Enter = OK (the form's default button would otherwise be Cancel).
  input.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!$("textDialogOk").disabled) dlg.close("ok");
  };
  check();
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener("close", function onClose() {
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "ok" ? input.value.trim() : null);
    });
  });
}

// ---------------------------------------------------------------- confirm dialog
// In-page replacement for confirm(). Resolves to true for OK.
function askConfirm({ title, body = "", ok = "OK", danger = false }) {
  const dlg = $("confirmDialog");
  const okBtn = $("confirmOk");
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  okBtn.textContent = ok;
  okBtn.className = danger ? "danger" : "accent";
  dlg.showModal();
  // Destructive: default to Cancel so Enter can't destroy by accident.
  (danger ? $("confirmCancel") : okBtn).focus();
  return new Promise((resolve) => {
    dlg.addEventListener("close", function onClose() {
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "ok");
    });
  });
}

// ---------------------------------------------------------------- canvas grid
// cell = width; rows get taller than wide when cells are narrow (phones),
// so every row stays an easy touch target.
const MIN_ROW_H = 30;
const geo = { cell: 32, cellH: 32 };

function colX(j) { return LABEL_W + j * (geo.cell + GAP) + Math.floor(j / BEAT) * BEAT_EXTRA; }
function rowY(i) { return HEADER_H + i * (geo.cellH + GAP); }

function layoutCanvas() {
  const style = getComputedStyle(gridWrap);
  const avail = gridWrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const groups = Math.floor((state.cols - 1) / BEAT);
  const fit = Math.floor((avail - LABEL_W - groups * BEAT_EXTRA) / state.cols) - GAP;
  geo.cell = clamp(fit, 14, 44);
  geo.cellH = Math.max(geo.cell, Math.min(MIN_ROW_H, 44));
  const w = colX(state.cols - 1) + geo.cell;
  const h = rowY(state.rows - 1) + geo.cellH;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Grid colours come from the theme (app.css), re-read when it changes.
let palette = {};
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  palette = {
    cellOn: v("--cell-on"), cellOff: v("--cell-off"), cellOffBeat: v("--cell-off-beat"),
    step: v("--step-text"), stepBeat: v("--step-text-beat"), stepNow: v("--step-text-now"),
    label: v("--muted"),
    playLive: v("--playhead-live"),
    playPreview: v("--playhead-preview"), playPreviewLine: v("--playhead-preview-line"),
  };
}

function drawGrid() {
  const { cell, cellH } = geo;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // step numbers: every step if there is room, else beat starts only
  ctx.font = "10px -apple-system, Helvetica, sans-serif";
  for (let j = 0; j < state.cols; j++) {
    if (cell < 20 && j % BEAT !== 0) continue;
    ctx.fillStyle = j === state.playhead ? palette.stepNow : (j % BEAT === 0 ? palette.stepBeat : palette.step);
    ctx.fillText(String(j + 1), colX(j) + cell / 2, HEADER_H / 2);
  }

  // row labels (pipe names)
  ctx.font = "bold 12px -apple-system, Helvetica, sans-serif";
  for (let i = 0; i < state.rows; i++) {
    ctx.fillStyle = state.perm === "pipe" && i === state.myPipe ? palette.stepNow : palette.label;
    ctx.fillText(pipeName(i), LABEL_W / 2 - 2, rowY(i) + cellH / 2);
  }

  // A guest who owns one pipe sees the other rows dimmed (they can't paint them).
  for (let i = 0; i < state.rows; i++) {
    ctx.globalAlpha = mayPaintRow(i) ? 1 : 0.35;
    for (let j = 0; j < state.cols; j++) {
      const on = state.grid[i][j];
      ctx.fillStyle = on ? palette.cellOn : (j % BEAT === 0 ? palette.cellOffBeat : palette.cellOff);
      ctx.fillRect(colX(j), rowY(i), cell, cellH);
    }
  }
  ctx.globalAlpha = 1;

  // Someone else just painted these: outline them in their colour.
  const now = performance.now();
  ctx.lineWidth = 2;
  for (const [key, f] of state.flashes) {
    if (f.until < now) { state.flashes.delete(key); continue; }
    const [i, j] = key.split(",").map(Number);
    if (i >= state.rows || j >= state.cols) continue;
    ctx.strokeStyle = f.colour;
    ctx.strokeRect(colX(j) + 1, rowY(i) + 1, cell - 2, cellH - 2);
  }
  ctx.lineWidth = 1;

  if (state.playhead >= 0 && state.playhead < state.cols) {
    const x = colX(state.playhead);
    const live = isLive();
    ctx.fillStyle = live ? palette.playLive : palette.playPreview;
    ctx.fillRect(x, rowY(0), cell, rowY(state.rows - 1) + cellH - rowY(0));
    if (!live) {
      // preview playhead is outlined, so it never looks like the organ
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = palette.playPreviewLine;
      ctx.strokeRect(x + 0.5, rowY(0) + 0.5, cell - 1, rowY(state.rows - 1) + cellH - rowY(0) - 1);
      ctx.setLineDash([]);
    }
  }
}

function cellAt(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  let j = -1;
  for (let c = 0; c < state.cols; c++) {
    if (x >= colX(c) && x < colX(c) + geo.cell + GAP) { j = c; break; }
  }
  const i = Math.floor((y - HEADER_H) / (geo.cellH + GAP));
  if (j < 0 || i < 0 || i >= state.rows || y < HEADER_H) return null;
  return [i, j];
}

// Painting with pointer events (mouse, pen and touch). Moves are
// interpolated so a fast drag fills every cell it crosses.
let painting = null;
let lastCell = null;
let paintedCells = [];   // [row, col, value] changed by the current gesture

function paintLine(from, to) {
  const [i0, j0] = from;
  const [i1, j1] = to;
  const n = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
  let changed = false;
  for (let k = 1; k <= n; k++) {
    const i = Math.round(i0 + ((i1 - i0) * k) / n);
    const j = Math.round(j0 + ((j1 - j0) * k) / n);
    if (mayPaintRow(i) && state.grid[i][j] !== painting) {
      state.grid[i][j] = painting;
      paintedCells.push([i, j, painting]);
      changed = true;
    }
  }
  return changed;
}

// After painting: shared session -> send just the painted cells.
function onGridChanged() {
  redrawPattern();
  if (state.shared) queueCells(paintedCells);
  else schedulePatternSend();
  if (room && paintedCells.length) room.cells(paintedCells, state.you);
  paintedCells = [];
}

// After a whole-pattern change (settings, preset, Clear): the host replaces
// the shared pattern; on its own, the page sends the pattern to the organ.
function commitWhole() {
  redrawPattern();
  if (state.shared) scheduleReplace();
  else schedulePatternSend();
  if (room) scheduleRoomPattern();
}

function redrawPattern() {
  drawGrid();
  renderPeers();
  renderPresetState();
  persistWorking();
}

canvas.addEventListener("pointerdown", (e) => {
  const c = cellAt(e); if (!c) return;
  e.preventDefault();
  if (!mayPaintRow(c[0])) { toast(`You paint pipe ${pipeName(state.myPipe)}: the host gave you that row`); return; }
  canvas.setPointerCapture(e.pointerId);
  painting = e.button === 2 ? 0 : 1 - state.grid[c[0]][c[1]];
  state.grid[c[0]][c[1]] = painting;
  paintedCells.push([c[0], c[1], painting]);
  lastCell = c;
  onGridChanged();
});
canvas.addEventListener("pointermove", (e) => {
  if (painting === null) return;
  const c = cellAt(e); if (!c) return;
  if (c[0] === lastCell[0] && c[1] === lastCell[1]) return;
  const changed = paintLine(lastCell, c);
  lastCell = c;
  if (changed) onGridChanged();
});
const endPaint = () => { painting = null; lastCell = null; };
canvas.addEventListener("pointerup", endPaint);
canvas.addEventListener("pointercancel", endPaint);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------------------------------------------------------- pipe panel
function buildPeers() {
  peersEl.innerHTML = "";
  for (let i = 0; i < MAX_PIPES; i++) {
    const div = document.createElement("div");
    div.className = "peer";
    div.dataset.peer = i;
    div.innerHTML = `
      <div class="label">${pipeName(i)}</div>
      <div class="pipe"></div>
      <div class="state-text"></div>
      <div class="stats"><span class="dot"></span><span class="delivery"></span></div>
      <div class="strip"></div>
    `;
    peersEl.appendChild(div);
  }
}

// Delivery of the current pattern to pipe i, as reported by the sender.
function deliveryOf(i) {
  if (i >= state.rows) return { cls: "", text: "unused" };
  if (!state.connected) return { cls: "", text: "offline" };
  const p = state.peers[i];
  if (state.sentSeq === null || p.seq !== state.sentSeq) {
    return p.ok === false && p.seq === state.sentSeq
      ? { cls: "fail", text: "missed" }
      : { cls: "wait", text: "sending" };
  }
  return p.ok ? { cls: "ok", text: "up to date" } : { cls: "fail", text: "missed" };
}

function renderPeers() {
  peersEl.classList.toggle("preview", !isLive());
  peersEl.querySelectorAll(".peer").forEach((el, i) => {
    const used = i < state.rows;
    el.classList.toggle("unused", !used);

    const row = used ? state.grid[i] : [];
    const open = used && state.playhead >= 0 && row[state.playhead] === 1;
    el.classList.toggle("open", open);
    el.querySelector(".state-text").textContent =
      !used ? "—" : state.playhead < 0 ? "idle" : open ? "open" : "closed";

    const d = deliveryOf(i);
    const b = state.boards[i];
    el.title = b ? `Pipe ${pipeName(i)}: board ${b.mac}${b.fw === "old" ? " (firmware 1.1)" : `, firmware ${b.fw}`}` : "";
    el.querySelector(".dot").className = `dot ${d.cls}`;
    el.querySelector(".delivery").textContent = d.text;

    const strip = el.querySelector(".strip");
    strip.innerHTML = "";
    if (!row.length) return;
    const cellW = 100 / row.length;
    row.forEach((v, j) => {
      if (!v) return;
      const c = document.createElement("div");
      c.className = "cell";
      c.style.left = `${j * cellW}%`;
      c.style.width = `${cellW}%`;
      strip.appendChild(c);
    });
    if (state.playhead >= 0 && state.playhead < row.length) {
      const h = document.createElement("div");
      h.className = "head";
      h.style.left = `${state.playhead * cellW}%`;
      h.style.width = `${cellW}%`;
      strip.appendChild(h);
    }
  });
  renderStageTokens();
}

// ---------------------------------------------------------------- truth bar
function renderTruth() {
  let mode, text, cls;
  if (state.connected && state.demo) {
    mode = state.playing ? "DEMO · PLAYING" : "DEMO";
    cls = "preview";
    text = "Demo organ: simulated, no hardware is connected. Everything else works as with the real organ.";
  } else if (!state.connected) {
    mode = "PREVIEW";
    cls = "preview";
    text = state.playing
      ? "Not connected: this playhead is a preview. The organ is not playing."
      : "Not connected. Edits stay on screen until you connect.";
  } else if (state.playing) {
    const silent = Date.now() - state.lastStepAt > Math.max(1500, 3 * 60000 / state.tempo);
    mode = silent ? "NO BEAT" : "LIVE · PLAYING";
    cls = silent ? "warn" : "live";
    text = silent
      ? "The organ said it is playing, but no steps are arriving from the hub."
      : `Playhead shows the step the organ is playing (${state.port}).`;
  } else {
    mode = "LIVE · STOPPED";
    cls = "stopped";
    text = `Connected to ${state.port}. The organ is silent.`;
  }
  if (state.role === "guest") {
    const who = state.perm === "cohost" ? "you and the host run" : "the host runs";
    const mine = state.perm === "pipe" ? `pipe ${pipeName(state.myPipe)}` : "the pattern";
    if (!state.connected) {
      mode = state.playing ? "PREVIEW" : "WAITING";
      cls = state.playing ? "preview" : "stopped";
      text = state.playing
        ? `The host is previewing: no organ is connected yet. Paint ${mine}.`
        : `The host hasn't connected the organ yet. Paint ${mine}: it goes to the organ when they do.`;
    } else {
      text = state.playing ? `The organ is playing this pattern. Paint ${mine}; ${who} play and tempo.`
                           : `Connected to the organ. Paint ${mine}; ${who} play and stop.`;
      if (state.demo) text = `Demo organ (no hardware). ${text.replace("Connected to the organ. ", "")}`;
    }
  }
  modeBadge.textContent = mode;
  truthBar.className = `truth ${cls}`;
  truthText.textContent = text;

  let sync = "";
  let syncCls = "";
  if (state.connected) {
    if (state.sendError) { sync = `Not sent: ${state.sendError}`; syncCls = "err"; }
    else if (state.dirty || state.sending) { sync = "Sending to organ…"; syncCls = "wait"; }
    else if (state.sentSeq !== null) {
      const missed = state.peers.slice(0, state.rows)
        .filter((p, i) => deliveryOf(i).cls === "fail").length;
      sync = missed ? `Pattern #${state.sentSeq}: ${missed} pipe(s) missed it`
                    : `Organ has pattern #${state.sentSeq}`;
      syncCls = missed ? "warn" : "ok";
    }
  }
  syncText.textContent = sync;
  syncText.className = `sync ${syncCls}`;

  playBtn.textContent = state.transportBusy ? "…" : state.playing ? "■ Stop" : "▶ Play";
  playBtn.classList.toggle("playing", state.playing);
  playBtn.setAttribute("aria-pressed", String(state.playing));
  playBtn.disabled = state.transportBusy;
  renderPresetState();
  relayOrgan();
}
setInterval(() => { if (state.connected && state.playing) renderTruth(); }, 500);

// ---------------------------------------------------------------- log
let logErrors = 0;
function logLine(text, level) {
  const div = document.createElement("div");
  div.className = level || "info";
  div.textContent = text;
  logEl.appendChild(div);
  while (logEl.childNodes.length > 1000) logEl.removeChild(logEl.firstChild);
  if (autoScrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
  if (level === "err" && !logWrap.open) logErrors++;
  logCount.textContent = logErrors ? `${logErrors} error${logErrors > 1 ? "s" : ""}` : "";
}
logWrap.addEventListener("toggle", () => {
  if (logWrap.open) { logErrors = 0; logCount.textContent = ""; logEl.scrollTop = logEl.scrollHeight; }
});

// ---------------------------------------------------------------- ports
async function refreshPorts() {
  if (state.role === "guest") return;
  if (state.connected) { showConnectedPort(); return; }
  try {
    const previous = portSelect.value;
    const ports = await backend.listPorts();
    portSelect.innerHTML = "";
    ports.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.label;
      if (p.title) o.title = p.title;
      if (p.disabled) o.disabled = true;
      portSelect.appendChild(o);
    });
    const ids = ports.filter((p) => !p.disabled).map((p) => p.id);
    portSelect.value = ids.includes(previous) ? previous : ids[0] || "";
    showConnectedPort();
  } catch (e) { toast("Could not list ports: " + e.message, "err"); }
}

// While connected, the dropdown shows (and is locked to) the live port.
function showConnectedPort() {
  if (state.connected && state.port) {
    let opt = [...portSelect.options].find((o) => o.value === state.port);
    if (!opt) {
      opt = document.createElement("option");
      opt.value = state.port;
      opt.textContent = (state.demo ? "" : "● ") + state.port.replace(/^\/dev\//, "");
      portSelect.insertBefore(opt, portSelect.firstChild);
    }
    portSelect.value = state.port;
  }
  portSelect.disabled = state.connected;
  refreshPortsBtn.disabled = state.connected;
}

async function toggleConnect() {
  connectBtn.disabled = true;
  try {
    if (state.connected) {
      await backend.disconnect();
      return;
    }
    let port = portSelect.value;
    if (port === "__manual__") {
      port = await askText({ label: "Serial device path", placeholder: "/dev/ttys004" });
      if (!port) return;
    }
    await backend.connect(port);
  } catch (e) {
    // Closing Chrome's device chooser without picking is not an error.
    if (e && e.name === "NotFoundError") return;
    toast("Connect failed: " + e.message, "err");
  } finally {
    connectBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- pattern sync
// Edits are coalesced: at most one PAT is in flight, and whatever the grid
// looks like when it finishes is sent next.
let sendTimer = null;
let sendQueued = false;
let sendChain = Promise.resolve();

function schedulePatternSend() {
  if (!state.connected) return;
  state.dirty = true;
  state.sendError = null;
  renderTruth();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(flushPattern, SEND_DEBOUNCE_MS);
}

function flushPattern() {
  clearTimeout(sendTimer);
  if (sendQueued) return sendChain;
  sendQueued = true;
  sendChain = sendChain.then(async () => {
    sendQueued = false;
    if (!state.dirty || !state.connected) return;
    state.dirty = false;
    state.sending = true;
    renderTruth();
    try {
      const seq = await backend.sendPattern(state.tempo, state.grid.map((row) => row.slice()));
      if (seq !== null) state.sentSeq = seq;
      state.sendError = null;
    } catch (e) {
      state.dirty = true;
      state.sendError = e.message;
      toast("Pattern not sent: " + e.message, "err");
    } finally {
      state.sending = false;
      renderTruth();
      renderPeers();
    }
    if (state.dirty && !state.sendError) flushPattern();
  });
  return sendChain;
}

// ---------------------------------------------------------------- shared session
// Painting is sent as cells (two people painting at once keep both their
// strokes); the host's settings, presets and Clear replace the pattern. The
// server merges everything and sends it to the organ.
let cellQueue = [];
let cellTimer = null;
function queueCells(cells) {
  if (!cells.length) return;
  cellQueue.push(...cells);
  clearTimeout(cellTimer);
  cellTimer = setTimeout(sendQueuedCells, 40);
}
async function sendQueuedCells() {
  const cells = cellQueue;
  cellQueue = [];
  for (let k = 0; k < cells.length; k += 256) {
    try {
      await backend.sendCells(cells.slice(k, k + 256), state.you);
    } catch (e) {
      toast("Your edit wasn't shared: " + e.message, "err");
    }
  }
}

let replaceTimer = null;
function scheduleReplace() {
  if (!conducts()) return;
  clearTimeout(replaceTimer);
  replaceTimer = setTimeout(async () => {
    try {
      await backend.replacePattern(state.tempo, state.grid.map((row) => row.slice()), state.you);
    } catch (e) {
      toast("Change not shared: " + e.message, "err");
    }
  }, SEND_DEBOUNCE_MS);
}

const colourOf = (id) => state.users.find((u) => u.id === id)?.colour;

function applyCells(ev) {
  const until = performance.now() + 900;
  const colour = ev.by !== state.you ? colourOf(ev.by) : null;
  for (const [i, j, v] of ev.cells) {
    if (i >= state.rows || j >= state.cols) continue;
    state.grid[i][j] = v;
    if (colour) state.flashes.set(`${i},${j}`, { colour, until });
  }
  state.rev = Math.max(state.rev ?? 0, ev.rev);
  redrawPattern();
  if (colour) setTimeout(drawGrid, 950);
}

function applyPattern(ev) {
  adoptPattern(ev.tempo, ev.grid);
  state.rev = ev.rev;
  persistWorking();
}

// ---------------------------------------------------------------- transport
async function play() {
  if (inRoomAsGuest()) { remoteTransport("play"); return; }
  if (!state.connected) { startPreview(); return; }
  state.transportBusy = true;
  renderTruth();
  try {
    if (!state.shared && (state.dirty || state.sentSeq === null)) {
      state.dirty = true;
      await flushPattern();
      if (state.sendError) return;
    }
    await backend.play();             // shared: the server sends the latest edits first
  } catch (e) {
    toast("Play failed: " + e.message, "err");
  } finally {
    state.transportBusy = false;
    renderTruth();
  }
}

async function stop() {
  if (inRoomAsGuest()) { remoteTransport("stop"); return; }
  if (!state.connected) { stopPreview(); return; }
  state.transportBusy = true;
  renderTruth();
  try {
    await backend.stop();
  } catch (e) {
    toast("Stop failed: " + e.message + " (pipes close on their own after 2 s without a beat)", "err");
  } finally {
    state.transportBusy = false;
    renderTruth();
  }
}

function setPlayhead(step) {
  if (room && step !== state.playhead) room.step(step);
  state.playhead = step;
  drawGrid();
  renderPeers();
  updateSoundGates();
}

// Preview: only when not connected, and drawn differently from the real one.
let previewTimer = null;
function startPreview() {
  stopPreview();
  state.playing = true;
  let step = -1;
  previewTimer = setInterval(() => setPlayhead((step = (step + 1) % state.cols)),
                             Math.max(20, Math.floor(60000 / state.tempo)));
  renderTruth();
}
function stopPreview() {
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = null;
  state.playing = false;
  setPlayhead(-1);
  renderTruth();
}

function adoptPattern(tempo, grid) {
  state.rows = grid.length;
  state.cols = grid[0].length;
  state.tempo = tempo;
  state.grid = grid.map((row) => row.slice());
  rowsInput.value = state.rows;
  colsInput.value = state.cols;
  tempoInput.value = state.tempo;
  relayout();
}

// The pattern on screen survives a reload or a closed tab (this browser only).
const WORKING_KEY = "calumOrgan.working.v1";
let persistTimer = null;
function persistWorking() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(WORKING_KEY, JSON.stringify({
        tempo: state.tempo, grid: state.grid,
        presetName: state.presetName, savedKey: state.savedKey,
      }));
    } catch (_) { /* storage blocked: nothing to do */ }
  }, 300);
}
function restoreWorking() {
  try {
    const w = JSON.parse(localStorage.getItem(WORKING_KEY));
    if (!w) return;
    validatePattern(w.tempo, w.grid);
    adoptPattern(w.tempo, w.grid);
    state.presetName = w.presetName || "";
    state.savedKey = w.savedKey ?? null;
  } catch (_) { /* nothing saved, or from an incompatible version */ }
}

// ---------------------------------------------------------------- presets
const PRESET_RE = /^[\w][\w \-.]{0,63}$/;

async function refreshPresets() {
  if (!conducts()) return [];
  try {
    const names = await backend.presets.list();
    presetSelect.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = names.length ? "Load preset…" : "No presets yet";
    presetSelect.appendChild(ph);
    names.forEach((n) => {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      presetSelect.appendChild(o);
    });
    presetSelect.value = names.includes(state.presetName) ? state.presetName : "";
    renderPresetState();
    return names;
  } catch (_) { return []; }
}

async function loadPreset(name) {
  if (!name) return;
  if (isModified()) {
    const go = await askConfirm({
      title: "Discard unsaved changes?",
      body: `The pattern on screen hasn't been saved. Loading “${name}” replaces it`
        + (state.connected ? " on screen and on the organ." : "."),
      ok: "Load anyway",
      danger: true,
    });
    if (!go) {
      presetSelect.value = state.presetName || "";
      renderPresetState();
      return;
    }
  }
  try {
    const p = await backend.presets.load(name);
    adoptPattern(p.tempo, p.grid);
    markSaved(name);
    commitWhole();
    renderTruth();
    toast(`Loaded “${name}”`);
  } catch (e) {
    presetSelect.value = state.presetName || "";
    toast("Load failed: " + e.message, "err");
  }
}

async function deletePreset() {
  const name = presetSelect.value;
  if (!name) return;
  const go = await askConfirm({
    title: `Delete preset “${name}”?`,
    body: "This can't be undone. The pattern on screen and on the organ stays as it is.",
    ok: "Delete",
    danger: true,
  });
  if (!go) return;
  try {
    await backend.presets.remove(name);
    if (state.presetName === name) {
      state.presetName = "";
      state.savedKey = null;      // what's on screen is no longer saved anywhere
    }
    await refreshPresets();
    renderTruth();
    toast(`Deleted “${name}”`);
  } catch (e) { toast("Delete failed: " + e.message, "err"); }
}

async function savePreset() {
  const existing = [...presetSelect.options].map((o) => o.value).filter(Boolean);
  const name = await askText({
    label: "Save pattern as",
    value: state.presetName,
    placeholder: "e.g. waltz-fast",
    validate: (v) => (!PRESET_RE.test(v) || v.includes("..")
      ? "Letters, numbers, spaces, - _ . only" : null),
    note: (v) => (existing.includes(v) ? `Will replace the saved “${v}”` : null),
  });
  if (!name) return;
  try {
    await backend.presets.save(name, { tempo: state.tempo, grid: state.grid });
    markSaved(name);
    persistWorking();
    await refreshPresets();
    renderTruth();
    toast(`Saved “${name}”`, "ok");
  } catch (e) { toast("Save failed: " + e.message, "err"); }
}

// Export / import: presets as one JSON file, to back up or move them to
// another computer or browser (online presets live in this browser only).
const EXPORT_FORMAT = "calum-organ-presets";

async function exportPresets() {
  try {
    const names = await backend.presets.list();
    if (!names.length) { toast("No presets to export yet"); return; }
    const presets = {};
    for (const n of names) {
      const p = await backend.presets.load(n);
      presets[n] = { tempo: p.tempo, grid: p.grid };
    }
    const blob = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: 1, presets }, null, 2)],
                          { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `calum-organ-presets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${names.length} preset${names.length > 1 ? "s" : ""}`, "ok");
  } catch (e) { toast("Export failed: " + e.message, "err"); }
}

async function importPresets(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.format !== EXPORT_FORMAT || typeof data.presets !== "object") throw new Error();
  } catch (_) {
    toast("That file isn't a Calum Organ preset export", "err");
    return;
  }
  const incoming = Object.entries(data.presets).filter(([name, p]) => {
    try { validatePattern(p.tempo, p.grid); return PRESET_RE.test(name) && !name.includes(".."); }
    catch (_) { return false; }
  });
  if (!incoming.length) { toast("No valid presets in that file", "err"); return; }
  const existing = new Set(await backend.presets.list());
  const clashes = incoming.filter(([n]) => existing.has(n)).length;
  const go = await askConfirm({
    title: `Import ${incoming.length} preset${incoming.length > 1 ? "s" : ""}?`,
    body: clashes ? `${clashes} will replace presets with the same name.` : "None of them replace existing presets.",
    ok: "Import",
    danger: clashes > 0,
  });
  if (!go) return;
  try {
    for (const [name, p] of incoming) await backend.presets.save(name, p);
    await refreshPresets();
    toast(`Imported ${incoming.length} preset${incoming.length > 1 ? "s" : ""}`, "ok");
  } catch (e) { toast("Import failed: " + e.message, "err"); }
}

// ---------------------------------------------------------------- boards: hub & pipes
// Set up boards one at a time over USB (js/boards.js does the talking):
// what is this board, install hub or pipe firmware, give a pipe its letter,
// click its valve. The hub reports which pipes it hears (PIPE lines), shown
// at the top while the organ is connected.
const board = { port: null, info: null, busy: false, latest: null };

function boardLog(text) {
  const pre = $("boardLog");
  pre.textContent += `${text}\n`;
  if (pre.textContent.length > 20000) pre.textContent = pre.textContent.slice(-15000);
  pre.scrollTop = pre.scrollHeight;
}

function boardStatus(text, cls = "") {
  const el = $("boardStatus");
  el.textContent = text;
  el.className = `board-status ${cls}`;
}

function renderHubHears() {
  const live = state.connected && !state.demo;
  const any = state.boards.some(Boolean);
  $("hubHears").hidden = !(state.connected && any);
  const el = $("hubPipes");
  el.innerHTML = "";
  for (let i = 0; i < MAX_PIPES; i++) {
    const b = state.boards[i];
    const d = document.createElement("span");
    d.className = `hub-pipe ${b ? (b.fw === "old" ? "old" : "ok") : ""}`;
    d.title = b ? `Pipe ${pipeName(i)}: board ${b.mac}${b.fw === "old" ? " (firmware 1.1, from the hub's built-in list)" : `, firmware ${b.fw}`}` : `No board has said it's pipe ${pipeName(i)}`;
    const name = document.createElement("b");
    name.textContent = pipeName(i);
    d.append(name, b ? (b.fw === "old" ? "1.1" : "✓") : "—");
    el.appendChild(d);
  }
  if (!live && any) $("hubHears").querySelector("p").textContent = "Pipes the demo hub hears:";
}

function selectedRole() {
  return document.querySelector("input[name=boardRole]:checked")?.value || "pipe";
}

function renderBoardCard() {
  const info = board.info;
  $("boardNone").hidden = !!info;
  $("boardCard").hidden = !info;
  if (!info) return;
  const what = info.kind === "hub" ? "Hub"
    : info.kind === "pipe" ? (info.letters && info.pipe !== null ? `Pipe ${LETTERS[info.pipe]}` : "Pipe board")
    : "An ESP32 without the organ's firmware";
  const fw = info.fw ? ` · firmware ${info.fw}` : "";
  const letterNote = info.kind === "pipe" && info.letters && info.pipe === null ? " · no letter yet"
    : info.kind === "pipe" && !info.letters ? " · letter set by the hub's list (1.1)" : "";
  $("boardWhat").textContent = `${what}${fw}${letterNote}`;
  $("boardMac").textContent = info.mac ? `MAC ${info.mac}` : "";

  const role = selectedRole();
  const pipe = parseInt($("boardPipe").value, 10);
  $("boardPipe").disabled = role !== "pipe";
  const p = plan(info, role, pipe, board.latest);
  const install = $("boardInstall");
  const same = info.kind === role && info.fw === board.latest;
  install.textContent = `${same ? "Reinstall" : info.kind === role ? "Update to" : "Install"} ${role} firmware ${board.latest || ""}`.trim();
  install.className = p.install ? "accent" : "";
  const setBtn = $("boardSetPipe");
  setBtn.hidden = role !== "pipe" || p.install;
  setBtn.textContent = `Make it pipe ${LETTERS[pipe]}`;
  $("boardTest").hidden = !p.canTest || role !== "pipe";

  // Another board already answers to that letter?
  const heard = state.boards[pipe];
  const clash = role === "pipe" && heard && heard.fw !== "old" && info.mac && !sameMac(heard.mac, info.mac);
  $("boardWarn").hidden = !clash;
  if (clash) $("boardWarn").textContent = `The hub already hears another board as pipe ${LETTERS[pipe]} (${heard.mac}). `
    + "Two boards with one letter: only one of them plays. Give the other board a new letter too.";
  install.disabled = board.busy;
  $("boardTest").disabled = board.busy;
  $("boardNext").disabled = board.busy;
  setBtn.disabled = board.busy || !p.setLetter;
}

async function boardTask(label, fn) {
  if (board.busy) return;
  board.busy = true;
  renderBoardCard();
  boardStatus(label);
  try {
    await fn();
  } catch (e) {
    const msg = e?.message || String(e);
    boardLog(`error: ${msg}`);
    boardStatus(/open|busy|InvalidState/i.test(msg)
      ? "The USB port is busy: close other apps using the board (Arduino Serial Monitor) and try again."
      : /Failed to connect|timed? ?out|sync/i.test(msg)
        ? "The board didn't respond. Hold its BOOT button, click again, and let go once it starts."
        : `Didn't work: ${msg}`, "err");
  } finally {
    board.busy = false;
    $("boardProgress").hidden = true;
    renderBoardCard();
  }
}

async function readBoard() {
  boardLog("— asking the board what it is…");
  const info = await inspect(board.port);
  info.lines.forEach((l) => boardLog(`<< ${l}`));
  board.info = info;
  document.querySelector(`input[name=boardRole][value=${info.kind === "hub" ? "hub" : "pipe"}]`).checked = true;
  $("boardPipe").value = String(info.kind === "pipe" && info.letters && info.pipe !== null
    ? info.pipe : suggestLetter(state.boards, info.mac));
  return info;
}

async function openBoardsDialog() {
  moreMenu.open = false;
  if (!("serial" in navigator)) {
    toast("Setting up boards needs Chrome or Edge on a computer", "err");
    return;
  }
  const sel = $("boardPipe");
  if (!sel.options.length) for (let i = 0; i < MAX_PIPES; i++) sel.add(new Option(LETTERS[i], String(i)));
  try { board.latest = await latestVersion(); } catch (_) { board.latest = null; }
  if (state.connected && !state.demo) backend.link?.listPipes?.().catch(() => {});
  renderHubHears();
  renderBoardCard();
  $("boardsDialog").showModal();
}

$("boardConnect").addEventListener("click", () => boardTask("Looking at the board…", async () => {
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (e?.name === "NotFoundError") { boardStatus(""); return; }   // closed the chooser
    throw e;
  }
  // The same port as the organ's hub? Only one thing can use it at a time.
  if (state.connected && !state.demo) {
    const go = await askConfirm({
      title: "Disconnect the hub?",
      body: "The board you picked may be the hub that's playing. The app disconnects it while you work here"
        + (state.playing ? ", and the organ stops." : "."),
      ok: "Disconnect",
    });
    if (!go) { boardStatus(""); return; }
    if (state.playing) await backend.stop();
    await backend.disconnect();
  }
  board.port = port;
  const info = await readBoard();
  boardStatus(info.kind ? "Choose what this board should be, then install or set its letter."
    : "No organ firmware answered: choose hub or pipe and install.");
}));

$("boardInstall").addEventListener("click", () => {
  const role = selectedRole();
  const pipe = parseInt($("boardPipe").value, 10);
  boardTask(`Installing the ${role} firmware: keep the board plugged in…`, async () => {
    $("boardProgress").hidden = false;
    $("boardBar").style.width = "0";
    boardLog(`— installing ${role} firmware`);
    const version = await install(board.port, role, {
      onProgress: (f) => { $("boardBar").style.width = `${Math.round(f * 100)}%`; },
      onLog: (t) => boardLog(t),
    });
    await sleepMs(1500);                      // let it boot
    let info = await readBoard();
    if (role === "pipe") {
      await setPipeLetter(board.port, pipe);
      boardLog(`>> PIPE ${LETTERS[pipe]}`);
      info = await readBoard();
    }
    const done = role === "hub" ? `Done: this is the hub, firmware ${version}.`
      : `Done: this is pipe ${LETTERS[pipe]}, firmware ${version}. Click the valve to check it, then plug in the next board.`;
    boardStatus(info.kind === role ? done : "Installed, but the board didn't answer afterwards: unplug it, plug it back in and click Next board.",
      info.kind === role ? "ok" : "err");
  });
});

$("boardSetPipe").addEventListener("click", () => {
  const pipe = parseInt($("boardPipe").value, 10);
  boardTask(`Making it pipe ${LETTERS[pipe]}…`, async () => {
    boardLog(`>> PIPE ${LETTERS[pipe]}`);
    boardLog(`<< ${await setPipeLetter(board.port, pipe)}`);
    await readBoard();
    boardStatus(`Done: this is pipe ${LETTERS[pipe]}. The hub finds it within a few seconds.`, "ok");
  });
});

$("boardTest").addEventListener("click", () => boardTask("Opening the valve for a moment…", async () => {
  boardLog(`<< ${await testValve(board.port)}`);
  boardStatus("Did you hear (or see) the valve click? If not, check the relay's wiring and power.", "ok");
}));

$("boardNext").addEventListener("click", () => {
  board.port = null;
  board.info = null;
  boardStatus("");
  renderBoardCard();
  $("boardConnect").click();
});

for (const r of document.querySelectorAll("input[name=boardRole]")) r.addEventListener("change", renderBoardCard);
$("boardPipe").addEventListener("change", renderBoardCard);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- backend events
// The local app's snapshot (first connection, or the event stream
// reconnecting): the shared pattern, the organ's state, who's here.
function onSessionSnapshot(ev) {
  state.role = ev.role || "host";
  state.you = ev.you || state.you;
  state.users = ev.users || [];
  if (ev.sharing) state.sharing = ev.sharing;
  applyRole();
  const s = ev.session;
  if (state.role === "host" && s.rev === 0) {
    // The app has no pattern yet (just started, or restarted while this page
    // stayed open): offer this page's rather than wiping it with a blank one.
    state.rev = 0;
    scheduleReplace();
  } else if (s.rev !== state.rev) {
    applyPattern(s);
  }
  state.sentSeq = ev.organ?.seq ?? null;
  state.sendError = ev.organ?.error ?? null;
  state.sending = !!ev.organ?.pending;
  state.peers = freshPeers();
  Object.entries(ev.peers || {}).forEach(([i, p]) => { state.peers[+i] = p; });
  renderPresence();
}

function onStatus(ev) {
  if (ev.perm) setPerm(ev.perm, ev.pipe);
  if (ev.session) onSessionSnapshot(ev);
  const was = state.connected;
  state.connected = !!ev.connected;
  state.demo = !!ev.demo;
  state.port = ev.port || null;
  if (typeof ev.playing === "boolean") state.playing = ev.playing;
  connectBtn.textContent = state.connected ? "Disconnect" : "Connect";
  connectBtn.classList.toggle("connected", state.connected);
  showConnectedPort();
  if (state.connected !== was) state.boards = [];    // the hub reports its pipes again
  if (state.connected && !was) {
    stopPreview();
    state.peers = freshPeers();
    state.sentSeq = null;
    state.playing = !!ev.playing;
    if (ev.session) {
      // Shared session: the organ gets the shared pattern from the server.
      state.sentSeq = ev.organ?.seq ?? null;
      Object.entries(ev.peers || {}).forEach(([i, p]) => { state.peers[+i] = p; });
    } else if (!state.shared) {
      schedulePatternSend();    // fresh connection: the organ gets what's on screen
    }
  }
  if (!state.connected) {
    if (!inRoomAsGuest()) state.playing = false;   // a room guest may see the host's preview
    state.dirty = false;
    state.sendError = null;
    if (!state.playing) setPlayhead(-1);
    if (was) refreshPorts();     // e.g. a port chosen just now is listed now
  }
  updateSoundGates();
  renderStageNote();
  renderPeers();
  renderTruth();
}

function onBackendEvent(ev) {
    switch (ev.type) {
      case "log": logLine(ev.line, ev.level); break;
      case "status": onStatus(ev); break;
      case "step":
        // A room guest also follows the host's preview playhead.
        if (!state.connected && !inRoomAsGuest()) break;
        state.lastStepAt = Date.now();
        setPlayhead(ev.step);
        break;
      case "transport":
        state.playing = !!ev.playing;
        if (!state.playing) setPlayhead(-1);
        else state.lastStepAt = Date.now();
        renderTruth();
        break;
      case "ready":
        // Sender rebooted: it lost the pattern and stopped.
        if (state.sentSeq !== null) toast("Hub restarted: resending the pattern", "warn");
        state.sentSeq = null;
        state.peers = freshPeers();
        setPlayhead(-1);
        if (!state.shared) schedulePatternSend();   // shared: the server resends
        break;
      case "pipe":
        state.boards[ev.peer] = { mac: ev.mac, fw: ev.fw || "?" };
        renderPeers();
        if ($("boardsDialog").open) { renderHubHears(); renderBoardCard(); }
        break;
      case "dup":
        toast(`Two boards are set to pipe ${pipeName(ev.peer)} (the other one is ${ev.mac}): give one of them `
          + "another letter in More ▾ → Boards", "warn");
        break;
      case "cells": applyCells(ev); break;
      case "pattern": applyPattern(ev); break;
      case "organ":
        state.sending = ev.state === "sending";
        if (ev.state === "sent") { state.sentSeq = ev.seq; state.sendError = null; }
        if (ev.state === "error") state.sendError = ev.error;
        renderTruth();
        renderPeers();
        break;
      case "presence":
        state.users = ev.users;
        renderPresence();
        break;
      case "sharing":
        state.sharing = { ...state.sharing, on: ev.on };
        renderPresence();
        if ($("shareDialog").open) renderShareDialog();
        break;
      case "quit":
        showClosed();
        break;
      case "ports":
        refreshPorts();
        break;
      case "role":
        setPerm(ev.perm, ev.pipe);
        toast(ev.perm === "cohost" ? "The host made you a co-host: you can play, stop and change the settings too"
          : ev.perm === "pipe" ? `The host gave you pipe ${pipeName(ev.pipe)} to paint`
          : "You can paint every pipe", "ok");
        break;
      case "reconnecting":
        truthBar.className = "truth warn";
        modeBadge.textContent = "RECONNECTING";
        truthText.textContent = "Lost the room for a moment (the host may be handing it over). Reconnecting…";
        break;
      case "become-host":
        becomeHost(ev);
        break;
      case "offline":
        if (state.role === "guest") {
          showClosed(ev.reason || "The host stopped sharing, or the laptop is out of reach.");
          break;
        }
        truthBar.className = "truth warn";
        modeBadge.textContent = "OFFLINE";
        truthText.textContent = "Lost contact with the Organ app. Is the Terminal window still open? Reconnecting…";
        break;
      case "peer":
        if (ev.peer >= 0 && ev.peer < MAX_PIPES) {
          state.peers[ev.peer] = { seq: ev.seq, ok: !!ev.ok };
          room?.peerAck({ peer: ev.peer, seq: ev.seq, ok: !!ev.ok });
          renderPeers();
          renderTruth();
        }
        break;
    }
}

// ---------------------------------------------------------------- playing together
// Two ways to play together, one screen:
//   - the local app shares its session over Wi-Fi (join code + QR code);
//   - online, a page hosts a room (room.js): anyone with the room code joins
//     over the internet. The host gives each person a role: paint everything,
//     own one pipe, or co-host (also play/stop, settings, presets, Clear),
//     and can hand the host role to someone else.
function applyRole() {
  const guest = state.role === "guest";
  document.body.dataset.role = guest && state.perm === "cohost" ? "cohost" : state.role;
  for (const el of [rowsInput, colsInput, tempoInput]) el.disabled = !conducts();
  // Simulated sound needs a secure page (a room guest's page is; a Wi-Fi guest's isn't).
  $("stageWrap").hidden = guest && !window.isSecureContext;
  logWrap.hidden = guest;
  quitBtn.hidden = guest || !backend?.canQuit;
  const shareBtn = $("shareBtn");
  shareBtn.hidden = guest || !backend;
  shareBtn.textContent = state.shared ? "Share…" : "Play together…";
  $("gridHint").textContent = !guest
    ? "Click or drag to paint · drag from a lit cell to erase · Space = play/stop · C = clear"
    : state.perm === "pipe"
      ? `Tap or drag along pipe ${pipeName(state.myPipe)}'s row to paint · drag from a lit cell to erase.`
      : "Tap or drag to paint · drag from a lit cell to erase. Everyone here sees your changes."
        + (state.perm === "cohost" ? " Space = play/stop." : "");
  renderPresence();
  drawGrid();
}

function setPerm(perm, pipe) {
  state.perm = perm;
  state.myPipe = perm === "pipe" ? pipe : null;
  applyRole();
  if (conducts()) refreshPresets();
  renderTruth();
}

function roleTag(u) {
  if (u.role === "host") return "host";
  if (u.perm === "cohost") return "co-host";
  if (u.perm === "pipe") return `pipe ${pipeName(u.pipe)}`;
  return "";
}

function renderPresence() {
  const el = $("presence");
  const show = (state.shared || !!room)
    && (state.users.length > 1 || state.sharing.on || !!room || state.role === "guest");
  el.hidden = !show;
  if (!show) return;
  el.innerHTML = "";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = `${state.users.length} here:`;
  el.appendChild(label);
  for (const u of state.users) {
    const mine = u.id === state.you;
    const manage = !!room && !mine;          // the room's host sets everyone's role
    const chip = document.createElement(mine || manage ? "button" : "span");
    chip.className = "who";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = u.colour;      // the person's colour, also used for their edits
    const tag = roleTag(u);
    chip.append(dot, `${u.name}${mine ? " (you)" : ""}`);
    if (tag && !(mine && u.role === "host" && !room)) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      chip.append(t);
    }
    if (mine) {
      chip.type = "button";
      chip.title = "Change your name";
      chip.addEventListener("click", renameMe);
    } else if (manage) {
      chip.type = "button";
      chip.title = `Choose what ${u.name} can do`;
      chip.addEventListener("click", () => openPerson(u.id));
    }
    el.appendChild(chip);
  }
  if (state.role === "host" && (state.sharing.on || room)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = room ? `Room ${room.code}` : `Sharing · code ${state.sharing.code}`;
    b.addEventListener("click", openShareDialog);
    el.appendChild(b);
  }
}

const NAME_KEY = "calumOrgan.name";
function storedName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch (_) { return ""; }
}
async function askName(current = "") {
  const name = await askText({
    label: "Your name (others in the session see it)",
    value: current,
    placeholder: "e.g. Ana",
    validate: (v) => (v.length > 24 ? "24 characters at most" : null),
  });
  if (name) { try { localStorage.setItem(NAME_KEY, name); } catch (_) {} }
  return name;
}
async function renameMe() {
  const name = await askName(storedName());
  if (!name) return;
  if (room) room.rename(name);
  else backend.rename(name);
}
function askJoinCode(wrongBefore) {
  return askText({
    label: wrongBefore ? "That code didn't work. Join code (on the host's screen):"
                       : "Join code (4 digits, on the host's screen):",
    placeholder: "1234",
    validate: (v) => (/^\d{4}$/.test(v) ? null : "4 digits"),
  });
}

async function drawQr(el, url) {
  const { default: qrcode } = await import("../vendor/qrcode-generator/qrcode.mjs");
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

async function openShareDialog() {
  moreMenu.open = false;
  const local = state.shared && state.role === "host";
  $("roomPanel").hidden = local;
  $("shareControls").hidden = !local;
  if (local) {
    try { state.sharing = await backend.shareInfo(); } catch (_) {}
    await renderShareDialog();
  } else {
    await renderRoomPanel();
  }
  $("shareDialog").showModal();
}

async function renderShareDialog() {
  const on = !!state.sharing.on;
  $("shareOff").hidden = on;
  $("shareOn").hidden = !on;
  if (!on) return;
  const sel = $("shareUrl");
  const previous = sel.value;
  sel.innerHTML = "";
  for (const url of state.sharing.urls || []) sel.add(new Option(new URL(url).host, url));
  if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
  $("shareCode").textContent = state.sharing.code;
  $("shareLink").textContent = sel.value;
  if (!sel.value) {
    $("shareQr").textContent = "No network found: connect this laptop to Wi-Fi or turn on its hotspot.";
    return;
  }
  await drawQr($("shareQr"), sel.value);
}

$("shareUrl").addEventListener("change", renderShareDialog);
$("shareStart").addEventListener("click", async () => {
  try {
    state.sharing = await backend.share(true);
  } catch (e) { toast("Couldn't start sharing: " + e.message, "err"); return; }
  await renderShareDialog();
  renderPresence();
});
$("shareStop").addEventListener("click", async () => {
  const others = state.users.filter((u) => u.role === "guest").length;
  if (others) {
    const go = await askConfirm({
      title: "Stop sharing?",
      body: `${others} ${others > 1 ? "people are" : "person is"} connected; they'll be disconnected.`,
      ok: "Stop sharing",
      danger: true,
    });
    if (!go) return;
  }
  try {
    state.sharing = await backend.share(false);
  } catch (e) { toast("Couldn't stop sharing: " + e.message, "err"); return; }
  await renderShareDialog();
  renderPresence();
});
$("playTogether").addEventListener("click", openShareDialog);
$("shareBtn").addEventListener("click", openShareDialog);

// ---- online rooms: hosting
let knownUsers = [];        // after a handover: everyone's roles, kept as they rejoin
const roomUrl = (code) => `${location.origin}${location.pathname}?room=${code}`
  + (new URLSearchParams(location.search).has("debug") ? "&debug" : "");

function organStatus() {
  return {
    connected: state.connected, demo: state.demo, playing: state.playing,
    port: state.demo ? "demo organ" : state.port,
    seq: state.sentSeq, sending: state.sending || state.dirty, error: state.sendError,
  };
}

// Guests see what the organ is doing: sent whenever it changes.
let lastRelay = "";
function relayOrgan(force = false) {
  if (!room) return;
  const o = organStatus();
  const key = JSON.stringify(o);
  if (key === lastRelay && !force) return;
  lastRelay = key;
  room.organ(o);
}

let roomPatternTimer = null;
function scheduleRoomPattern() {
  clearTimeout(roomPatternTimer);
  roomPatternTimer = setTimeout(() => {
    room?.pattern(state.tempo, state.grid.map((row) => row.slice()), state.you);
  }, SEND_DEBOUNCE_MS);
}

function roomHooks() {
  return {
    getSnapshot: () => ({
      session: { tempo: state.tempo, grid: state.grid, rev: room?.rev ?? 0 },
      organ: organStatus(),
    }),
    getSize: () => ({ rows: state.rows, cols: state.cols }),
    knownUsers: () => knownUsers,
    // A guest painted: show it in their colour, send it to the organ, tell everyone.
    onCells: (cells, user) => {
      const until = performance.now() + 900;
      for (const [i, j, v] of cells) {
        state.grid[i][j] = v;
        state.flashes.set(`${i},${j}`, { colour: user.colour, until });
      }
      redrawPattern();
      setTimeout(drawGrid, 950);
      schedulePatternSend();
      room.cells(cells, user.id);
    },
    onReplace: (tempo, grid) => {
      adoptPattern(tempo, grid);
      commitWhole();
    },
    onTransport: (action) => (action === "play" ? play() : stop()),
    onUsers: (users) => {
      state.users = users;
      renderPresence();
      if ($("personDialog").open) renderPersonDialog();
    },
  };
}

async function startRoom({ code, name, retries = 1 } = {}) {
  const r = new RoomHost(roomHooks());
  await r.start({ code, name: name || storedName() || "Host", retries });
  room = r;
  state.you = room.me.id;
  state.users = room.users;
  lastRelay = "";
  relayOrgan(true);
  applyRole();
  return room;
}

async function renderRoomPanel() {
  $("roomOff").hidden = !!room;
  $("roomOn").hidden = !room;
  if (!room) return;
  const url = roomUrl(room.code);
  $("roomCode").textContent = room.code;
  $("roomLink").textContent = url;
  await drawQr($("roomQr"), url);
}

$("roomStart").addEventListener("click", async () => {
  const btn = $("roomStart");
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const name = storedName() || await askName() || "Host";
    await startRoom({ code: makeCode(), name });
    toast(`Room ${room.code} is open: share the link or the QR code`, "ok");
  } catch (e) {
    toast("Couldn't open a room: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Open a room";
  }
  await renderRoomPanel();
});

$("roomJoin").addEventListener("click", () => {
  const code = cleanCode($("roomJoinCode").value);
  if (!isCode(code)) { toast("A room code has 6 letters and numbers, e.g. K7PQ2M", "err"); return; }
  location.href = roomUrl(code);
});
$("roomJoinCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("roomJoin").click(); }
});

$("roomCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomUrl(room.code));
    toast("Link copied", "ok");
  } catch (_) { toast("Couldn't copy: select the link and copy it", "err"); }
});

$("roomEnd").addEventListener("click", async () => {
  const others = state.users.length - 1;
  if (others) {
    const go = await askConfirm({
      title: "Close the room?",
      body: `${others} ${others > 1 ? "people are" : "person is"} in the room; they'll be disconnected.`,
      ok: "Close the room",
      danger: true,
    });
    if (!go) return;
  }
  closeRoom();
  await renderRoomPanel();
});

function closeRoom() {
  room?.close();
  room = null;
  knownUsers = [];
  state.users = [];
  applyRole();
}

// ---- choosing what someone can do
let personId = null;
function openPerson(id) {
  personId = id;
  renderPersonDialog();
  $("personDialog").showModal();
}

function renderPersonDialog() {
  const u = state.users.find((x) => x.id === personId);
  if (!u) { $("personDialog").close(); toast("They've left the room"); return; }
  $("personTitle").textContent = u.name;
  const sel = $("personPipe");
  if (!sel.options.length) {
    for (let i = 0; i < MAX_PIPES; i++) sel.add(new Option(`pipe ${pipeName(i)}`, String(i)));
  }
  sel.value = String(u.pipe ?? 0);
  for (const r of document.querySelectorAll("#personDialog input[name=perm]")) r.checked = r.value === u.perm;
}

for (const r of document.querySelectorAll("#personDialog input[name=perm]")) {
  r.addEventListener("change", () => room?.setRole(personId, r.value, parseInt($("personPipe").value, 10)));
}
$("personPipe").addEventListener("change", () => {
  document.querySelector("#personDialog input[value=pipe]").checked = true;
  room?.setRole(personId, "pipe", parseInt($("personPipe").value, 10));
});
$("personRemove").addEventListener("click", async () => {
  const u = state.users.find((x) => x.id === personId);
  $("personDialog").close();
  if (!u) return;
  const go = await askConfirm({
    title: `Remove ${u.name}?`,
    body: "They leave the room. They can rejoin with the link while the room is open.",
    ok: "Remove",
    danger: true,
  });
  if (go) room?.remove(u.id);
});
$("personHost").addEventListener("click", async () => {
  const u = state.users.find((x) => x.id === personId);
  $("personDialog").close();
  if (u) await handOver(u);
});

// Hand the room to someone else. This page lets go of the organ and rejoins
// as a co-host; everyone else follows the room to its new host.
async function handOver(u) {
  const organ = isLive() ? " This page disconnects from the organ: they need it plugged into their computer (or they play the demo organ)."
    : "";
  const go = await askConfirm({
    title: `Make ${u.name} the host?`,
    body: `They take over the room: the pattern, the organ and choosing what everyone can do.${organ} You stay in the room as a co-host.`,
    ok: "Hand over",
  });
  if (!go || !room) return;
  try {
    if (state.connected) {
      if (state.playing) await backend.stop();
      await backend.disconnect();
    }
    stopPreview();
    const code = room.code;
    await room.handover(u.id);
    room = null;
    state.quitting = true;            // no "leave site?" prompt for this reload
    location.href = roomUrl(code);
  } catch (e) {
    toast("Couldn't hand over: " + e.message, "err");
  }
}

// ---- online rooms: a guest who's been handed the room
async function becomeHost(ev) {
  backend.leave();
  backend = new OnlineBackend(onBackendEvent);
  stopPreview();
  Object.assign(state, {
    shared: false, role: "host", perm: "paint", myPipe: null,
    connected: false, demo: false, port: null, playing: false, sentSeq: null, rev: null,
  });
  state.peers = freshPeers();
  document.body.dataset.mode = backend.kind;
  $("modeName").textContent = "online";
  $("usbWarning").hidden = backend.usbSupported;
  history.replaceState(null, "", location.pathname);
  adoptPattern(ev.session.tempo, ev.session.grid);
  knownUsers = ev.users || [];
  backend.start();
  try {
    await startRoom({ code: ev.code, retries: 20 });
    room.rev = ev.session.rev || 0;
    toast("You're the host now. Connect the organ (or the demo organ) to play.", "ok");
  } catch (e) {
    toast("Couldn't take over the room: " + e.message, "err");
  }
  applyRole();
  refreshPorts();
  refreshPresets();
  renderTruth();
}

function remoteTransport(action) {
  backend[action]().catch((e) => toast(`${action === "play" ? "Play" : "Stop"} failed: ${e.message}`, "err"));
}

// ---------------------------------------------------------------- quit
function showClosed(why) {
  state.quitting = true;
  stopPreview();
  if (state.role === "guest") {
    $("closedTitle").textContent = "The session has ended";
    $("closedBody").textContent = why || "The host closed Calum Organ. Thanks for playing!";
    $("closedHint").textContent = inRoomAsGuest()
      ? "To join again, open the host's room link (or check the room code with them)."
      : "Scan the host's QR code again to rejoin.";
  }
  $("closedScreen").hidden = false;
  document.title = "Calum Organ (closed)";
}

async function quitApp() {
  const parts = [];
  if (state.connected && state.playing) parts.push("The organ will stop playing.");
  else if (state.connected) parts.push("The organ will be disconnected.");
  if (isModified()) parts.push("Your pattern hasn't been saved as a preset.");
  const go = await askConfirm({
    title: "Quit Calum Organ?",
    body: parts.join(" ") || "The app will close. Double-click Organ.command to start it again.",
    ok: "Quit",
    danger: true,
  });
  if (!go) return;
  state.quitting = true;
  try {
    await backend.quit();
  } catch (e) {
    state.quitting = false;
    toast("Quit failed: " + e.message, "err");
    return;
  }
  showClosed();
}

// ---------------------------------------------------------------- listening stage
// Simulated pipes you can hear (demo organ and preview only: with the real
// organ connected you hear the real pipes). Sound is SuperCollider running in
// the browser (sound.js); placement and pitch live in `stage` (stage.js).
const STAGE_KEY = "calumOrgan.stage.v1";
const stageEl = $("stage");
let stage = loadStage();
const stageTokens = [];          // pipe buttons A..H
let listenerToken = null;

const sound = new OrganSound({
  onLog: (line, level) => logLine(line, level),
  onState: () => { renderSoundButton(); renderStageNote(); },
});

function loadStage() {
  try { return sanitizeStage(JSON.parse(localStorage.getItem(STAGE_KEY))); }
  catch (_) { return defaultStage(); }
}
let stageSaveTimer = null;
function saveStage() {
  clearTimeout(stageSaveTimer);
  stageSaveTimer = setTimeout(() => {
    try { localStorage.setItem(STAGE_KEY, JSON.stringify(stage)); } catch (_) {}
  }, 300);
}

// What a pipe's valve is doing right now (same rule as the pipe cards).
const pipeOpen = (i) => i < state.rows && state.playhead >= 0 && state.grid[i]?.[state.playhead] === 1;

function updateSoundGates() {
  if (!sound.active) return;
  if (hearsOrgan()) { sound.closeAll(); return; }
  for (let i = 0; i < PIPES; i++) sound.setGate(i, pipeOpen(i));
}

function buildStage() {
  for (let i = 0; i < PIPES; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stage-token";
    b.innerHTML = `${pipeName(i)}<span class="n"></span>`;
    makeDraggable(b, () => stage.pipes[i], () => sound.setPipe(i, stage));
    b.addEventListener("click", () => { if (!b._dragged) auditionPipe(i); });
    stageTokens.push(b);
    stageEl.appendChild(b);
  }
  listenerToken = document.createElement("button");
  listenerToken.type = "button";
  listenerToken.className = "stage-token listener";
  listenerToken.textContent = "🎧";
  listenerToken.setAttribute("aria-label", "You (the listener). Drag or use arrow keys to move.");
  makeDraggable(listenerToken, () => stage.listener, () => sound.applyStage(stage));
  stageEl.appendChild(listenerToken);

  const pitches = $("pitches");
  pitches.innerHTML = "";
  for (let i = 0; i < PIPES; i++) {
    const row = document.createElement("div");
    row.className = "pitch-row";
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Pipe ${pipeName(i)} pitch`);
    for (let n = MIN_NOTE; n <= MAX_NOTE; n++) sel.add(new Option(noteName(n), String(n)));
    sel.addEventListener("change", () => {
      // Changing the note keeps the +¼ setting.
      const p = stage.pipes[i];
      p.note = parseInt(sel.value, 10) + (isQuarterTone(p.note) ? 0.5 : 0);
      sound.setPipe(i, stage);
      renderStageTokens();
      saveStage();
      auditionPipe(i);
    });
    const quarter = document.createElement("button");
    quarter.type = "button";
    quarter.className = "quarter";
    quarter.textContent = "+¼";
    quarter.title = `Raise pipe ${pipeName(i)} by a quarter tone`;
    quarter.setAttribute("aria-label", quarter.title);
    quarter.addEventListener("click", () => {
      const p = stage.pipes[i];
      p.note = Math.floor(p.note) + (isQuarterTone(p.note) ? 0 : 0.5);
      syncStageControls();
      sound.setPipe(i, stage);
      renderStageTokens();
      saveStage();
      auditionPipe(i);
    });
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "▶";
    play.title = `Hear pipe ${pipeName(i)}`;
    play.setAttribute("aria-label", play.title);
    play.addEventListener("click", () => auditionPipe(i));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = pipeName(i);
    row.append(name, sel, quarter, play);
    pitches.appendChild(row);
  }

  const sourceSel = $("sourceSelect");
  Object.entries(SOURCES).forEach(([value, label]) => sourceSel.add(new Option(label, value)));
  sourceSel.addEventListener("change", async () => {
    stage.source = sourceSel.value;
    saveStage();
    if (!sound.active) { renderStageNote(); return; }
    sourceSel.disabled = true;
    soundLoading = stage.source === "recorded" && !sound.buffersLoaded;
    renderStageNote();
    try {
      await sound.setSource(stage.source, stage);
    } catch (e) {
      toast("Couldn't switch the sound: " + (e.message || e), "err");
    } finally {
      soundLoading = false;
      sourceSel.disabled = false;
      renderStageNote();
    }
  });

  $("volumeInput").addEventListener("input", (e) => {
    stage.volume = parseFloat(e.target.value);
    sound.setVolume(stage.volume);
    saveStage();
  });
  $("outputSelect").addEventListener("change", (e) => {
    stage.output = e.target.value;
    sound.applyStage(stage);
    renderStageNote();
    saveStage();
  });
  $("roomSelect").addEventListener("change", (e) => {
    stage.room = e.target.value;
    sound.applyStage(stage);
    renderStageTokens();
    saveStage();
  });
  $("resetStage").addEventListener("click", () => {
    stage = defaultStage();
    syncStageControls();
    sound.applyStage(stage);
    renderStageTokens();
    saveStage();
  });
  $("soundBtn").addEventListener("click", toggleSound);
  syncStageControls();
  renderStageTokens();
  renderSoundButton();
  renderStageNote();
}

function syncStageControls() {
  $("sourceSelect").value = stage.source;
  $("volumeInput").value = stage.volume;
  $("outputSelect").value = stage.output;
  $("roomSelect").value = stage.room;
  [...$("pitches").children].forEach((row, i) => {
    const note = stage.pipes[i].note;
    row.querySelector("select").value = String(Math.floor(note));
    row.querySelector(".quarter").setAttribute("aria-pressed", String(isQuarterTone(note)));
  });
}

function renderStageTokens() {
  if (!stageTokens.length) return;
  const metres = ROOMS[stage.room];
  stageEl.style.setProperty("--lx", `${stage.listener.x * 100}%`);
  stageEl.style.setProperty("--ly", `${stage.listener.y * 100}%`);
  stageEl.style.setProperty("--ring", `calc(200cqw / ${metres})`);
  stageTokens.forEach((b, i) => {
    const p = stage.pipes[i];
    b.style.left = `${p.x * 100}%`;
    b.style.top = `${p.y * 100}%`;
    b.classList.toggle("open", pipeOpen(i) && !hearsOrgan());
    b.classList.toggle("unused", i >= state.rows);
    b.querySelector(".n").textContent = noteName(p.note);
    b.setAttribute("aria-label", `Pipe ${pipeName(i)}, ${noteName(p.note)}, ${describe(p, stage.listener, metres)}`
      + `${i >= state.rows ? " (not in the pattern)" : ""}. Drag or use arrow keys to move; Enter to hear it.`);
  });
  listenerToken.style.left = `${stage.listener.x * 100}%`;
  listenerToken.style.top = `${stage.listener.y * 100}%`;
  [...$("pitches").children].forEach((row, i) => row.classList.toggle("unused", i >= state.rows));
}

// Drag with mouse, pen or touch; arrow keys move by 2% (Shift: 10%).
function makeDraggable(el, getPos, onMove) {
  let start = null;
  const moveTo = (x, y) => {
    const p = getPos();
    p.x = clamp(x, 0, 1);
    p.y = clamp(y, 0, 1);
    renderStageTokens();
    onMove();
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    el._dragged = false;
  });
  el.addEventListener("pointermove", (e) => {
    if (!start) return;
    if (!el._dragged && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
    el._dragged = true;
    el.classList.add("dragging");
    const r = stageEl.getBoundingClientRect();
    moveTo((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  const end = () => {
    if (!start) return;
    start = null;
    el.classList.remove("dragging");
    if (el._dragged) saveStage();
    // The click that follows a drag must not audition the pipe.
    setTimeout(() => { el._dragged = false; }, 0);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const p = getPos();
    moveTo(p.x + d[0], p.y + d[1]);
    saveStage();
  });
}

async function auditionPipe(i) {
  if (hearsOrgan()) { toast("Connected to the real organ: listen to the real pipes"); return; }
  if (!sound.active) {
    await toggleSound();
    if (!sound.active) return;
  }
  sound.audition(i);
}

async function toggleSound() {
  if (sound.state === "on") { await sound.stop(); return; }
  try {
    await sound.start(stage);       // this click is the gesture browsers require
    updateSoundGates();
    meterLoop();
  } catch (e) {
    const msg = String((e && e.message) || e);
    logLine(`sound engine: ${msg}`, "err");
    // Usually the engine files couldn't be downloaded: offline, or the local
    // app was closed. Browsers remember a failed module load, hence "reload".
    toast(/fetch|network|import|load/i.test(msg)
      ? "Couldn't load the sound engine. Check the internet connection (or that the Organ app is still running), then reload the page."
      : `Sound couldn't start: ${msg}`, "err");
  }
}

function renderSoundButton() {
  const b = $("soundBtn");
  const on = sound.state === "on";
  b.textContent = sound.state === "starting" ? "Starting…" : on ? "🔇 Sound off" : "🔊 Sound on";
  b.disabled = sound.state === "starting";
  b.setAttribute("aria-pressed", String(on));
}

// What each source is, in one line for the panel.
const SOURCE_NOTES = {
  recorded: "Recorded organ: real chapel organ notes (Simon Dalzell, VSCO 2 CE), one recording every three semitones.",
  stopped: "Synth: a stopped pipe, its harmonics and attack measured from the recorded organ.",
  open: "Synth: an open pipe (principal), all harmonics present.",
};
let soundLoading = false;

function renderStageNote() {
  const note = $("stageNote");
  let text = "";
  let warn = false;
  if (soundLoading || (sound.state === "starting" && stage.source === "recorded" && !sound.buffersLoaded)) {
    text = "Loading the recorded organ (about 0.7 MB)…";
  } else if (hearsOrgan()) {
    text = "Connected to the real organ: the simulated sound is muted. Arrange the room here to plan where the pipes go.";
  } else if (sound.state === "error") {
    text = "The sound engine failed to start. See the log for details.";
    warn = true;
  } else if (sound.state !== "on" && !window.isSecureContext) {
    text = "Simulated sound needs a secure page: open the online version (or this laptop's own app) to hear it.";
  } else if (sound.state !== "on") {
    text = "Hear the demo organ (or the preview) as simulated pipes. Best with headphones."
      + (/iPhone|iPad|iPod/.test(navigator.userAgent) ? " On iPhone, also check the volume buttons." : "");
  } else if (sound.latencyMs > 60) {
    text = `Sound on. Your audio output adds ${sound.latencyMs} ms delay (Bluetooth?): wired headphones keep it in time.`;
    warn = true;
  } else {
    text = `${SOURCE_NOTES[stage.source]} ` + (stage.output === "headphones"
      ? "Headphones mode places each pipe around you (left/right, near/far)."
      : "Speakers mode pans pipes left/right and fades them with distance.");
  }
  note.textContent = text;
  note.classList.toggle("warn", warn);
}

let meterRunning = false;
function meterLoop() {
  if (meterRunning) return;
  meterRunning = true;
  const bars = [$("meterL"), $("meterR")];
  const frame = () => {
    const lv = sound.levels();
    if (!lv) {
      bars.forEach((b) => { b.style.width = "0"; });
      meterRunning = false;
      return;
    }
    lv.forEach((db, k) => { bars[k].style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`; });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- theme
// Auto follows the computer's light/dark setting; Light and Dark override it.
// The inline script in index.html applies it before first paint.
const THEME_KEY = "calumOrgan.theme";
const THEMES = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
const systemLight = matchMedia("(prefers-color-scheme: light)");

function applyTheme(pref) {
  const light = pref === "light" || (pref === "auto" && systemLight.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.documentElement.dataset.themePref = pref;
  const btn = $("themeBtn");
  btn.textContent = THEME_LABEL[pref];
  btn.title = pref === "auto"
    ? `Theme: auto (following your computer: ${light ? "light" : "dark"}). Click for light.`
    : `Theme: ${pref}. Click for ${pref === "light" ? "dark" : "auto"}.`;
  btn.setAttribute("aria-label", btn.title);
  readPalette();
  drawGrid();
}

$("themeBtn").addEventListener("click", () => {
  const current = document.documentElement.dataset.themePref || "auto";
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* not saved, still applied */ }
  applyTheme(next);
});
systemLight.addEventListener("change", () => {
  if ((document.documentElement.dataset.themePref || "auto") === "auto") applyTheme("auto");
});

// ---------------------------------------------------------------- settings
function relayout() {
  layoutCanvas();
  drawGrid();
  renderPeers();
  renderTruth();
}

function setRowsCols(rows, cols) {
  const newGrid = makeGrid(rows, cols);
  for (let i = 0; i < Math.min(rows, state.rows); i++) {
    for (let j = 0; j < Math.min(cols, state.cols); j++) newGrid[i][j] = state.grid[i][j];
  }
  state.rows = rows;
  state.cols = cols;
  state.grid = newGrid;
  if (state.playhead >= cols) state.playhead = -1;
  relayout();
  commitWhole();
}

function readNumber(input, lo, hi, fallback) {
  const v = parseInt(input.value, 10);
  const out = Number.isNaN(v) ? fallback : clamp(v, lo, hi);
  input.value = out;
  return out;
}

rowsInput.addEventListener("change", () => setRowsCols(readNumber(rowsInput, 1, 8, state.rows), state.cols));
colsInput.addEventListener("change", () => setRowsCols(state.rows, readNumber(colsInput, 1, 32, state.cols)));
tempoInput.addEventListener("change", () => {
  state.tempo = readNumber(tempoInput, 20, 300, state.tempo);
  if (previewTimer) startPreview();
  commitWhole();
});

connectBtn.addEventListener("click", toggleConnect);
refreshPortsBtn.addEventListener("click", refreshPorts);
playBtn.addEventListener("click", () => (state.playing ? stop() : play()));
clearBtn.addEventListener("click", () => {
  state.grid = makeGrid(state.rows, state.cols);
  commitWhole();
});
presetSelect.addEventListener("change", () => loadPreset(presetSelect.value));
savePresetBtn.addEventListener("click", savePreset);
$("exportPresets").addEventListener("click", () => { moreMenu.open = false; exportPresets(); });
$("importPresets").addEventListener("click", () => { moreMenu.open = false; $("importFile").click(); });
$("importFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) importPresets(f);
});
$("updateFirmware").addEventListener("click", openBoardsDialog);
const openAbout = () => { moreMenu.open = false; $("aboutDialog").showModal(); };
$("openAbout").addEventListener("click", openAbout);
$("openAboutFooter").addEventListener("click", openAbout);
document.addEventListener("click", (e) => {
  if (moreMenu.open && !moreMenu.contains(e.target)) moreMenu.open = false;
});
deletePresetBtn.addEventListener("click", deletePreset);
quitBtn.addEventListener("click", quitApp);

window.addEventListener("beforeunload", (e) => {
  if (state.quitting) return;
  // Online, the browser holds the USB port: closing the tab leaves the
  // organ playing with nobody able to stop it from here.
  const organRunning = backend && backend.kind === "online" && isLive() && state.playing;
  const guestsHere = room && state.users.length > 1;   // closing the page closes the room
  if (!organRunning && !guestsHere) return;
  e.preventDefault();
  e.returnValue = "";   // browser shows its own "leave site?" prompt
});
// Tell the room's guests right away (instead of after their connection times out).
window.addEventListener("pagehide", () => room?.close());

window.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "BUTTON", "SUMMARY"].includes(e.target.tagName)) return;
  if (document.querySelector("dialog[open]") || state.quitting || !conducts()) return;
  if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
  if (e.key === "c" || e.key === "C") clearBtn.click();
});
window.addEventListener("resize", relayout);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sound.wake();
});

// ---------------------------------------------------------------- init
async function init() {
  applyTheme(document.documentElement.dataset.themePref || "auto");
  // ?debug exposes internals to the browser console (and to tests); read it
  // now, before a guest's join code is cleaned out of the address.
  const params = new URLSearchParams(location.search);
  const debug = params.has("debug");
  const roomCode = cleanCode(params.get("room"));
  buildPeers();
  buildStage();
  relayout();
  try {
    // ?room=CODE: join someone's online room.
    backend = isCode(roomCode) ? new RoomGuestBackend(onBackendEvent, roomCode)
      : await createBackend(onBackendEvent, { askCode: askJoinCode });
  } catch (e) {
    if (!(e instanceof JoinError)) throw e;
    state.role = "guest";
    showClosed("This is a shared Calum Organ session. Ask the host for the join code (or scan their QR code), then reload this page.");
    return;
  }
  state.shared = !!backend.shared;
  state.role = backend.role || "host";
  document.body.dataset.mode = backend.kind;
  $("modeName").textContent = backend.kind === "room" ? `room ${roomCode}`
    : backend.kind === "online" ? "online"
    : state.role === "guest" ? "joined" : "local app";
  $("usbWarning").hidden = backend.usbSupported || state.role === "guest";
  applyRole();
  if (state.role !== "guest") restoreWorking();   // a guest shows the shared pattern
  relayout();
  const name = state.role === "guest" ? (storedName() || await askName() || "") : storedName();
  if (debug) window.organ = { state, sound, getStage: () => stage, get backend() { return backend; }, get room() { return room; } };
  if (backend.kind === "room") {
    modeBadge.textContent = "JOINING";
    truthText.textContent = `Joining room ${roomCode}…`;
  }
  try {
    await backend.start(name);
  } catch (e) {
    showClosed(`Couldn't join room ${roomCode}: ${e.message}.`);
    return;
  }
  refreshPorts();
  refreshPresets();
}
init();
