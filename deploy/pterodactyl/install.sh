#!/usr/bin/env bash
# Generated AIRI Factorio standalone-NPC v8 Pterodactyl bootstrap.
# Source of truth: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
BOOT_DIR=""
EXPECTED_SOURCE_SHA256="384f2a945867fa851d6ff69ed769938ff35e29b8fd340e1c047a4a81a14d6363"
EXPECTED_SOURCE_BYTES="14031"
EXPECTED_ARCHIVE_SHA256="482fd6cd550f475fb72e09b7e8efaa91c14deef3eb2b28d7edb796d92c04b225"
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
3hewbfwPr/OFGc82AAA=
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
