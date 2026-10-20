// Calum Organ v1.3 — ESP32 pipe board (receiver)
//
// Stores its row of the pattern and plays whichever step the sender's
// broadcast TICK says, so all pipes stay locked to one clock. Broadcasts are
// not acknowledged, so a tick can be lost: if one is more than
// TICK_GRACE_MS late, the receiver plays the next step on its own clock and
// the next real tick re-syncs it. If ticks stop for TICK_TIMEOUT_MS (sender
// unplugged, out of range) the valve closes. PKT_STOP closes it immediately.
//
// A new pattern with the same step count is used from the next tick; one
// with a different step count waits for step 0.
//
// Live notes (a MIDI keyboard on the app): PKT_NOTE carries which pipes are
// held right now; the valve is open if the pattern OR a held key says so.
// The hub repeats it while keys are held: if it stops coming for
// NOTE_TIMEOUT_MS, the live note is let go (never a stuck valve).
//
// Which pipe it is (A–H) is stored in flash, so it survives firmware updates
// and power cuts. The board announces itself (PKT_HELLO) so the hub finds it.
// USB serial commands (the app's Boards panel uses them):
//   INFO      -> INFO pipe <A..H|-> fw <version> mac <mac>
//   PIPE <L>  -> OK PIPE <L>     set the letter (PIPE - clears it)
//   TEST      -> OK TEST         opens the valve for 300 ms

#include <WiFi.h>
#include <esp_now.h>
#include <esp_idf_version.h>
#include <Preferences.h>
#include <string.h>
#include "peers.h"

// ---- wiring ---------------------------------------------------------------
static const int RELAY_PIN = 22;
// Most cheap relay boards are active-LOW: driving LOW closes the contact.
// Flip this if your board is active-HIGH.
#define RELAY_ACTIVE LOW
#define RELAY_IDLE   HIGH

// ---- state shared with the Wi-Fi task -------------------------------------
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static PipePacket back = {};          // latest pattern, not yet in use
static bool back_ready = false;
static PipePacket tick = {};          // latest tick, not yet played
static bool tick_ready = false;
static bool stop_req   = false;
static uint8_t  note_mask  = 0;       // latest PKT_NOTE: pipes held live
static bool     note_ready = false;

static bool     who_req   = false;   // the hub asked who's there

// ---- identity -------------------------------------------------------------
static Preferences prefs;
static uint8_t  my_pipe       = NO_PIPE;
static uint32_t next_hello_ms = 0;
static uint32_t test_until_ms = 0;   // valve test running until then (0: none)

// ---- loop-only state ------------------------------------------------------
static PipePacket front = {};         // pattern in use (steps == 0: none)
static bool     running      = false;
static uint32_t last_tick_ms = 0;    // last *real* tick (for the watchdog)
static uint32_t last_play_ms = 0;    // last step played, real or filled in
static PipePacket last_tick  = {};   // last step played
static uint16_t tempo        = 120;
static bool     seq_open     = false;   // the pattern says open
static bool     live_open    = false;   // a held key says open
static uint32_t last_note_ms = 0;

// How late a tick may be before we assume it was lost and fill it in.
// ESP-NOW latency jitter is a few ms; a filled-in step is at most this late.
#define TICK_GRACE_MS 25

static void on_packet(const uint8_t *data, int len) {
  if (len != (int)sizeof(PipePacket)) return;
  const PipePacket *p = (const PipePacket *)data;
  if (p->magic != PIPE_MAGIC) return;
  portENTER_CRITICAL(&g_mux);
  switch (p->type) {
    case PKT_PATTERN:
      // A pipe with a letter only takes its own row (a hub with an old
      // address table could send it another pipe's row).
      if (my_pipe == NO_PIPE || p->peer == my_pipe) { back = *p; back_ready = true; }
      break;
    case PKT_WHO:     who_req = true; break;
    case PKT_TICK:    tick = *p; tick_ready = true; break;
    case PKT_STOP:    stop_req = true; break;
    case PKT_NOTE:    note_mask = p->pattern[0]; note_ready = true; break;
  }
  portEXIT_CRITICAL(&g_mux);
}

