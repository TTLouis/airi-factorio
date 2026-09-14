#!/usr/bin/env bash
set -Eeuo pipefail

FACTORIO_BIN="${FACTORIO_ROOT:-/opt/factorio}/bin/x64/factorio"
TEST_ROOT="${TEST_ROOT:-/test}"
RESULTS="$TEST_ROOT/results"
SAVES="$TEST_ROOT/saves"
LANES_ROOT="$TEST_ROOT/lanes"
BASE_SAVE="$SAVES/npc-test-base.zip"
MAP_GEN_SETTINGS="$TEST_ROOT/fixtures/map-gen-settings.json"
LANE_FILTER="${NPC_TEST_LANES:-core,research-combat,resilience}"
GAME_PORT_BASE="${GAME_PORT_BASE:-34197}"
RCON_PORT_BASE="${RCON_PORT_BASE:-27015}"
export PYTHONUNBUFFERED=1

mkdir -p "$RESULTS" "$SAVES"
rm -rf "$RESULTS"/* "$LANES_ROOT"
rm -f "$BASE_SAVE"
mkdir -p "$LANES_ROOT"

finish() {
  local code=$?
  trap - EXIT
  if (( code != 0 )); then
    printf '\n[npc-test] FAILED with exit code %s\n' "$code" >&2
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '[npc-test] Running deterministic Python regressions...\n'
python3 -m unittest discover -s "$TEST_ROOT/runner" -p 'test_*.py' -v \
  >"$RESULTS/runner-unit.log" 2>&1
cat "$RESULTS/runner-unit.log"
printf '[npc-test] Deterministic Python regressions passed.\n'

printf '[npc-test] Creating shared deterministic base save...\n'
if ! "$FACTORIO_BIN" --create "$BASE_SAVE" \
  --map-gen-settings "$MAP_GEN_SETTINGS" \
  >"$RESULTS/create.log" 2>&1; then
  printf '[npc-test] Base save creation failed.\n' >&2
  cat "$RESULTS/create.log" >&2
  exit 1
fi
printf '[npc-test] Base save created successfully.\n'

prepare_lane() {
  local lane="$1"
  local lane_root="$LANES_ROOT/$lane"
  mkdir -p "$lane_root/results"
  cp "$BASE_SAVE" "$lane_root/npc-test.zip"
}

lane_offset() {
  case "$1" in
    core) printf '0' ;;
    research-combat) printf '1' ;;
    resilience) printf '2' ;;
    *) printf '[npc-test] Unknown lane requested: %s\n' "$1" >&2; return 2 ;;
  esac
}

run_lane() {
  local lane="$1"
  local game_port="$2"
  local rcon_port="$3"
  local lane_root="$LANES_ROOT/$lane"
  local lane_save="$lane_root/npc-test.zip"
  local lane_results="$lane_root/results"
  local lane_log="$RESULTS/$lane.log"

  printf '[npc-test] Starting isolated lane: %s\n' "$lane"
  if ! (
    set -o pipefail
    bash "$TEST_ROOT/runner/run_lane.sh" \
      "$lane" "$lane_save" "$lane_results" "$game_port" "$rcon_port" \
      2>&1 | sed -u "s/^/[$lane] /" | tee "$lane_log"
  ); then
    printf '[npc-test] Isolated lane failed: %s\n' "$lane" >&2
    if compgen -G "$lane_results/*-error.txt" >/dev/null; then
      printf '\n[npc-test] ===== %s error files =====\n' "$lane" >&2
      cat "$lane_results"/*-error.txt >&2 || true
    fi
    return 1
  fi
}

IFS=',' read -r -a REQUESTED_LANES <<< "$LANE_FILTER"
LANES=()
for raw_lane in "${REQUESTED_LANES[@]}"; do
  lane="${raw_lane//[[:space:]]/}"
  [[ -n "$lane" ]] || continue
  lane_offset "$lane" >/dev/null
  LANES+=("$lane")
done
if (( ${#LANES[@]} == 0 )); then
  printf '[npc-test] NPC_TEST_LANES selected no runtime lanes.\n' >&2
  exit 2
fi

for lane in "${LANES[@]}"; do
  prepare_lane "$lane"
done

printf '[npc-test] Runtime lane mode: sequential-isolated\n'
printf '[npc-test] Selected lanes: %s\n' "$(IFS=' | '; echo "${LANES[*]}")"

for lane in "${LANES[@]}"; do
  offset="$(lane_offset "$lane")"
  run_lane "$lane" "$((GAME_PORT_BASE + offset))" "$((RCON_PORT_BASE + offset))"
done

printf '[npc-test] PASS: selected isolated runtime lanes completed sequentially: %s\n' "$(IFS=' + '; echo "${LANES[*]}")"
printf '[npc-test] Runtime smoke completed successfully.\n'
