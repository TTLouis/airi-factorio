#!/usr/bin/env bash
# Generated AIRI Factorio standalone-NPC v8 Pterodactyl bootstrap.
# Source of truth: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
BOOT_DIR=""
EXPECTED_SOURCE_SHA256="10e02b49d10ed71feff7f66ef7e485837c61fff605e07fc5bef1ce92ab521979"
EXPECTED_SOURCE_BYTES="14031"
EXPECTED_ARCHIVE_SHA256="226c930ed7a5095ffff7c31331e183582a13f45a7d7a2b373d4cbbaf33c7f005"
log() { printf '[AIRI bootstrap] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 78; }
cleanup() { local code=$?; trap - EXIT; [[ -z "$BOOT_DIR" || ! -d "$BOOT_DIR" ]] || rm -rf -- "$BOOT_DIR"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for tool in awk base64 gzip sha256sum mktemp wc bash mkdir rm; do command -v "$tool" >/dev/null || fail "Missing bootstrap tool: $tool"; done
ROOT="${AIRI_INSTALL_ROOT:-/mnt/server}"
[[ "$ROOT" == /* && "$ROOT" != / ]] || fail 'Installer root must be an absolute directory other than /.'
mkdir -p -- "$ROOT"
BOOT_DIR="$(mktemp -d "$ROOT/.airi-bootstrap.XXXXXX")"
PAYLOAD="$BOOT_DIR/installer.b64"
ARCHIVE="$BOOT_DIR/installer.sh.gz"
INSTALLER="$BOOT_DIR/installer.sh"
cat > "$PAYLOAD" <<'AIRI_PAYLOAD'
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
AIRI_PAYLOAD
base64 -d "$PAYLOAD" > "$ARCHIVE" || fail 'Payload base64 decode failed'
[[ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" == "$EXPECTED_ARCHIVE_SHA256" ]] || fail 'Compressed payload checksum mismatch'
gzip -dc "$ARCHIVE" > "$INSTALLER" || fail 'Payload decompression failed'
[[ "$(wc -c < "$INSTALLER" | tr -d '[:space:]')" == "$EXPECTED_SOURCE_BYTES" ]] || fail 'Installer payload size mismatch'
[[ "$(sha256sum "$INSTALLER" | awk '{print $1}')" == "$EXPECTED_SOURCE_SHA256" ]] || fail 'Installer payload checksum mismatch'
if [[ "${1:-}" == '--verify-only' ]]; then log 'Payload verified; installation was not run.'; exit 0; fi
[[ $# == 0 ]] || fail 'Only --verify-only is supported as a bootstrap argument.'
log 'Payload verified; starting standalone-NPC v8 installer.'
bash "$INSTALLER"
