// Calum Organ v1.1 — frontend
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

import { createBackend } from "./backends.js";
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
  presetName: "",       // preset the screen was loaded from / saved as
  savedKey: null,       // patternKey() at last save/load; null = never saved
  quitting: false,
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
// Live = a real organ is connected (not the demo).
const isLive = () => state.connected && !state.demo;

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
    ctx.fillStyle = palette.label;
    ctx.fillText(pipeName(i), LABEL_W / 2 - 2, rowY(i) + cellH / 2);
  }

  for (let i = 0; i < state.rows; i++) {
    for (let j = 0; j < state.cols; j++) {
      const on = state.grid[i][j];
      ctx.fillStyle = on ? palette.cellOn : (j % BEAT === 0 ? palette.cellOffBeat : palette.cellOff);
      ctx.fillRect(colX(j), rowY(i), cell, cellH);
    }
  }

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

function paintLine(from, to) {
  const [i0, j0] = from;
  const [i1, j1] = to;
  const n = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
  let changed = false;
  for (let k = 1; k <= n; k++) {
    const i = Math.round(i0 + ((i1 - i0) * k) / n);
    const j = Math.round(j0 + ((j1 - j0) * k) / n);
    if (state.grid[i][j] !== painting) { state.grid[i][j] = painting; changed = true; }
  }
  return changed;
}

function onGridChanged() {
  drawGrid();
  renderPeers();
  renderPresetState();
  persistWorking();
  schedulePatternSend();
}

