// Shared between calum_sender and calum_receiver.
//
// Arduino only compiles headers that live inside the sketch folder, so this
// file exists twice: firmware/calum_sender/peers.h and
// firmware/calum_receiver/peers.h. Keep them identical
// (tests/test_firmware.py checks this).
//
// The hub is the board on USB (this repo calls its sketch calum_sender);
// the pipes run calum_receiver. Peer index maps 1:1 to UI row:
//   row 0 -> pipe 0 (A), row 1 -> pipe 1 (B), ...
//
// Since 1.2 each pipe stores its letter in flash (set over USB from the
// app's Boards panel) and announces itself with PKT_HELLO; the hub learns
// which board is which pipe from that. PEER_MACS is only the fallback for
// pipes still running 1.1 (which don't announce).
#pragma once
#include <stdint.h>

// Printed at boot; must match the app version (tests/test_firmware.py).
#define FW_VERSION "1.4.0"
#define FW_CODE    0x0104      // in PKT_HELLO: major << 8 | minor

#define NUM_PEERS 8
#define NO_PIPE   0xFF        // a pipe whose letter hasn't been set

// Calum's pipe boards before 1.2 (fallback, see above).
static const uint8_t PEER_MACS[NUM_PEERS][6] = {
  {0x94, 0xB9, 0x7E, 0xF9, 0x10, 0xF0}, // A
  {0x94, 0xB9, 0x7E, 0xFA, 0xA4, 0xEC}, // B
  {0x94, 0xB9, 0x7E, 0xFA, 0x30, 0x8C}, // C
  {0x4C, 0xEB, 0xD6, 0x75, 0xBB, 0x64}, // D
  {0xC8, 0xF0, 0x9E, 0xF4, 0x9B, 0x8C}, // E
  {0xC8, 0xF0, 0x9E, 0xF4, 0x93, 0xB0}, // F
  {0xC8, 0xF0, 0x9E, 0xF2, 0xB7, 0x10}, // G
  {0x08, 0x3A, 0xF2, 0x7D, 0x2F, 0x1C}, // H
};

static const uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// The sender is the master clock. It unicasts one PKT_PATTERN per peer
// (that peer's row), then broadcasts one PKT_TICK per step to everyone at
// once, so all pipes step together. PKT_STOP closes every valve.
// Pipes broadcast PKT_HELLO (peer = their letter, seq = FW_CODE) every few
// seconds; the hub broadcasts PKT_WHO at boot so they answer right away.
enum : uint8_t {
  PKT_PATTERN = 1,
  PKT_TICK    = 2,
  PKT_STOP    = 3,
  PKT_HELLO   = 4,
  PKT_WHO     = 5,
  PKT_NOTE    = 6,      // live notes: pattern[0] = bit mask of pipes held now
};

#define HELLO_MS 3000

// Live notes: the hub repeats PKT_NOTE this often while any pipe is held;
// a pipe lets go of a live note after NOTE_TIMEOUT_MS without one.
#define NOTE_REPEAT_MS  150
#define NOTE_TIMEOUT_MS 600

// 1.4 changed the packet (figures, rates, step count): boards on 1.3 or
// older ignore it, and 1.4 ignores theirs. Update the hub and every pipe.
#define PIPE_MAGIC 0xC1

// Fixed-size, safe-to-memcpy payload. Fields unused by a packet type are 0.
typedef struct __attribute__((packed)) {
  uint8_t  magic;        // PIPE_MAGIC
  uint8_t  type;         // PKT_*
  uint16_t seq;          // PATTERN: pattern sequence number; HELLO: FW_CODE
  uint16_t tempo;        // master steps per minute (PATTERN and TICK)
  uint16_t steps;        // PATTERN: this pipe's row length (1..32)
  uint16_t rate_num;     // PATTERN: the row runs rate_num/rate_den times
  uint16_t rate_den;     //          as fast as the master beat
  uint8_t  peer;         // PATTERN: destination pipe (0..7); HELLO: own letter or NO_PIPE
  uint8_t  rows;         // TICK: active rows; pipes >= rows stay closed
  uint32_t count;        // TICK: master steps since Play (0, 1, 2, … never wraps)
  uint8_t  pattern[12];  // PATTERN: a figure per cell, 3 bits each (cell 0 = bits 0..2);
                         // NOTE: pattern[0] = bit mask of pipes held live
} PipePacket;

// Figures (what a cell plays within its step), as in app/static/js/rhythm.js.
enum : uint8_t {
  FIG_OFF = 0, FIG_FULL = 1, FIG_DETACHED = 2, FIG_STACCATO = 3,
  FIG_REP2 = 4, FIG_REP3 = 5, FIG_REP4 = 6, FIG_OFFBEAT = 7,
};

static inline uint8_t get_figure(const uint8_t *bits, int cell) {
  int b = cell * 3;
  uint16_t w = bits[b >> 3] | ((b >> 3) + 1 < 12 ? bits[(b >> 3) + 1] << 8 : 0);
  return (w >> (b & 7)) & 7;
}
static inline void set_figure(uint8_t *bits, int cell, uint8_t fig) {
  int b = cell * 3;
  uint16_t w = bits[b >> 3] | ((b >> 3) + 1 < 12 ? bits[(b >> 3) + 1] << 8 : 0);
  w = (w & ~(7 << (b & 7))) | ((fig & 7) << (b & 7));
  bits[b >> 3] = w & 0xFF;
  if ((b >> 3) + 1 < 12) bits[(b >> 3) + 1] = w >> 8;
}

// Is the valve open, for this figure, this far (0..1) into its step?
static inline bool figure_open(uint8_t fig, double phase) {
  switch (fig) {
    case FIG_FULL:     return true;
    case FIG_DETACHED: return phase < 0.85;
    case FIG_STACCATO: return phase < 0.3;
    case FIG_REP2:     return phase * 2 - (int)(phase * 2) < 0.5;
    case FIG_REP3:     return phase * 3 - (int)(phase * 3) < 0.5;
    case FIG_REP4:     return phase * 4 - (int)(phase * 4) < 0.5;
    case FIG_OFFBEAT:  return phase >= 0.5;
    default:           return false;
  }
}

// Receivers stop (valve closed) if ticks stop arriving for this long,
// e.g. sender unplugged. Also at least 3 steps at the current tempo.
#define TICK_TIMEOUT_MS 2000
