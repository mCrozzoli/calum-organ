// Calum Organ v1.1 — ESP32 Receiver
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

#include <WiFi.h>
#include <esp_now.h>
#include <esp_idf_version.h>
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

// ---- loop-only state ------------------------------------------------------
static PipePacket front = {};         // pattern in use (steps == 0: none)
static bool     running      = false;
static uint32_t last_tick_ms = 0;    // last *real* tick (for the watchdog)
static uint32_t last_play_ms = 0;    // last step played, real or filled in
static PipePacket last_tick  = {};   // last step played
static uint16_t tempo        = 120;

// How late a tick may be before we assume it was lost and fill it in.
// ESP-NOW latency jitter is a few ms; a filled-in step is at most this late.
#define TICK_GRACE_MS 25

static void on_packet(const uint8_t *data, int len) {
  if (len != (int)sizeof(PipePacket)) return;
  const PipePacket *p = (const PipePacket *)data;
  if (p->magic != PIPE_MAGIC) return;
  portENTER_CRITICAL(&g_mux);
  switch (p->type) {
    case PKT_PATTERN: back = *p; back_ready = true; break;
    case PKT_TICK:    tick = *p; tick_ready = true; break;
    case PKT_STOP:    stop_req = true; break;
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

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  close_valve();

  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR esp_now_init");
    return;
  }
  esp_now_register_recv_cb(on_data_recv);
  // The MAC is what goes in peers.h for this pipe.
  Serial.printf("READY FW calum_receiver %s mac %s\n", FW_VERSION, WiFi.macAddress().c_str());
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
  digitalWrite(RELAY_PIN, open ? RELAY_ACTIVE : RELAY_IDLE);
}

void loop() {
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
    close_valve();
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
    close_valve();
  }
}
