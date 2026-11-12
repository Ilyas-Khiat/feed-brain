#!/usr/bin/env bash
# Starts the Feed Brain server on macOS and Linux. Keep this terminal open while you use the extension.
# (On Windows, double-click start.cmd instead. On a Mac you can double-click start.command.)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "First run on this computer: created server/config.json."
  echo "Set \"vault_path\" to the folder for your vault, save, then run start.sh again."
  if [ "$(uname)" = "Darwin" ] && [ -t 1 ]; then open -t config.json; fi
  exit 0
fi

# Python 3.10 or newer: PYTHON if set, else python3, else python.
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      PY="$candidate"
      break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "Feed Brain needs Python 3.10 or newer."
  echo "  macOS: brew install python   (the python3 that ships with macOS is too old)"
  echo "  Debian/Ubuntu: sudo apt install python3 python3-venv"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating the Python environment..."
  if ! "$PY" -m venv .venv; then
    rm -rf .venv
    echo "Couldn't create it. On Debian/Ubuntu: sudo apt install python3-venv, then run start.sh again."
    exit 1
  fi
fi

# Re-run on every start so new requirements arrive with a git pull (fast when nothing changed).
if ! .venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt; then
  if .venv/bin/python -c "import youtube_transcript_api" 2>/dev/null; then
    echo "Couldn't update the dependencies (offline?). Starting with the ones already installed."
  else
    echo "Couldn't install the dependencies. Check your internet connection, then run start.sh again."
    exit 1
  fi
fi

exec .venv/bin/python brain_server.py
