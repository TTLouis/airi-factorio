#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${CONTAINER_ROOT:-/data}"
[[ "$ROOT" == /* ]] || { echo '[SGLuna docker] CONTAINER_ROOT must be an absolute path' >&2; exit 78; }

mkdir -p "$ROOT" "$ROOT/.airi" "$ROOT/.airi/tmp" "$ROOT/saves" "$ROOT/data"

SOURCE_REF="unknown"
SOURCE_SHA="unknown"
if [[ -f /opt/airi/SOURCE_REF ]]; then SOURCE_REF="$(cat /opt/airi/SOURCE_REF)"; fi
if [[ -f /opt/airi/SOURCE_SHA ]]; then SOURCE_SHA="$(cat /opt/airi/SOURCE_SHA)"; fi

echo "[SGLuna docker] source=$SOURCE_REF resolved=$SOURCE_SHA data=$ROOT"

export CONTAINER_ROOT="$ROOT"

if (( $# > 0 )); then
  exec "$@"
fi

exec /opt/airi/start-sgluna.sh
