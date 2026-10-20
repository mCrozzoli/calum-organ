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
#define FW_VERSION "1.3.0"
#define FW_CODE    0x0103      // in PKT_HELLO: major << 8 | minor

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

#define PIPE_MAGIC 0xC0

// Fixed-size, safe-to-memcpy payload. Fields unused by a packet type are 0.
typedef struct __attribute__((packed)) {
  uint8_t  magic;        // PIPE_MAGIC
  uint8_t  type;         // PKT_*
  uint16_t seq;          // PATTERN: pattern sequence number; HELLO: FW_CODE
  uint16_t tempo;        // steps per minute (PATTERN and TICK)
  uint16_t steps;        // PATTERN: number of steps (1..32)
  uint16_t step;         // TICK: step to play now (0-based)
  uint8_t  peer;         // PATTERN: destination pipe (0..7); HELLO: own letter or NO_PIPE
  uint8_t  rows;         // TICK: active rows; peers >= rows stay closed
  uint8_t  pattern[4];   // PATTERN: bitfield, LSB = step 0 (32 steps max)
} PipePacket;

// Receivers stop (valve closed) if ticks stop arriving for this long,
// e.g. sender unplugged. Also at least 3 steps at the current tempo.
#define TICK_TIMEOUT_MS 2000
