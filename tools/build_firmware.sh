#!/bin/bash
# Compile both sketches and put the files the web updater flashes into
# app/static/firmware/{sender,receiver}/ (with an ESP Web Tools manifest).
# Run after changing anything in firmware/, then commit the results.
#
# Needs arduino-cli with the esp32 core; the one inside Arduino IDE works.
set -euo pipefail
cd "$(dirname "$0")/.."

CLI="${ARDUINO_CLI:-$(command -v arduino-cli || true)}"
[ -n "$CLI" ] || CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
FQBN="esp32:esp32:esp32"
VERSION=$(sed -n 's/^#define FW_VERSION "\(.*\)"/\1/p' firmware/calum_sender/peers.h)
CORE=$("$CLI" core list | awk '$1 == "esp32:esp32" {print $2}')
DATA=$("$CLI" config dump --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["directories"]["data"])' 2>/dev/null \
       || echo "$HOME/Library/Arduino15")
BOOT_APP0="$DATA/packages/esp32/hardware/esp32/$CORE/tools/partitions/boot_app0.bin"
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

echo "firmware $VERSION, esp32 core $CORE"
for board in sender receiver; do
  name="calum_$board"
  "$CLI" compile --fqbn "$FQBN" --build-path "$BUILD/$name" "firmware/$name" | grep "Sketch uses"
  out="app/static/firmware/$board"
  rm -rf "$out" && mkdir -p "$out"
  cp "$BUILD/$name/$name.ino.bootloader.bin" "$out/bootloader.bin"
  cp "$BUILD/$name/$name.ino.partitions.bin" "$out/partitions.bin"
  cp "$BOOT_APP0" "$out/boot_app0.bin"
  cp "$BUILD/$name/$name.ino.bin" "$out/$name.bin"
  # Offsets are the ones the Arduino IDE uses for a plain ESP32.
  cat > "$out/manifest.json" <<JSON
{
  "name": "Calum Organ $board",
  "version": "$VERSION",
  "new_install_prompt_erase": false,
  "new_install_improv_wait_time": 0,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [
        { "path": "bootloader.bin", "offset": 4096 },
        { "path": "partitions.bin", "offset": 32768 },
        { "path": "boot_app0.bin", "offset": 57344 },
        { "path": "$name.bin", "offset": 65536 }
      ]
    }
  ]
}
JSON
  echo "  -> $out"
done
