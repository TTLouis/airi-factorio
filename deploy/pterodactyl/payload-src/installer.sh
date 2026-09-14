#!/usr/bin/env bash
# AIRI Factorio Pterodactyl v8 standalone-NPC installer.
# Install/runtime image: ghcr.io/ptero-eggs/yolks:debian_bookworm
set -Eeuo pipefail
umask 077

SERVER_DIR="${AIRI_INSTALL_ROOT:-/mnt/server}"
NODE_VERSION="v24.21.0"
PNPM_VERSION="10.30.1"
AIRI_REF="cab5ad1ca425f7dee8775848300100b8fe089bef"
REVISION="2026-09-14.14-debug"
DEPLOYMENT_REVISION="airi-deploy-v8-npc-staging"
AIRI_ACTOR_MODE="${AIRI_ACTOR_MODE:-npc}"
[[ "$AIRI_ACTOR_MODE" == "npc" ]] || { echo "[AIRI install] ERROR: v8 egg currently requires AIRI_ACTOR_MODE=npc" >&2; exit 1; }
export AIRI_ACTOR_MODE
WORK=""

log() { printf '[AIRI install] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf -- "$WORK"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap 'log "Failed at installer line $LINENO. Existing completed release was retained." >&2' ERR

[[ "$(uname -m)" == x86_64 ]] || fail 'An amd64 Wings node is required'
for tool in bash curl tar gzip xz awk grep sha256sum mktemp readlink flock cp mv rm chmod ln df tr basename getconf zip; do
  command -v "$tool" >/dev/null || fail "Missing installer tool: $tool; use the Bookworm image"
done
GLIBC="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
[[ "$GLIBC" =~ ^([0-9]+)\.([0-9]+)$ ]] || fail 'Unable to identify installer glibc'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 36) )) || fail 'Bookworm/glibc 2.36+ is required'

mkdir -p "$SERVER_DIR"
SERVER_DIR="$(readlink -f -- "$SERVER_DIR")"
[[ "$SERVER_DIR" != / ]] || fail 'The server root cannot be /'
[[ ! -L "$SERVER_DIR/.airi" ]] || fail '.airi cannot be a symlink'
mkdir -p "$SERVER_DIR/.airi/releases"
[[ ! -L "$SERVER_DIR/.airi/releases" && ! -L "$SERVER_DIR/.airi/operation.lock" ]] || fail 'Managed AIRI paths cannot be symlinks'
exec 9>"$SERVER_DIR/.airi/operation.lock"
flock -n 9 || fail 'Another AIRI installer/runtime owns this server volume'

if [[ ! -e "$SERVER_DIR/start-airi.sh" && ! -L "$SERVER_DIR/start-airi.sh" ]]; then
  printf '#!/bin/bash\necho "[AIRI] No completed installation is active" >&2\nexit 78\n' > "$SERVER_DIR/start-airi.sh"
  chmod 755 "$SERVER_DIR/start-airi.sh"
fi

WORK="$(mktemp -d "$SERVER_DIR/.airi/install.XXXXXX")"
APP="$WORK/app"
mkdir -p "$APP/src/runtime-v8" "$APP/src/staging" "$APP/autorio" "$APP/factorio" "$APP/client-mod" "$WORK/tmp" "$WORK/home" "$WORK/cache" "$WORK/npm-cache"
export HOME="$WORK/home" TMPDIR="$WORK/tmp" XDG_CACHE_HOME="$WORK/cache" NPM_CONFIG_CACHE="$WORK/npm-cache"
unset OPENAI_API_KEY OPENAI_API_BASEURL FACTORIO_RCON_PASSWORD RCON_PASSWORD SERVER_TOKEN NODE_OPTIONS NODE_PATH || true
export NODE_TLS_REJECT_UNAUTHORIZED=1

fetch() {
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --proto '=https' --proto-redir '=https' "$1" --output "$2"
}

log "Installer revision $REVISION; source $AIRI_REF"
FREE_KB="$(df -Pk "$SERVER_DIR" | awk 'END {print $4}')"
[[ "$FREE_KB" =~ ^[0-9]+$ ]] && (( FREE_KB >= 4194304 )) || fail 'At least 4 GiB free space is required for transactional installation'

