#!/usr/bin/env bash
# Generated AIRI Factorio standalone-NPC v8 Pterodactyl bootstrap.
# Source of truth: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
BOOT_DIR=""
EXPECTED_SOURCE_SHA256="f176c6d72361eb67133c1a39b961c2fb8772eed88a9a336036cefb1617e14037"
EXPECTED_SOURCE_BYTES="12538"
EXPECTED_ARCHIVE_SHA256="a452301b8a55e8e00312b3539edbc6b12259292792ba8e8a97460b8428fd2645"
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
2/36MAAA
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
