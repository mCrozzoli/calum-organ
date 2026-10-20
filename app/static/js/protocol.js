// Line protocol between the app and the ESP32 sender.
// JavaScript twin of app/protocol.py: same frames, same limits.
//
//   host -> sender:  PAT <tempo> <rows> <cols> <row0bits> ... <rowNbits>
//                    PAT2 <tempo> <rows> <len>/<num>/<den>/<figures> ...   (hub 1.4+)
//                    PLAY   STOP   PING
//   sender -> host:  OK PAT <seq>   ACK <peer> <seq>   NAK <peer> <seq>
//                    OK PLAY   OK STOP   OK READY   PONG   STEP <n>   ERR <reason>

export const MAX_ROWS = 8;
export const MAX_COLS = 32;
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 300;

export class ProtocolError extends Error {}

export function validatePattern(tempo, grid) {
  if (!Number.isInteger(tempo)) throw new ProtocolError(`tempo must be an integer, got ${tempo}`);
  if (tempo < MIN_TEMPO || tempo > MAX_TEMPO) {
    throw new ProtocolError(`tempo ${tempo} out of range [${MIN_TEMPO}, ${MAX_TEMPO}]`);
  }
  if (!Array.isArray(grid) || grid.length < 1 || grid.length > MAX_ROWS) {
    throw new ProtocolError(`rows must be 1..${MAX_ROWS}`);
  }
  const cols = Array.isArray(grid[0]) ? grid[0].length : 0;
  if (cols < 1 || cols > MAX_COLS) throw new ProtocolError(`cols must be 1..${MAX_COLS}`);
  grid.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== cols) {
      throw new ProtocolError(`row ${i} has length ${row && row.length}, expected ${cols}`);
    }
    row.forEach((v, j) => {
      // 0 = off, 1 = on (full); 2..7 = the other figures (rhythm.js)
      if (!Number.isInteger(v) || v < 0 || v > 7) throw new ProtocolError(`cell [${i}][${j}] = ${v}, must be 0..7`);
    });
  });
}

// The 1.3 frame: on/off only (any figure counts as on).
export function encodePattern(tempo, grid) {
  validatePattern(tempo, grid);
  return `PAT ${tempo} ${grid.length} ${grid[0].length} ${grid.map((r) => r.map((v) => (v ? 1 : 0)).join("")).join(" ")}\n`;
}

// The 1.4 frame: per row its length, its rate (num/den of the master beat)
// and its figures (one digit 0..7 per cell).
//   rows: [{len, num, den}] (one per grid row)
export function encodePattern2(tempo, grid, rows) {
  validatePattern(tempo, grid);
  if (!Array.isArray(rows) || rows.length !== grid.length) throw new ProtocolError("one rhythm per row");
  const parts = rows.map((r, i) => {
    const { len, num, den } = r;
    if (!Number.isInteger(len) || len < 1 || len > grid[i].length) throw new ProtocolError(`row ${i} length ${len}`);
    for (const v of [num, den]) {
      if (!Number.isInteger(v) || v < 1 || v > 1000) throw new ProtocolError(`row ${i} rate ${num}/${den}`);
    }
    return `${len}/${num}/${den}/${grid[i].slice(0, len).join("")}`;
  });
  return `PAT2 ${tempo} ${grid.length} ${parts.join(" ")}\n`;
}

export function decodePattern2(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "PAT2" || tokens.length < 4) throw new ProtocolError(`not a PAT2 line: ${line}`);
  const tempo = Number(tokens[1]);
  const n = Number(tokens[2]);
  if (!Number.isInteger(tempo) || !Number.isInteger(n) || tokens.length !== 3 + n) throw new ProtocolError("bad PAT2 header");
  const rows = tokens.slice(3).map((t, i) => {
    const m = /^(\d+)\/(\d+)\/(\d+)\/([0-7]+)$/.exec(t);
    if (!m || m[4].length !== Number(m[1])) throw new ProtocolError(`bad PAT2 row ${i}: ${t}`);
    return { len: Number(m[1]), num: Number(m[2]), den: Number(m[3]), cells: [...m[4]].map(Number) };
  });
  return { tempo, rows };
}

export const encodePlay = () => "PLAY\n";
export const encodeStop = () => "STOP\n";
export const encodePing = () => "PING\n";

export function decodePattern(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "PAT") throw new ProtocolError(`not a PAT line: ${line}`);
  if (tokens.length < 4) throw new ProtocolError(`PAT frame too short: ${line}`);
  const [tempo, rows, cols] = tokens.slice(1, 4).map((t) => Number(t));
  if (![tempo, rows, cols].every(Number.isInteger)) throw new ProtocolError("bad header ints");
  if (tokens.length !== 4 + rows) {
    throw new ProtocolError(`expected ${rows} row payloads, got ${tokens.length - 4}`);
  }
  const grid = tokens.slice(4).map((bits, i) => {
    if (bits.length !== cols) throw new ProtocolError(`row ${i} length ${bits.length} != cols ${cols}`);
    if (!/^[01]+$/.test(bits)) throw new ProtocolError(`row ${i} has non-binary chars: ${bits}`);
    return [...bits].map(Number);
  });
  validatePattern(tempo, grid);
  return { tempo, rows, cols, grid };
}

// PIPE/DUP: the hub found a pipe board (1.2+); INFO: a board describing itself.
const KINDS = new Set(["OK", "ERR", "ACK", "NAK", "PONG", "STEP", "PIPE", "DUP", "INFO"]);

// -> { kind, detail }; kind is "LOG" for anything unrecognised, "" for blank.
export function decodeReply(line) {
  const text = line.trim();
  if (!text) return { kind: "", detail: "" };
  const sp = text.indexOf(" ");
  const head = sp < 0 ? text : text.slice(0, sp);
  const rest = sp < 0 ? "" : text.slice(sp + 1);
  return KINDS.has(head) ? { kind: head, detail: rest } : { kind: "LOG", detail: text };
}
