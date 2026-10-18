#!/bin/bash
# Calum Organ launcher.
#
# The app is a local web app: only Python dep is `pyserial`. There's no
# tkinter, no PyQt6, no native GUI — the UI runs in your browser. So
# the bootstrap is tiny and works on any Python 3.9+ regardless of Tk.

set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
APP_VENV_PY=".venv/bin/python"

if [ ! -d .venv ] || [ ! -x "$APP_VENV_PY" ]; then
  echo "[Organ] one-time setup (about 15 seconds)..."
  if ! command -v "$PY" >/dev/null 2>&1; then
    echo "ERROR: no python3 found. Install from https://www.python.org/downloads/"
    exit 1
  fi
  rm -rf .venv
  "$PY" -m venv .venv
  "$APP_VENV_PY" -m pip install --upgrade pip >/dev/null
  "$APP_VENV_PY" -m pip install pyserial
  echo "[Organ] ready."
fi

exec "$APP_VENV_PY" -m app