log "Downloading Node $NODE_VERSION"
NODE_ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.gz"
fetch "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" "$WORK/$NODE_ARCHIVE"
fetch "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
NODE_HASH="$(awk -v name="$NODE_ARCHIVE" '$2==name {print $1}' "$WORK/SHASUMS256.txt")"
[[ "$NODE_HASH" =~ ^[a-f0-9]{64}$ ]] || fail 'Missing or ambiguous Node checksum'
printf '%s  %s\n' "$NODE_HASH" "$NODE_ARCHIVE" | (cd "$WORK" && sha256sum -c -)
mkdir -p "$APP/node"
tar -xzf "$WORK/$NODE_ARCHIVE" --strip-components=1 --no-same-owner -C "$APP/node"
export PATH="$APP/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ "$(node --version)" == "$NODE_VERSION" ]] || fail 'Portable Node verification failed'
node "$APP/node/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix "$WORK/build-tools" --ignore-scripts --no-audit --no-fund "pnpm@$PNPM_VERSION"
export PATH="$WORK/build-tools/bin:$PATH"
[[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || fail 'pnpm verification failed'

log 'Downloading pinned AIRI fork source'
fetch "https://codeload.github.com/TTLouis/airi-factorio/tar.gz/$AIRI_REF" "$WORK/airi-source.tar.gz"
mkdir -p "$WORK/source"
tar -xzf "$WORK/airi-source.tar.gz" --strip-components=1 --no-same-owner -C "$WORK/source"
[[ -f "$WORK/source/pnpm-lock.yaml" ]] || fail 'Pinned source lockfile is missing'
[[ -f "$WORK/source/deploy/pterodactyl/staging/guard.ts" ]] || fail 'Pinned source lacks the v8 NPC guard'
[[ -f "$WORK/source/deploy/pterodactyl/runtime-v8/supervisor.mjs" ]] || fail 'Pinned source lacks the v8 runtime supervisor'

log 'Running v8 deployment/runtime protocol tests'
(
  cd "$WORK/source"
  node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
)

log 'Installing the Autorio build graph and testing the native NPC source'
(
  cd "$WORK/source"
  NODE_ENV=development pnpm install --filter 'autorio.ts...' --frozen-lockfile --ignore-scripts --store-dir "$WORK/pnpm-store" --package-import-method=copy
  pnpm --filter @proj-airi/tstl-plugin-reload-factorio-mod run build
  pnpm --filter autorio.ts run test
)

log 'Preparing native actor-aware Autorio source and compiling the deployment guard'
node "$WORK/source/deploy/pterodactyl/staging/source-preparer.mjs" \
  "$WORK/source" \
  "$WORK/source/deploy/pterodactyl/staging/guard.ts" \
  > "$WORK/source-preparation.json"
grep -q 'native-actor-aware-autorio' "$WORK/source-preparation.json" || fail 'Native NPC source preparation did not confirm its contract'
(
  cd "$WORK/source"
  pnpm --filter autorio.ts run typecheck
  pnpm --filter autorio.ts run build
)
[[ -s "$WORK/source/packages/autorio/dist/control.lua" ]] || fail 'Lua compilation did not emit control.lua'
cp "$WORK/source/packages/autorio/info.json" "$WORK/source/packages/autorio/dist/info.json"
cp -a "$WORK/source/packages/autorio/dist/." "$APP/autorio/"

log 'Copying v8 supervisor, shared policy, and prompt'
for file in common.mjs game-files.mjs provider.mjs supervisor.mjs structured-policy.mjs supervisor-adapter.mjs npc-agent-loop.mjs; do
  cp "$WORK/source/deploy/pterodactyl/runtime-v8/$file" "$APP/src/runtime-v8/$file"
done
for file in structured-policy.mjs supervisor-adapter.mjs npc-agent-loop.mjs; do
  cp "$WORK/source/deploy/pterodactyl/staging/$file" "$APP/src/staging/$file"
done
cp "$WORK/source/packages/agent/src/llm/prompt.md" "$APP/src/prompt.md"
cp "$WORK/source/LICENSE" "$APP/UPSTREAM-LICENSE"
for file in "$APP/src/runtime-v8/"*.mjs "$APP/src/staging/"*.mjs; do node --check "$file"; done

FACTORIO_REQUEST="${FACTORIO_VERSION:-latest}"
if [[ "$FACTORIO_REQUEST" == latest || "$FACTORIO_REQUEST" == experimental ]]; then
  FACTORIO_TARGET="$(FACTORIO_REQUEST="$FACTORIO_REQUEST" node --input-type=module <<'NODE'
const request = process.env.FACTORIO_REQUEST
const response = await fetch('https://factorio.com/api/latest-releases', { redirect: 'error', signal: AbortSignal.timeout(15000) })
if (!response.ok) throw new Error(`release API HTTP ${response.status}`)
const data = await response.json()
const version = data?.[request === 'latest' ? 'stable' : 'experimental']?.headless
if (typeof version !== 'string' || !/^2\.0\.\d+$/.test(version)) throw new Error('unsupported Factorio release')
process.stdout.write(version)
NODE
)" || fail 'Unable to resolve requested Factorio release'
else
  [[ "$FACTORIO_REQUEST" =~ ^2\.0\.[0-9]+$ ]] || fail 'FACTORIO_VERSION must be latest, experimental, or an exact 2.0.x release'
  FACTORIO_TARGET="$FACTORIO_REQUEST"
fi

log "Downloading Factorio headless $FACTORIO_TARGET"
FACTORIO_ARCHIVE="factorio-headless_linux_${FACTORIO_TARGET}.tar.xz"
fetch "https://www.factorio.com/get-download/${FACTORIO_TARGET}/headless/linux64" "$WORK/$FACTORIO_ARCHIVE"
fetch "https://factorio.com/download/sha256sums/" "$WORK/factorio-sha256sums.txt"
FACTORIO_HASH="$(awk -v name="$FACTORIO_ARCHIVE" '$2==name {print $1}' "$WORK/factorio-sha256sums.txt")"
[[ "$FACTORIO_HASH" =~ ^[a-f0-9]{64}$ ]] || fail 'Official Factorio checksum is missing or ambiguous'
printf '%s  %s\n' "$FACTORIO_HASH" "$FACTORIO_ARCHIVE" | (cd "$WORK" && sha256sum -c -)
xz -t "$WORK/$FACTORIO_ARCHIVE"
while IFS= read -r name; do
  [[ "$name" == factorio/* && "$name" != *'..'* && "$name" != *'\\'* ]] || fail "Unsafe Factorio archive path: $name"
done < <(tar -tJf "$WORK/$FACTORIO_ARCHIVE")
while IFS= read -r line; do
  [[ "${line:0:1}" == '-' || "${line:0:1}" == 'd' ]] || fail 'Factorio archive contains a link or special file'
done < <(tar -tvJf "$WORK/$FACTORIO_ARCHIVE")
tar -xJf "$WORK/$FACTORIO_ARCHIVE" --strip-components=1 --no-same-owner --no-same-permissions -C "$APP/factorio"
[[ "$($APP/factorio/bin/x64/factorio --version | awk '/Version:/ {print $2; exit}')" == "$FACTORIO_TARGET" ]] || fail 'Factorio executable version mismatch'

log 'Packaging the exact managed Autorio client mod'
mkdir -p "$WORK/client-mod/autorio_0.1.0"
cp -a "$APP/autorio/." "$WORK/client-mod/autorio_0.1.0/"
(cd "$WORK/client-mod" && zip -qr "$APP/client-mod/autorio_0.1.0.zip" autorio_0.1.0)
(cd "$APP/client-mod" && sha256sum autorio_0.1.0.zip > SHA256SUMS)

cat > "$APP/start-airi.sh" <<'START_AIRI'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${CONTAINER_ROOT:-/home/container}"
ROOT="$(readlink -f -- "$ROOT")"
SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
APP="$(dirname -- "$SELF")"
[[ -d "$ROOT/.airi" && ! -L "$ROOT/.airi" ]] || { echo '[AIRI] Missing managed state directory' >&2; exit 78; }
exec 9>"$ROOT/.airi/operation.lock"
flock -n 9 || { echo '[AIRI] Another AIRI install/runtime owns this server volume' >&2; exit 73; }
unset NODE_OPTIONS NODE_PATH
export NODE_TLS_REJECT_UNAUTHORIZED=1
export HOME="$ROOT" CONTAINER_ROOT="$ROOT"
export PATH="$APP/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export TMPDIR="$ROOT/.airi/tmp"
mkdir -p "$TMPDIR"
cd "$ROOT"
exec "$APP/node/bin/node" "$APP/src/runtime-v8/supervisor.mjs"
START_AIRI
chmod 755 "$APP/start-airi.sh"

log 'Writing checksummed release manifest'
APP_ROOT="$APP" AIRI_REF_VALUE="$AIRI_REF" FACTORIO_TARGET_VALUE="$FACTORIO_TARGET" node --input-type=module <<'MANIFEST'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
const root = process.env.APP_ROOT
const names = [
  'start-airi.sh',
  'src/prompt.md',
  'src/runtime-v8/common.mjs',
  'src/runtime-v8/game-files.mjs',
  'src/runtime-v8/provider.mjs',
  'src/runtime-v8/supervisor.mjs',
  'src/runtime-v8/structured-policy.mjs',
  'src/runtime-v8/supervisor-adapter.mjs',
  'src/runtime-v8/npc-agent-loop.mjs',
  'src/staging/structured-policy.mjs',
  'src/staging/supervisor-adapter.mjs',
  'src/staging/npc-agent-loop.mjs',
  'autorio/control.lua',
  'autorio/info.json',
  'factorio/bin/x64/factorio',
]
const files = {}
for (const name of names) {
  const bytes = await fs.readFile(path.join(root, name))
  files[name] = crypto.createHash('sha256').update(bytes).digest('hex')
}
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
  revision: 'airi-pterodactyl-v8',
  source: process.env.AIRI_REF_VALUE,
  factorio: process.env.FACTORIO_TARGET_VALUE,
  files,
}, null, 2) + '\n')
MANIFEST

RELEASE_ID="${REVISION}-$(basename "$WORK" | tr . -)"
RELEASE="$SERVER_DIR/.airi/releases/$RELEASE_ID"
[[ ! -e "$RELEASE" ]] || fail 'Release directory collision'
mv "$APP" "$RELEASE"

cp "$RELEASE/client-mod/autorio_0.1.0.zip" "$SERVER_DIR/autorio_0.1.0.zip"
PREVIOUS_TARGET=""
if [[ -L "$SERVER_DIR/start-airi.sh" ]]; then
  PREVIOUS_TARGET="$(readlink -- "$SERVER_DIR/start-airi.sh")"
  [[ "$PREVIOUS_TARGET" == .airi/releases/*/start-airi.sh ]] || fail 'Existing AIRI startup symlink has an unexpected target'
elif [[ -e "$SERVER_DIR/start-airi.sh" ]]; then
  [[ -f "$SERVER_DIR/start-airi.sh" ]] || fail 'Existing AIRI startup path is not a regular file or managed symlink'
fi
ln -s ".airi/releases/$RELEASE_ID/start-airi.sh" "$SERVER_DIR/.start-airi-$RELEASE_ID.new"
mv -Tf "$SERVER_DIR/.start-airi-$RELEASE_ID.new" "$SERVER_DIR/start-airi.sh"
if [[ -n "$PREVIOUS_TARGET" ]]; then
  printf '%s\n' "$PREVIOUS_TARGET" > "$SERVER_DIR/.airi/rollback-$RELEASE_ID.target.tmp"
  mv -Tf "$SERVER_DIR/.airi/rollback-$RELEASE_ID.target.tmp" "$SERVER_DIR/.airi/rollback-$RELEASE_ID.target"
fi
cat > "$SERVER_DIR/rollback-airi.sh" <<'ROLLBACK_AIRI'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${CONTAINER_ROOT:-/home/container}"
ROOT="$(readlink -f -- "$ROOT")"
LATEST="$(ls -1t "$ROOT"/.airi/rollback-*.target 2>/dev/null | head -n 1 || true)"
[[ -n "$LATEST" && -f "$LATEST" ]] || { echo '[AIRI rollback] No previous completed release is recorded.' >&2; exit 1; }
TARGET="$(cat "$LATEST")"
[[ "$TARGET" == .airi/releases/*/start-airi.sh && -f "$ROOT/$TARGET" ]] || { echo '[AIRI rollback] Recorded previous release is unavailable.' >&2; exit 1; }
ln -s "$TARGET" "$ROOT/.start-airi-rollback.new"
mv -Tf "$ROOT/.start-airi-rollback.new" "$ROOT/start-airi.sh"
echo "[AIRI rollback] Restored startup target: $TARGET"
ROLLBACK_AIRI
chmod 755 "$SERVER_DIR/rollback-airi.sh"

if [[ ! -e "$SERVER_DIR/airi-config.json" ]]; then
  AIRI_CONFIG_PATH="$SERVER_DIR/airi-config.json" AIRI_SUPERVISOR="$RELEASE/src/runtime-v8/supervisor.mjs" "$RELEASE/node/bin/node" --input-type=module <<'CONFIG'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { seedConfigFromEnv } = await import(pathToFileURL(process.env.AIRI_SUPERVISOR).href)
await fs.writeFile(process.env.AIRI_CONFIG_PATH, `${JSON.stringify(seedConfigFromEnv(), null, 2)}\n`)
CONFIG
fi

log "Installation complete: $DEPLOYMENT_REVISION"
log "Pinned source: $AIRI_REF"
log "Factorio: $FACTORIO_TARGET"
log 'Actor ownership: standalone NPC; zero connected humans is valid.'
log 'Set AIRI_CHAT_PLAYER to the human allowed to issue !airi requests.'
log 'Startup command: bash ./start-airi.sh'
exit 0
