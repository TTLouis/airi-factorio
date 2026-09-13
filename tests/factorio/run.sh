#!/usr/bin/env bash
set -euo pipefail

FACTORIO_BIN="${FACTORIO_ROOT:-/opt/factorio}/bin/x64/factorio"
SAVE="${TEST_ROOT:-/test}/saves/npc-test.zip"
RESULTS="${TEST_ROOT:-/test}/results"
RCON_PORT="${RCON_PORT:-27015}"
RCON_PASSWORD="${RCON_PASSWORD:-airi-test}"

mkdir -p "$(dirname "$SAVE")" "$RESULTS"
rm -f "$SAVE" "$RESULTS"/*

"$FACTORIO_BIN" --create "$SAVE" \
  --map-gen-settings "${TEST_ROOT:-/test}/fixtures/map-gen-settings.json" \
  >"$RESULTS/create.log" 2>&1

"$FACTORIO_BIN" --start-server "$SAVE" \
  --rcon-port "$RCON_PORT" \
  --rcon-password "$RCON_PASSWORD" \
  >"$RESULTS/factorio.log" 2>&1 &
FACTORIO_PID=$!

cleanup() {
  if kill -0 "$FACTORIO_PID" 2>/dev/null; then
    kill "$FACTORIO_PID" 2>/dev/null || true
    wait "$FACTORIO_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

python3 "${TEST_ROOT:-/test}/runner/run.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"