// The receive-callback signature changed in ESP-IDF 5 (Arduino-ESP32 3.x).
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
static void on_data_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  on_packet(data, len);
}
#else
static void on_data_recv(const uint8_t *mac, const uint8_t *data, int len) {
  on_packet(data, len);
}
#endif

static void close_valve() { digitalWrite(RELAY_PIN, RELAY_IDLE); }

// The one place the valve is driven: pattern, live key or valve test.
static void apply_valve() {
  bool open = seq_open || live_open || test_until_ms != 0;
  digitalWrite(RELAY_PIN, open ? RELAY_ACTIVE : RELAY_IDLE);
}

// Which row/bit is this pipe? Its letter; a pipe without one goes by the
// row the hub last sent it.
static uint8_t my_index() {
  if (my_pipe != NO_PIPE) return my_pipe;
  return front.steps ? front.peer : NO_PIPE;
}

static char pipe_char() { return my_pipe == NO_PIPE ? '-' : (char)('A' + my_pipe); }

static void send_hello() {
  PipePacket h = {};
  h.magic = PIPE_MAGIC;
  h.type  = PKT_HELLO;
  h.seq   = FW_CODE;
  h.peer  = my_pipe;
  esp_now_send(BROADCAST_MAC, (const uint8_t *)&h, sizeof(PipePacket));
  // A little jitter so pipes powered on together don't keep colliding.
  next_hello_ms = millis() + HELLO_MS + (esp_random() % 500);
}

static void print_info() {
  Serial.printf("INFO pipe %c fw %s mac %s\n", pipe_char(), FW_VERSION, WiFi.macAddress().c_str());
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  close_valve();

  prefs.begin("calum", false);
  uint8_t stored = prefs.getUChar("pipe", NO_PIPE);
  my_pipe = stored < NUM_PEERS ? stored : NO_PIPE;

  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR esp_now_init");
    return;
  }
  esp_now_register_recv_cb(on_data_recv);
  esp_now_peer_info_t bcast = {};
  memcpy(bcast.peer_addr, BROADCAST_MAC, 6);
  esp_now_add_peer(&bcast);           // needed to send PKT_HELLO
  Serial.printf("READY FW calum_receiver %s pipe %c mac %s\n",
                FW_VERSION, pipe_char(), WiFi.macAddress().c_str());
  send_hello();
}

// ---- USB commands -----------------------------------------------------------
static char   cmd_buf[32];
static size_t cmd_len = 0;

static void handle_command(char *line) {
  while (*line == ' ') line++;
  if (strcmp(line, "INFO") == 0) {
    print_info();
  } else if (strncmp(line, "PIPE ", 5) == 0) {
    char c = line[5];
    if (c >= 'a' && c <= 'h') c -= 32;
    if ((c >= 'A' && c <= 'H') || c == '-') {
      my_pipe = c == '-' ? NO_PIPE : (uint8_t)(c - 'A');
      prefs.putUChar("pipe", my_pipe);
      // A new letter means a new row: forget the old one until the hub sends it.
      portENTER_CRITICAL(&g_mux);
      back_ready = false;
      portEXIT_CRITICAL(&g_mux);
      front.steps = 0;
      Serial.printf("OK PIPE %c\n", pipe_char());
      send_hello();                      // tell the hub straight away
    } else {
      Serial.println("ERR pipe letter");
    }
  } else if (strcmp(line, "TEST") == 0) {
    test_until_ms = millis() + 300;
    if (!test_until_ms) test_until_ms = 1;
    apply_valve();
    Serial.println("OK TEST");
  } else if (*line) {
    Serial.println("ERR unknown");
  }
}

static void read_commands() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      cmd_buf[cmd_len] = 0;
      handle_command(cmd_buf);
      cmd_len = 0;
    } else if (cmd_len < sizeof(cmd_buf) - 1) {
      cmd_buf[cmd_len++] = c;
    } else {
      cmd_len = 0;                       // too long: not one of ours
    }
  }
}

