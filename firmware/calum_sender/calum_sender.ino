// Calum Organ v1.1 — ESP32 Sender (master clock)
//
// Parses a line-based protocol from USB serial, unicasts each grid row to
// its ESP-NOW receiver (with retry), and while playing broadcasts one TICK
// per step so every pipe steps on the same beat.
//
// Protocol (see ../../app/protocol.py for the canonical spec):
//   host -> sender:  PAT <tempo> <rows> <cols> <row0bits> ... <rowNbits>\n
//                    PLAY\n  STOP\n  PING\n
//   sender -> host:  OK PAT <seq>  ACK <peer> <seq>  NAK <peer> <seq>
//                    OK PLAY  OK STOP  PONG  STEP <n>  ERR <reason>
//
// PAT is accepted immediately (OK PAT) and delivered in the background;
// ACK/NAK lines follow per peer. A new tempo applies on the next step. A new
// pattern with the same step count applies on the next step; a different
// step count waits for the bar to wrap so the rhythm stays musical.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_idf_version.h>
#include <string.h>
#include "peers.h"

#define SERIAL_BAUD   115200
#define LINE_BUF_SIZE 1024
#define MAX_ATTEMPTS  3
#define STOP_REPEATS  3

static char   line_buf[LINE_BUF_SIZE];
static size_t line_len = 0;
static uint16_t g_seq = 0;

// ---- delivery state (bits per peer) ----------------------------------------
// Written from the Wi-Fi task (send callback) and loop(), so guard with a lock.
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static PipePacket peer_pkt[NUM_PEERS];
static uint8_t  attempts[NUM_PEERS];
static uint8_t  inflight_mask = 0;   // sent, waiting for callback
static uint8_t  retry_mask    = 0;   // failed, should be resent
static volatile uint32_t ack_lines = 0;   // callback -> loop: lines to print
static char     cb_lines[NUM_PEERS * 2][24];

// ---- clock -----------------------------------------------------------------
static bool     running      = false;
static uint16_t tempo        = 120;
static uint16_t cur_steps    = 0;    // steps in the bar being played
static uint16_t next_steps   = 0;    // steps of the most recent pattern
static uint8_t  active_rows  = 0;
static uint16_t cur_step     = 0;
static uint32_t next_tick_ms = 0;

static uint32_t step_ms() { return 60000UL / (tempo ? tempo : 120); }

static int peer_index(const uint8_t *mac) {
  for (int i = 0; i < NUM_PEERS; i++) {
    if (memcmp(mac, PEER_MACS[i], 6) == 0) return i;
  }
  return -1;
}

static void handle_send_status(const uint8_t *mac, esp_now_send_status_t status) {
  int idx = peer_index(mac);
  if (idx < 0) return;   // broadcast ticks/stops: no ACK in ESP-NOW
  portENTER_CRITICAL(&g_mux);
  inflight_mask &= ~(1 << idx);
  bool ok = (status == ESP_NOW_SEND_SUCCESS);
  if (!ok && attempts[idx] < MAX_ATTEMPTS) {
    retry_mask |= (1 << idx);
  } else if (ack_lines < NUM_PEERS * 2) {
    // Final outcome: report it from loop() (Serial is not ISR/callback safe).
    snprintf(cb_lines[ack_lines], sizeof(cb_lines[0]), "%s %d %u",
             ok ? "ACK" : "NAK", idx, (unsigned)peer_pkt[idx].seq);
    ack_lines++;
  }
  portEXIT_CRITICAL(&g_mux);
}

// The send-callback signature changed in ESP-IDF 5.5 (Arduino-ESP32 3.3+).
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
static void on_send_status(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  handle_send_status(info->des_addr, status);
}
#else
static void on_send_status(const uint8_t *mac, esp_now_send_status_t status) {
  handle_send_status(mac, status);
}
#endif