canvas.addEventListener("pointerdown", (e) => {
  const c = cellAt(e); if (!c) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  painting = e.button === 2 ? 0 : 1 - state.grid[c[0]][c[1]];
  state.grid[c[0]][c[1]] = painting;
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
      ? "The organ said it is playing, but no steps are arriving from the sender."
      : `Playhead shows the step the organ is playing (${state.port}).`;
  } else {
    mode = "LIVE · STOPPED";
    cls = "stopped";
    text = `Connected to ${state.port}. The organ is silent.`;
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

// ---------------------------------------------------------------- transport
async function play() {
  if (!state.connected) { startPreview(); return; }
  state.transportBusy = true;
  renderTruth();
  try {
    if (state.dirty || state.sentSeq === null) {
      state.dirty = true;
      await flushPattern();
      if (state.sendError) return;
    }
    await backend.play();
  } catch (e) {
    toast("Play failed: " + e.message, "err");
  } finally {
    state.transportBusy = false;
    renderTruth();
  }
}

async function stop() {
  if (!state.connected) { stopPreview(); return; }
  state.transportBusy = true;
  renderTruth();
  try {
    await backend.stop();
  } catch (e) {
    toast("Stop failed: " + e.message + " (receivers close on their own after 2 s without a beat)", "err");
  } finally {
    state.transportBusy = false;
    renderTruth();
  }
}

function setPlayhead(step) {
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
    persistWorking();
    schedulePatternSend();
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

// ---------------------------------------------------------------- firmware update
// Uses Espressif's ESP Web Tools (Web Serial) to flash the boards from the
// page. Loaded only when the dialog opens, so the app itself needs no CDN.
const ESP_WEB_TOOLS = "https://unpkg.com/esp-web-tools@10.4.0/dist/web/install-button.js?module";

async function openFirmwareDialog() {
  const dlg = $("firmwareDialog");
  if (!("serial" in navigator)) {
    $("firmwareButtons").innerHTML =
      "<p class='dialog-error'>Updating boards needs Chrome or Edge on a computer.</p>";
    dlg.showModal();
    return;
  }
  if (state.connected && !state.demo) {
    const go = await askConfirm({
      title: "Disconnect to update?",
      body: "The board's USB port can only be used by one thing at a time, so the app disconnects first."
        + (state.playing ? " The organ will stop." : ""),
      ok: "Disconnect",
    });
    if (!go) return;
    try {
      if (state.playing) await backend.stop();
      await backend.disconnect();
    } catch (e) { toast("Disconnect failed: " + e.message, "err"); return; }
  }
  dlg.showModal();
  if ($("firmwareButtons").dataset.ready) return;
  try {
    await import(ESP_WEB_TOOLS);
  } catch (_) {
    $("firmwareButtons").innerHTML =
      "<p class='dialog-error'>Couldn't load the updater (are you online?).</p>";
    return;
  }
  const boards = [
    ["sender", "Update sender", "The board plugged into this computer that talks to the app."],
    ["receiver", "Update a pipe", "Any pipe board (A–H). Plug it in by USB, update, repeat for each pipe."],
  ];
  $("firmwareButtons").innerHTML = "";
  for (const [dir, label, help] of boards) {
    const row = document.createElement("div");
    row.className = "fw-row";
    const btn = document.createElement("esp-web-install-button");
    btn.setAttribute("manifest", `firmware/${dir}/manifest.json`);
    btn.innerHTML = `<button slot="activate" class="accent">${label}</button>`;
    const p = document.createElement("p");
    p.textContent = help;
    row.append(btn, p);
    $("firmwareButtons").appendChild(row);
  }
  $("firmwareButtons").dataset.ready = "1";
}

// ---------------------------------------------------------------- backend events
function onStatus(ev) {
  const was = state.connected;
  state.connected = !!ev.connected;
  state.demo = !!ev.demo;
  state.port = ev.port || null;
  if (typeof ev.playing === "boolean") state.playing = ev.playing;
  connectBtn.textContent = state.connected ? "Disconnect" : "Connect";
  connectBtn.classList.toggle("connected", state.connected);
  showConnectedPort();
  if (state.connected && !was) {
    stopPreview();
    state.peers = freshPeers();
    state.sentSeq = null;
    state.playing = !!ev.playing;
    if (ev.pattern) {
      // Organ already has a pattern (page reloaded / second tab): show it,
      // don't overwrite it.
      adoptPattern(ev.pattern.tempo, ev.pattern.grid);
      state.presetName = "";
      state.savedKey = null;        // unknown whether it was saved
      refreshPresets();
      state.sentSeq = ev.pattern.seq;
      Object.entries(ev.peers || {}).forEach(([i, p]) => { state.peers[+i] = p; });
      state.dirty = false;
    } else {
      schedulePatternSend();    // fresh connection: the organ gets what's on screen
    }
  }
  if (!state.connected) {
    state.playing = false;
    state.dirty = false;
    state.sendError = null;
    setPlayhead(-1);
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
        if (!state.connected) break;
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
        if (state.sentSeq !== null) toast("Sender restarted: resending the pattern", "warn");
        state.sentSeq = null;
        state.peers = freshPeers();
        setPlayhead(-1);
        schedulePatternSend();
        break;
      case "quit":
        showClosed();
        break;
      case "ports":
        refreshPorts();
        break;
      case "offline":
        truthBar.className = "truth warn";
        modeBadge.textContent = "OFFLINE";
        truthText.textContent = "Lost contact with the Organ app. Is the Terminal window still open? Reconnecting…";
        break;
      case "peer":
        if (ev.peer >= 0 && ev.peer < MAX_PIPES) {
          state.peers[ev.peer] = { seq: ev.seq, ok: !!ev.ok };
          renderPeers();
          renderTruth();
        }
        break;
    }
}

// ---------------------------------------------------------------- quit
function showClosed() {
  state.quitting = true;
  stopPreview();
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
  if (isLive()) { sound.closeAll(); return; }
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
    b.classList.toggle("open", pipeOpen(i) && !isLive());
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
  if (isLive()) { toast("Connected to the real organ: listen to the real pipes"); return; }
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
  } else if (isLive()) {
    text = "Connected to the real organ: the simulated sound is muted. Arrange the room here to plan where the pipes go.";
  } else if (sound.state === "error") {
    text = "The sound engine failed to start. See the log for details.";
    warn = true;
  } else if (sound.state !== "on") {
    text = "Hear the demo organ (or the preview) as simulated pipes. Best with headphones.";
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
  persistWorking();
  schedulePatternSend();
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
  persistWorking();
  schedulePatternSend();
});

connectBtn.addEventListener("click", toggleConnect);
refreshPortsBtn.addEventListener("click", refreshPorts);
playBtn.addEventListener("click", () => (state.playing ? stop() : play()));
clearBtn.addEventListener("click", () => {
  state.grid = makeGrid(state.rows, state.cols);
  onGridChanged();
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
$("updateFirmware").addEventListener("click", () => { moreMenu.open = false; openFirmwareDialog(); });
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
  if (!organRunning) return;
  e.preventDefault();
  e.returnValue = "";   // browser shows its own "leave site?" prompt
});

window.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "BUTTON", "SUMMARY"].includes(e.target.tagName)) return;
  if (document.querySelector("dialog[open]") || state.quitting) return;
  if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
  if (e.key === "c" || e.key === "C") clearBtn.click();
});
window.addEventListener("resize", relayout);

// ---------------------------------------------------------------- init
async function init() {
  applyTheme(document.documentElement.dataset.themePref || "auto");
  buildPeers();
  buildStage();
  restoreWorking();
  relayout();
  backend = await createBackend(onBackendEvent);
  document.body.dataset.mode = backend.kind;
  $("modeName").textContent = backend.kind === "online" ? "online" : "local app";
  quitBtn.hidden = !backend.canQuit;
  $("usbWarning").hidden = backend.usbSupported;
  backend.start();
  refreshPorts();
  refreshPresets();
  // ?debug exposes internals to the browser console (and to tests).
  if (new URLSearchParams(location.search).has("debug")) {
    window.organ = { state, sound, getStage: () => stage, backend };
  }
}
init();
