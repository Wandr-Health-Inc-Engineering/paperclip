#!/bin/bash
# Tethr Command Center — double-clickable launcher.
# Starts the local server (if not already running) and opens the dashboard.
# Reads the 00 Tethr Google Drive folder directly. Requires Node >= 20.
cd "$(dirname "$0")"
PORT="${TETHR_CC_PORT:-4848}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node >= 20 (https://nodejs.org), then try again."
  read -r -p "Press return to close." _
  exit 1
fi

if curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/api/tree"; then
  echo "Already running — opening the dashboard."
else
  echo "Starting Tethr Command Center…"
  nohup node server.mjs > server.log 2>&1 &
  for i in $(seq 1 30); do
    sleep 0.3
    curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/api/tree" && break
  done
fi

open "http://localhost:$PORT"
