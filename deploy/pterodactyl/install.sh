#!/usr/bin/env bash
# Generated AIRI Factorio standalone-NPC v8 Pterodactyl bootstrap.
# Source of truth: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
BOOT_DIR=""
EXPECTED_SOURCE_SHA256="ee829214728942377835c8270498ab916c02735b481f5be7a61377109b6cb098"
EXPECTED_SOURCE_BYTES="13787"
EXPECTED_ARCHIVE_SHA256="0b514860588a34ba4c5a813789cef7978d4b2a149c3565346301efc17aa5e693"
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
xv8Aihy4Sds1AAA=
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
