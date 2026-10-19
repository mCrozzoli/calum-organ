// Prints the ESP's WiFi MAC. Flash to any board whose MAC you need and
// paste the printed address into firmware/calum_sender/peers.h and
// firmware/calum_receiver/peers.h (keep the two copies identical).
#ifdef ESP32
  #include <WiFi.h>
#else
  #include <ESP8266WiFi.h>
#endif

void setup() {
  Serial.begin(115200);
  delay(200);
  WiFi.mode(WIFI_STA);
  Serial.println();
  Serial.print("ESP Board MAC Address: ");
  Serial.println(WiFi.macAddress());
}

void loop() {}