static void add_peer(const uint8_t *mac) {
  esp_now_peer_info_t info = {};
  info.channel = 0;
  info.encrypt = false;
  memcpy(info.peer_addr, mac, 6);
  if (!esp_now_is_peer_exist(info.peer_addr) && esp_now_add_peer(&info) != ESP_OK) {
    Serial.println("ERR add_peer");
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(50);
  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR esp_now_init");
    return;
  }
  esp_now_register_send_cb(on_send_status);
  for (int i = 0; i < NUM_PEERS; i++) add_peer(PEER_MACS[i]);
  add_peer(BROADCAST_MAC);
  Serial.printf("FW calum_sender %s mac %s\n", FW_VERSION, WiFi.macAddress().c_str());
  Serial.println("OK READY");
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------
static void send_to_peer(int idx) {
  portENTER_CRITICAL(&g_mux);
  attempts[idx]++;
  inflight_mask |= (1 << idx);
  retry_mask &= ~(1 << idx);
  portEXIT_CRITICAL(&g_mux);
  if (esp_now_send(PEER_MACS[idx], (const uint8_t *)&peer_pkt[idx], sizeof(PipePacket)) != ESP_OK) {
    // Queue full or similar: no callback will come, so retry from loop().
    handle_send_status(PEER_MACS[idx], ESP_NOW_SEND_FAIL);
  }
}

static void service_delivery() {
  uint8_t todo;
  portENTER_CRITICAL(&g_mux);
  todo = retry_mask;
  portEXIT_CRITICAL(&g_mux);
  for (int i = 0; i < NUM_PEERS; i++) {
    if (todo & (1 << i)) send_to_peer(i);
  }

  char lines[NUM_PEERS * 2][24];
  uint32_t n;
  portENTER_CRITICAL(&g_mux);
  n = ack_lines;
  memcpy(lines, cb_lines, sizeof(lines));
  ack_lines = 0;
  portEXIT_CRITICAL(&g_mux);
  for (uint32_t i = 0; i < n; i++) Serial.println(lines[i]);
}

static void broadcast(const PipePacket &pkt) {
  esp_now_send(BROADCAST_MAC, (const uint8_t *)&pkt, sizeof(PipePacket));
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------
static void service_clock() {
  if (!running) return;
  uint32_t now = millis();
  if ((int32_t)(now - next_tick_ms) < 0) return;

  if (cur_step == 0) cur_steps = next_steps;   // new step count starts a bar

  PipePacket tick = {};
  tick.magic = PIPE_MAGIC;
  tick.type  = PKT_TICK;
  tick.tempo = tempo;
  tick.step  = cur_step;
  tick.rows  = active_rows;
  broadcast(tick);
  Serial.printf("STEP %u\n", (unsigned)cur_step);

  cur_step = (cur_step + 1 >= cur_steps) ? 0 : cur_step + 1;
  next_tick_ms += step_ms();
  // If we fell far behind (e.g. a long serial burst), don't play catch-up.
  if ((int32_t)(now - next_tick_ms) > (int32_t)step_ms()) next_tick_ms = now + step_ms();
}

static void stop_all() {
  running = false;
  PipePacket stop = {};
  stop.magic = PIPE_MAGIC;
  stop.type  = PKT_STOP;
  // Broadcasts are not acknowledged; repeat so a dropped frame can't leave
  // a valve open (receivers also time out on their own).
  for (int i = 0; i < STOP_REPEATS; i++) {
    broadcast(stop);
    delay(2);
  }
}

// ---------------------------------------------------------------------------
// line parsing
// ---------------------------------------------------------------------------
static void handle_line(char *line);

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line_buf[line_len] = 0;
      handle_line(line_buf);
      line_len = 0;
    } else if (line_len < LINE_BUF_SIZE - 1) {
      line_buf[line_len++] = c;
    } else {
      line_len = 0;  // overflow: drop line
      Serial.println("ERR line overflow");
    }
    service_clock();   // keep time even during a long burst of input
  }
  service_clock();
  service_delivery();
}

// Simple space-tokenizer that mutates the buffer.
static int tokenize(char *line, char **tokens, int max_tokens) {
  int n = 0;
  char *p = line;
  while (*p && n < max_tokens) {
    while (*p == ' ') p++;
    if (!*p) break;
    tokens[n++] = p;
    while (*p && *p != ' ') p++;
    if (*p) { *p = 0; p++; }
  }
  return n;
}

static void handle_pat(int argc, char **argv) {
  if (argc < 4) { Serial.println("ERR PAT short"); return; }
  int t     = atoi(argv[1]);
  int rows  = atoi(argv[2]);
  int cols  = atoi(argv[3]);
  if (t < 20 || t > 300)               { Serial.println("ERR tempo"); return; }
  if (rows < 1 || rows > NUM_PEERS)    { Serial.println("ERR rows"); return; }
  if (cols < 1 || cols > 32)           { Serial.println("ERR cols"); return; }
  if (argc != 4 + rows)                { Serial.println("ERR row count"); return; }

  // Validate everything before touching state.
  PipePacket pkts[NUM_PEERS] = {};
  for (int row = 0; row < rows; row++) {
    const char *bits = argv[4 + row];
    if ((int)strlen(bits) != cols) { Serial.println("ERR bits len"); return; }
    for (int j = 0; j < cols; j++) {
      if (bits[j] == '1')      pkts[row].pattern[j >> 3] |= (uint8_t)(1 << (j & 7));
      else if (bits[j] != '0') { Serial.println("ERR bit char"); return; }
    }
  }

  g_seq = (g_seq + 1) & 0xFFFF;
  tempo       = (uint16_t)t;
  next_steps  = (uint16_t)cols;
  active_rows = (uint8_t)rows;
  if (!running) cur_steps = next_steps;

  for (int row = 0; row < rows; row++) {
    pkts[row].magic = PIPE_MAGIC;
    pkts[row].type  = PKT_PATTERN;
    pkts[row].seq   = g_seq;
    pkts[row].tempo = tempo;
    pkts[row].steps = (uint16_t)cols;
    pkts[row].peer  = (uint8_t)row;
    portENTER_CRITICAL(&g_mux);
    peer_pkt[row] = pkts[row];
    attempts[row] = 0;
    portEXIT_CRITICAL(&g_mux);
    send_to_peer(row);
  }
  Serial.printf("OK PAT %u\n", (unsigned)g_seq);
}

static void handle_play() {
  if (next_steps == 0) { Serial.println("ERR no pattern"); return; }
  running      = true;
  cur_step     = 0;
  cur_steps    = next_steps;
  next_tick_ms = millis();   // first tick right away
  Serial.println("OK PLAY");
}

static void handle_line(char *line) {
  if (!*line) return;
  char *argv[16];
  int argc = tokenize(line, argv, 16);
  if (argc == 0) return;
  if (strcmp(argv[0], "PAT") == 0)       handle_pat(argc, argv);
  else if (strcmp(argv[0], "PLAY") == 0) handle_play();
  else if (strcmp(argv[0], "STOP") == 0) { stop_all(); Serial.println("OK STOP"); }
  else if (strcmp(argv[0], "PING") == 0) Serial.println("PONG");
  else                                   Serial.println("ERR unknown");
}
