#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${PTERODACTYL_IMAGE:-ghcr.io/ptero-eggs/yolks:debian_bookworm}"
FACTORIO_SMOKE_VERSION="${FACTORIO_SMOKE_VERSION:-2.0.77}"
ROOT="$(mktemp -d)"
NAME="airi-ptero-smoke-$RANDOM-$$"
LOG="$ROOT/runtime.log"

cleanup() {
  local code=$?
  trap - EXIT
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf -- "$ROOT"
  exit "$code"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo '[pterodactyl-smoke] docker is required' >&2; exit 1; }
[[ -f "$HERE/install.sh" ]] || { echo '[pterodactyl-smoke] generated install.sh is missing' >&2; exit 1; }

chmod 0777 "$ROOT"
echo '[pterodactyl-smoke] Verifying generated bootstrap payload.'
docker run --rm \
  -v "$HERE/install.sh:/tmp/install.sh:ro" \
  -v "$ROOT:/mnt/server" \
  -e AIRI_INSTALL_ROOT=/mnt/server \
  "$IMAGE" \
  bash /tmp/install.sh --verify-only

echo '[pterodactyl-smoke] Performing clean standalone-NPC installation.'
docker run --rm \
  -v "$HERE/install.sh:/tmp/install.sh:ro" \
  -v "$ROOT:/mnt/server" \
  -e AIRI_INSTALL_ROOT=/mnt/server \
  -e AIRI_ACTOR_MODE=npc \
  -e AIRI_CHAT_PLAYER=SmokeOperator \
  -e FACTORIO_VERSION="$FACTORIO_SMOKE_VERSION" \
  "$IMAGE" \
  bash /tmp/install.sh

[[ -L "$ROOT/start-airi.sh" ]] || { echo '[pterodactyl-smoke] installer did not activate start-airi.sh' >&2; exit 1; }
[[ -x "$ROOT/rollback-airi.sh" ]] || { echo '[pterodactyl-smoke] rollback helper is missing' >&2; exit 1; }
[[ -s "$ROOT/autorio_0.1.0.zip" ]] || { echo '[pterodactyl-smoke] managed client mod is missing' >&2; exit 1; }
[[ -s "$ROOT/airi-config.json" ]] || { echo '[pterodactyl-smoke] airi-config.json is missing' >&2; exit 1; }
! grep -q 'smoke-secret' "$ROOT/airi-config.json" || { echo '[pterodactyl-smoke] provider secret leaked to airi-config.json' >&2; exit 1; }

TARGET="$(readlink -- "$ROOT/start-airi.sh")"
[[ "$TARGET" == .airi/releases/*/start-airi.sh ]] || { echo "[pterodactyl-smoke] unexpected startup target: $TARGET" >&2; exit 1; }
[[ -s "$ROOT/${TARGET%/start-airi.sh}/manifest.json" ]] || { echo '[pterodactyl-smoke] release manifest is missing' >&2; exit 1; }

echo '[pterodactyl-smoke] Starting packaged runtime with zero connected players.'
docker run -d --name "$NAME" \
  -v "$ROOT:/home/container" \
  -e CONTAINER_ROOT=/home/container \
  -e AIRI_ACTOR_MODE=npc \
  -e OPENAI_API_KEY=smoke-secret \
  -e OPENAI_MODEL=smoke-model \
  -e OPENAI_API_BASEURL=https://api.example.invalid/v1 \
  -e SERVER_PORT=34197 \
  "$IMAGE" \
  bash ./start-airi.sh >/dev/null

ready=0
for _ in $(seq 1 180); do
  docker logs "$NAME" > "$LOG" 2>&1 || true
  if grep -q 'AIRI Factorio ready; standalone NPC actor_id=' "$LOG"; then
    ready=1
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" != true ]]; then
    cat "$LOG" >&2
    echo '[pterodactyl-smoke] runtime exited before readiness' >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != 1 ]]; then
  cat "$LOG" >&2
  echo '[pterodactyl-smoke] timed out waiting for standalone-NPC readiness' >&2
  exit 1
fi

echo '[pterodactyl-smoke] Standalone NPC is ready; requesting graceful save/stop.'
docker stop --signal=SIGINT --time=60 "$NAME" >/dev/null
docker logs "$NAME" > "$LOG" 2>&1 || true
cat "$LOG"
grep -q 'AIRI Factorio stopped cleanly' "$LOG" || { echo '[pterodactyl-smoke] clean shutdown acknowledgement missing' >&2; exit 1; }
find "$ROOT/saves" -maxdepth 1 -type f -name '*.zip' -size +0c | grep -q . || { echo '[pterodactyl-smoke] no saved Factorio world was produced' >&2; exit 1; }

echo '[pterodactyl-smoke] PASS: generated egg payload installed, started a zero-player standalone NPC, saved, and stopped cleanly.'
