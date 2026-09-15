#!/usr/bin/env bash
# Generated AIRI Factorio standalone-NPC v8 installer loader.
# Immutable source: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
REF="b73d12101bad1b4515b75818474985a95e933ef4"
EXPECTED_SOURCE_SHA256="40537a476eb189a613a7d0ed6cd8ffb1fee36a1c34aa6dcb136172659edd0fbf"
URL="https://raw.githubusercontent.com/TTLouis/airi-factorio/$REF/deploy/pterodactyl/payload-src/installer.sh"
TMP="$(mktemp)"
log() { printf '[AIRI bootstrap] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 78; }
cleanup() { local code=$?; trap - EXIT; rm -f -- "$TMP"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for tool in bash curl sha256sum awk mktemp rm; do command -v "$tool" >/dev/null || fail "Missing installer loader tool: $tool"; done
curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --proto '=https' --proto-redir '=https' "$URL" --output "$TMP" || fail 'Unable to download pinned AIRI installer source'
ACTUAL_SOURCE_SHA256="$(sha256sum "$TMP" | awk '{print $1}')"
[[ "$ACTUAL_SOURCE_SHA256" == "$EXPECTED_SOURCE_SHA256" ]] || fail 'Pinned AIRI installer source checksum mismatch'
if [[ "${1:-}" == '--verify-only' ]]; then log "Pinned payload verified at $REF; installation was not run."; exit 0; fi
[[ $# == 0 ]] || fail 'Only --verify-only is supported as a loader argument.'
log "Using immutable installer payload $REF"
bash "$TMP"
