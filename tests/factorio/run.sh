#!/usr/bin/env bash
set -Eeuo pipefail

FACTORIO_BIN="${FACTORIO_ROOT:-/opt/factorio}/bin/x64/factorio"
SAVE="${TEST_ROOT:-/test}/saves/npc-test.zip"
RESULTS="${TEST_ROOT:-/test}/results"
SERVER_SETTINGS="${TEST_ROOT:-/test}/fixtures/server-settings.json"
RCON_PORT="${RCON_PORT:-27015}"
RCON_PASSWORD="${RCON_PASSWORD:-airi-test}"
FACTORIO_PID=""
export PYTHONUNBUFFERED=1

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
  cleanup
  if (( code != 0 )); then
    printf '\n[npc-test] FAILED with exit code %s\n' "$code" >&2
    print_file "$SERVER_SETTINGS"
    print_file "$RESULTS/runner-unit.log"
    print_file "$RESULTS/create.log"
    print_file "$RESULTS/factorio.log"
    print_file "$RESULTS/factorio-restart.log"
    print_file "$RESULTS/simulation-clock.json"
    print_file "$RESULTS/runner-error.txt"
    print_file "$RESULTS/runner-transcript.json"
    print_file "$RESULTS/runner.json"
    print_file "$RESULTS/placement-transfer-error.txt"
    print_file "$RESULTS/placement-transfer-transcript.json"
    print_file "$RESULTS/placement-transfer.json"
    print_file "$RESULTS/control-lifecycle-error.txt"
    print_file "$RESULTS/control-lifecycle-transcript.json"
    print_file "$RESULTS/control-lifecycle-observations.json"
    print_file "$RESULTS/control-lifecycle.json"
    print_file "$RESULTS/research-error.txt"
    print_file "$RESULTS/research-transcript.json"
    print_file "$RESULTS/research.json"
    print_file "$RESULTS/combat-error.txt"
    print_file "$RESULTS/combat-transcript.json"
    print_file "$RESULTS/combat.json"
    print_file "$RESULTS/persistence-prepare-error.txt"
    print_file "$RESULTS/persistence-prepare-transcript.json"
    print_file "$RESULTS/persistence-before.json"
    print_file "$RESULTS/persistence-verify-error.txt"
    print_file "$RESULTS/persistence-verify-transcript.json"
    print_file "$RESULTS/persistence.json"
    print_file "$RESULTS/death-recovery-error.txt"
    print_file "$RESULTS/death-recovery-transcript.json"
    print_file "$RESULTS/death-recovery.json"
    print_file "$RESULTS/navigation-error.txt"
    print_file "$RESULTS/navigation-transcript.json"
    print_file "$RESULTS/navigation.json"
    print_file "$RESULTS/crafting-error.txt"
    print_file "$RESULTS/crafting-transcript.json"
    print_file "$RESULTS/crafting.json"
  fi
  exit "$code"
}
trap finish EXIT

start_factorio() {
  local logfile="$1"
  "$FACTORIO_BIN" --start-server "$SAVE" \
    --server-settings "$SERVER_SETTINGS" \
    --rcon-port "$RCON_PORT" \
    --rcon-password "$RCON_PASSWORD" \
    >"$logfile" 2>&1 &
  FACTORIO_PID=$!

  # Catch startup failures immediately instead of waiting for the RCON retry timeout.
  sleep 0.5
  if ! kill -0 "$FACTORIO_PID" 2>/dev/null; then
    wait "$FACTORIO_PID" || true
    echo '[npc-test] Factorio exited before RCON became available.' >&2
    exit 1
  fi
}

printf '[npc-test] Running deterministic Python runner regressions...\n'
python3 -m unittest discover -s "${TEST_ROOT:-/test}/runner" -p 'test_*.py' -v \
  >"$RESULTS/runner-unit.log" 2>&1
cat "$RESULTS/runner-unit.log"

printf '[npc-test] Creating deterministic Factorio save...\n'
"$FACTORIO_BIN" --create "$SAVE" \
  --map-gen-settings "${TEST_ROOT:-/test}/fixtures/map-gen-settings.json" \
  >"$RESULTS/create.log" 2>&1
printf '[npc-test] Save created successfully.\n'

printf '[npc-test] Starting Factorio with auto_pause=false and private server settings...\n'
start_factorio "$RESULTS/factorio.log"
printf '[npc-test] Factorio started (pid=%s); checking clock and core NPC actions...\n' "$FACTORIO_PID"

python3 "${TEST_ROOT:-/test}/runner/run.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Core NPC smoke passed; running placement + inventory transfer...\n'
python3 "${TEST_ROOT:-/test}/runner/placement_transfer.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Gameplay passed; checking physical stop and cancellation...\n'
python3 "${TEST_ROOT:-/test}/runner/control_lifecycle.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Lifecycle passed; checking research submission and native labs...\n'
python3 "${TEST_ROOT:-/test}/runner/research.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Research passed; checking bounded real combat and failure semantics...\n'
python3 "${TEST_ROOT:-/test}/runner/combat.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Combat passed; saving active NPC work for a real server restart...\n'
python3 "${TEST_ROOT:-/test}/runner/persistence_prepare.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS" \
  --save "$SAVE"

printf '[npc-test] Save persisted; stopping the first Factorio process...\n'
kill "$FACTORIO_PID"
wait "$FACTORIO_PID" 2>/dev/null || true
FACTORIO_PID=""
sleep 0.5

printf '[npc-test] Restarting Factorio from the saved active-NPC state...\n'
start_factorio "$RESULTS/factorio-restart.log"
printf '[npc-test] Factorio restarted (pid=%s); checking NPC reacquisition and load reconciliation...\n' "$FACTORIO_PID"

python3 "${TEST_ROOT:-/test}/runner/persistence_verify.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Persistence passed; killing the active NPC to verify bounded recovery...\n'
python3 "${TEST_ROOT:-/test}/runner/death_recovery.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Death recovery passed; checking bounded navigation and stale-path safety...\n'
python3 "${TEST_ROOT:-/test}/runner/navigation.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Navigation passed; checking owned native crafting and cancellation...\n'
python3 "${TEST_ROOT:-/test}/runner/crafting.py" \
  --host 127.0.0.1 \
  --port "$RCON_PORT" \
  --password "$RCON_PASSWORD" \
  --results "$RESULTS"

printf '[npc-test] Runtime smoke completed successfully.\n'