#!/usr/bin/env bash
set -Eeuo pipefail

FACTORIO_BIN="${FACTORIO_ROOT:-/opt/factorio}/bin/x64/factorio"
SAVE="${TEST_ROOT:-/test}/saves/npc-test.zip"
RESULTS="${TEST_ROOT:-/test}/results"
RCON_PORT="${RCON_PORT:-27015}"
RCON_PASSWORD="${RCON_PASSWORD:-airi-test}"
FACTORIO_PID=""

mkdir -p "$(dirname "$SAVE")" "$RESULTS"
rm -f "$SAVE" "$RESULTS"/*

print_file() {
  local file="$1"
  if [[ -s "$file" ]]; then
    printf '\n===== %s =====\n' "$(basename "$file")" >&2
    cat "$file" >&2
  fi
}

cleanup() {
  if [[ -n "$FACTORIO_PID" ]] && kill -0 "$FACTORIO_PID" 2>/dev/null; then
    kill "$FACTORIO_PID" 2>/dev/null || true
    wait "$FACTORIO_PID" 2>/dev/null || true
  fi
}

finish() {
  local code=$?
  trap - EXIT
  if (( code != 0 )); then
    printf '\n[npc-test] FAILED with exit code %s\n' "$code" >&2
    print_file "$RESULTS/create.log"
    print_file "$RESULTS/factorio.log"
    print_file "$RESULTS/runner-error.txt"
    print_file "$RESULTS/runner.json"
  fi
  cleanup
  exit "$code"
}
trap finish EXIT

printf '[npc-test] Creating deterministic Factorio save...\n'
"$FACTORIO_BIN" --create "$SAVE" \
  --map-gen-settings "${TEST_ROOT:-/test}/fixtures/map-gen-settings.json" \
  >"$RESULTS/create.log" 2>&1
printf '[npc-test] Save created successfully.\n'

printf '[npc-test] Starting Factorio headless server with RCON...\n'
"$FACTORIO_BIN" --start-server "$SAVE" \
  --rcon-port "$RCON_PORT" \
  --rcon-password "$RCON_PASSWORD" \
  >"$RESULTS/factorio.log" 2>&1 &
FACTORIO_PID=$!

# Catch startup failures immediately instead of waiting for the RCON retry timeout.
sleep 0.5
if ! kill -0 "$FACTORIO_PID" 2>/dev/null; then
  wait "$FACTORIO_PID" || true
  echo '[npc-test] Factorio exited before RCON became available.' >&2
  exit 1
fi

printf '[npc-test] Factorio started (pid=%s); running zero-player NPC smoke...\n' "$FACTORIO_PID"
python3 "${TEST_ROOT:-/test}/runner/run.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Runtime smoke completed successfully.\n'