static void service_identity() {
  uint32_t now = millis();
  bool asked;
  portENTER_CRITICAL(&g_mux);
  asked = who_req;
  who_req = false;
  portEXIT_CRITICAL(&g_mux);
  // Answer the hub's "who's there" after a random moment (all pipes hear it).
  if (asked) next_hello_ms = now + (esp_random() % 300);
  if ((int32_t)(now - next_hello_ms) >= 0) send_hello();
  if (test_until_ms && (int32_t)(now - test_until_ms) >= 0) {
    test_until_ms = 0;
    apply_valve();
  }
}

static void service_notes() {
  bool fresh;
  uint8_t mask;
  portENTER_CRITICAL(&g_mux);
  fresh = note_ready;
  note_ready = false;
  mask = note_mask;
  portEXIT_CRITICAL(&g_mux);
  uint32_t now = millis();
  bool was = live_open;
  if (fresh) {
    last_note_ms = now;
    uint8_t i = my_index();
    live_open = i < NUM_PEERS && ((mask >> i) & 1);
  } else if (live_open && now - last_note_ms > NOTE_TIMEOUT_MS) {
    live_open = false;                   // the hub stopped repeating: let go
  }
  if (live_open != was) apply_valve();
}

static void play_step(const PipePacket &t) {
  bool swap = false;
  PipePacket next;
  portENTER_CRITICAL(&g_mux);
  if (back_ready && (t.step == 0 || back.steps == front.steps || front.steps == 0)) {
    next = back;
    back_ready = false;
    swap = true;
  }
  portEXIT_CRITICAL(&g_mux);
  if (swap) {
    front = next;
    Serial.printf("pattern seq=%u peer=%u steps=%u\n",
                  (unsigned)front.seq, (unsigned)front.peer, (unsigned)front.steps);
  }

  bool open = false;
  if (front.steps > 0 && front.peer < t.rows) {
    uint16_t s = t.step % front.steps;
    open = (front.pattern[s >> 3] >> (s & 7)) & 1;
  }
  seq_open = open;
  apply_valve();
}

void loop() {
  read_commands();
  service_identity();
  service_notes();

  bool do_stop, have_tick;
  PipePacket t;
  portENTER_CRITICAL(&g_mux);
  do_stop = stop_req;   stop_req = false;
  have_tick = tick_ready; tick_ready = false;
  t = tick;
  portEXIT_CRITICAL(&g_mux);

  uint32_t now = millis();
  if (do_stop) {
    if (running) Serial.println("stop");
    running = false;
    seq_open = false;
    live_open = false;                   // Stop silences everything
    apply_valve();
    return;
  }
  if (have_tick) {
    if (!running) Serial.println("play");
    running = true;
    last_tick_ms = now;
    last_play_ms = now;
    last_tick = t;
    tempo = t.tempo ? t.tempo : 120;
    play_step(t);
    return;
  }
  // Lost tick: play the next step on our own clock, keeping the phase.
  // (If the real tick then arrives late, it just replays the same step.)
  uint32_t step_ms = 60000UL / tempo;
  if (running && front.steps > 0 && now - last_play_ms >= step_ms + TICK_GRACE_MS) {
    PipePacket t2 = last_tick;
    t2.step = (uint16_t)((last_tick.step + 1) % front.steps);
    last_tick = t2;
    last_play_ms += step_ms;
    play_step(t2);
  }
  // Watchdog: no ticks -> sender gone -> never leave a valve open.
  uint32_t three_steps = 3 * (60000UL / tempo);
  uint32_t timeout = three_steps > TICK_TIMEOUT_MS ? three_steps : TICK_TIMEOUT_MS;
  if (running && now - last_tick_ms > timeout) {
    Serial.println("tick timeout, stop");
    running = false;
    seq_open = false;
    apply_valve();
  }
}
