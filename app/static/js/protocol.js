// Line protocol between the app and the ESP32 sender.
// JavaScript twin of app/protocol.py: same frames, same limits.
//
//   host -> sender:  PAT <tempo> <rows> <cols> <row0bits> ... <rowNbits>
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
      if (v !== 0 && v !== 1) throw new ProtocolError(`cell [${i}][${j}] = ${v}, must be 0 or 1`);
    });
  });
}

export function encodePattern(tempo, grid) {
  validatePattern(tempo, grid);
  return `PAT ${tempo} ${grid.length} ${grid[0].length} ${grid.map((r) => r.join("")).join(" ")}\n`;
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
