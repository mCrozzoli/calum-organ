// Boards panel: set up the organ's ESP32 boards one at a time over USB.
//
//   hub    the board that stays plugged into the computer (sketch calum_sender)
//   pipe   one board per pipe, A–H (sketch calum_receiver)
//
// Plug a board in, and the panel asks it what it is (it reboots it and reads
// its first line, then asks INFO). From there: install the hub or pipe
// firmware (esptool-js, the flasher ESP Web Tools is built on), give a pipe
// its letter (stored on the board, so the hub finds it by itself), and click
// a pipe's valve to check the wiring.

export const LETTERS = "ABCDEFGH";
const BAUD = 115200;
// Loaded only when installing, so the app itself needs no CDN.
const ESPTOOL = "https://unpkg.com/esptool-js@0.5.7/bundle.js";
const FIRMWARE = { hub: "firmware/sender/", pipe: "firmware/receiver/" };
const CONNECT_MS = 25000;

// ---------------------------------------------------------------- pure parts
// What a board said about itself (boot line and/or INFO reply) -> description.
//   kind: "hub" | "pipe" | null (no Calum Organ firmware answered)
//   fw:   "1.2.0" | null      pipe: 0..7 | null (not set, or 1.1: unknown)
//   letters: 1.2+ pipes store their letter; 1.1 pipes were set by the hub's table
export function parseBoard(lines) {
  const out = { kind: null, fw: null, pipe: null, mac: null, letters: false };
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^INFO hub fw (\S+) mac (\S+)/))) {
      Object.assign(out, { kind: "hub", fw: m[1], mac: m[2] });
    } else if ((m = line.match(/^INFO pipe (\S) fw (\S+) mac (\S+)/))) {
      Object.assign(out, { kind: "pipe", fw: m[2], mac: m[3], letters: true, pipe: letterIndex(m[1]) });
    } else if ((m = line.match(/FW calum_sender (\S+)(?: mac (\S+))?/))) {
      Object.assign(out, { kind: "hub", fw: m[1], mac: m[2] || out.mac });
    } else if ((m = line.match(/FW calum_receiver (\S+)(?: pipe (\S))?(?: mac (\S+))?/))) {
      Object.assign(out, { kind: "pipe", fw: m[1], mac: m[3] || out.mac });
      if (m[2] !== undefined) Object.assign(out, { letters: true, pipe: letterIndex(m[2]) });
    }
  }
  return out;
}

const letterIndex = (c) => (LETTERS.includes(c) ? LETTERS.indexOf(c) : null);

// "1.10.0" > "1.9.2": compare numerically, part by part.
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The letter to offer a new pipe: the first one the hub doesn't hear yet.
// heard: [{mac, fw} | null] x 8, from the hub's PIPE lines.
export function suggestLetter(heard, mac = null) {
  const mine = heard.findIndex((b) => b && mac && sameMac(b.mac, mac));
  if (mine >= 0) return mine;
  const free = heard.findIndex((b) => !b);
  if (free >= 0) return free;
  const old = heard.findIndex((b) => b.fw === "old");     // still on 1.1: about to be replaced
  return old >= 0 ? old : 0;
}

export const sameMac = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

// What to do with this board, given what it is and what the person chose.
export function plan(board, role, pipe, latest) {
  const firmwareOk = board.kind === role && compareVersions(board.fw, latest) >= 0;
  return {
    install: !firmwareOk,
    setLetter: role === "pipe" && firmwareOk && board.letters && board.pipe !== pipe,
    canTest: board.kind === "pipe" && board.letters,
  };
}

// ---------------------------------------------------------------- serial
// Open the port, optionally reboot the board, optionally send one command,
// and collect lines until `done(lines)` is true or the time runs out.
async function talk(port, { reset = false, send = null, sendAfterMs = 0, done = () => false, timeoutMs = 2500 }) {
  await port.open({ baudRate: BAUD });
  const lines = [];
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
        }
        if (done(lines)) { finished = true; break; }
      }
    } catch (_) { /* port closed under us */ }
  })();
  try {
    if (reset) {
      // EN low (RTS) with IO0 high (DTR off): the board restarts and runs.
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(120);
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    }
    if (send) {
      await sleep(sendAfterMs);
      const writer = port.writable.getWriter();
      await writer.write(new TextEncoder().encode(send));
      writer.releaseLock();
    }
    const until = Date.now() + timeoutMs;
    while (!finished && Date.now() < until) await sleep(50);
  } finally {
    try { await reader.cancel(); } catch (_) {}
    await reading;
    reader.releaseLock();
    await port.close();
  }
  return lines;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask a board what it is: reboot it (boot line), then INFO (1.2+ answers).
export async function inspect(port) {
  const lines = await talk(port, {
    reset: true, send: "INFO\n", sendAfterMs: 1200, timeoutMs: 2600,
    done: (ls) => ls.some((l) => l.startsWith("INFO ")),
  });
  return { ...parseBoard(lines), lines };
}

async function command(port, text, expect) {
  // Opening the port can restart some boards: if the first try isn't
  // answered, wait for it to boot and try once more.
  for (const wait of [100, 1500]) {
    const lines = await talk(port, {
      send: `${text}\n`, sendAfterMs: wait, timeoutMs: wait + 1200,
      done: (ls) => ls.some((l) => l.startsWith(expect) || l.startsWith("ERR")),
    });
    const reply = lines.find((l) => l.startsWith(expect) || l.startsWith("ERR"));
    if (reply?.startsWith(expect)) return reply;
    if (reply) throw new Error(reply.replace(/^ERR\s*/, "the board said: "));
  }
  throw new Error("the board didn't answer");
}

export const setPipeLetter = (port, pipe) => command(port, `PIPE ${LETTERS[pipe]}`, `OK PIPE ${LETTERS[pipe]}`);
export const testValve = (port) => command(port, "TEST", "OK TEST");

// Install the hub or pipe firmware (the files the updater publishes).
// The letter (pipe) is kept: it lives in a part of the flash this doesn't touch.
export async function install(port, role, { onProgress = () => {}, onLog = () => {} } = {}) {
  const base = FIRMWARE[role];
  const manifest = await (await fetch(`${base}manifest.json`, { cache: "no-store" })).json();
  const parts = manifest.builds[0].parts;
  const images = [];
  for (const part of parts) {
    const r = await fetch(base + part.path, { cache: "no-store" });
    if (!r.ok) throw new Error(`couldn't download ${part.path}`);
    images.push({ address: part.offset, bytes: new Uint8Array(await r.arrayBuffer()) });
  }
  let esptool;
  try {
    esptool = await import(ESPTOOL);
  } catch (_) {
    throw new Error("couldn't load the flasher (are you online?)");
  }
  const terminal = {
    clean() {},
    writeLine: (t) => onLog(t),
    write: (t) => onLog(t),
  };
  const transport = new esptool.Transport(port, false);
  const loader = new esptool.ESPLoader({ transport, baudrate: 460800, romBaudrate: BAUD, terminal });
  try {
    // A board that never answers would keep esptool trying for minutes.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Failed to connect: no answer from the board's bootloader")), CONNECT_MS);
    });
    try {
      onLog(`chip: ${await Promise.race([loader.main(), timeout])}`);
    } finally {
      clearTimeout(timer);
    }
    const family = loader.chip?.CHIP_NAME;
    if (family !== "ESP32") throw new Error(`this is an ${family}: the organ's firmware is for a plain ESP32`);
    const total = images.reduce((n, im) => n + im.bytes.length, 0);
    const before = images.map((_, i) => images.slice(0, i).reduce((n, im) => n + im.bytes.length, 0));
    await loader.writeFlash({
      fileArray: images.map((im) => ({ address: im.address, data: loader.ui8ToBstr(im.bytes) })),
      flashSize: "keep", flashMode: "keep", flashFreq: "keep",
      eraseAll: false, compress: true,
      reportProgress: (i, written, size) => onProgress((before[i] + written * (images[i].bytes.length / size)) / total),
    });
    await loader.after("hard_reset");
  } finally {
    // After a failed connect esptool can still be reading: don't wait forever.
    await Promise.race([transport.disconnect().catch(() => {}), sleep(3000)]);
    if (port.readable || port.writable) { try { await port.close(); } catch (_) {} }
  }
  return manifest.version;
}

export async function latestVersion() {
  const m = await (await fetch(`${FIRMWARE.hub}manifest.json`, { cache: "no-store" })).json();
  return m.version;
}
