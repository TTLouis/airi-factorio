#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'payload-src', 'installer.sh')
const installPath = join(here, 'install.sh')
const eggPath = join(here, 'egg-airi-factorio-server.json')
const LEGACY_SOURCE_PIN = '78ef2acf788189981d82aa9e15e9c33b3dedb29c'
// This immutable commit contains the synchronized standalone v8 install.sh.
// Future installer revisions intentionally require advancing this pin after
// the new install.sh has been committed, avoiding a mutable branch fetch.
const EGG_INSTALL_REF = 'b75c93dd784509f78f04123e613fe618cdd8fb05'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function deterministicGzip(bytes) {
  const compressed = gzipSync(bytes, { level: 9 })
  compressed[4] = 0
  compressed[5] = 0
  compressed[6] = 0
  compressed[7] = 0
  return compressed
}

function wrapBase64(text, width = 76) {
  const lines = []
  for (let offset = 0; offset < text.length; offset += width) lines.push(text.slice(offset, offset + width))
  return lines.join('\n')
}

function assertNpcV8Source(source) {
  const text = source.toString('utf8')
  const failures = []
  if (!text.includes('airi-deploy-v8')) failures.push('missing v8 deployment revision')
  if (!text.includes('AIRI_ACTOR_MODE')) failures.push('missing AIRI_ACTOR_MODE')
  if (!text.includes('AIRI_CHAT_PLAYER')) failures.push('missing AIRI_CHAT_PLAYER')
  if (!/AIRI_REF="[a-f0-9]{40}"/.test(text)) failures.push('missing immutable AIRI_REF pin')
  if (text.includes('airi-deploy-v7')) failures.push('contains v7 deployment guard')
  if (text.includes('explicit-authorized-single-connected-player')) failures.push('contains connected-player patch contract')
  if (text.includes(`AIRI_REF="${LEGACY_SOURCE_PIN}"`)) failures.push('pins the legacy connected-player source')
  if (text.includes('operationCommands')) failures.push('contains legacy operationCommands model contract')
  if (failures.length) throw new Error(`Refusing to generate v8 artifacts: ${failures.join('; ')}`)
}

export function bootstrapFromArchive(source, archive) {
  assertNpcV8Source(source)
  if (!gunzipSync(archive).equals(source)) throw new Error('Payload archive does not round-trip to source')
  const sourceHash = sha256(source)
  const archiveHash = sha256(archive)
  const encoded = wrapBase64(archive.toString('base64'))
  return `#!/usr/bin/env bash
# Generated AIRI Factorio standalone-NPC v8 Pterodactyl bootstrap.
# Source of truth: deploy/pterodactyl/payload-src/installer.sh
set -Eeuo pipefail
umask 077
BOOT_DIR=""
EXPECTED_SOURCE_SHA256="${sourceHash}"
EXPECTED_SOURCE_BYTES="${source.length}"
EXPECTED_ARCHIVE_SHA256="${archiveHash}"
log() { printf '[AIRI bootstrap] %s\\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 78; }
cleanup() { local code=$?; trap - EXIT; [[ -z "$BOOT_DIR" || ! -d "$BOOT_DIR" ]] || rm -rf -- "$BOOT_DIR"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for tool in awk base64 gzip sha256sum mktemp wc bash mkdir rm; do command -v "$tool" >/dev/null || fail "Missing bootstrap tool: $tool"; done
ROOT="\${AIRI_INSTALL_ROOT:-/mnt/server}"
[[ "$ROOT" == /* && "$ROOT" != / ]] || fail 'Installer root must be an absolute directory other than /.'
mkdir -p -- "$ROOT"
BOOT_DIR="$(mktemp -d "$ROOT/.airi-bootstrap.XXXXXX")"
PAYLOAD="$BOOT_DIR/installer.b64"
ARCHIVE="$BOOT_DIR/installer.sh.gz"
INSTALLER="$BOOT_DIR/installer.sh"
cat > "$PAYLOAD" <<'AIRI_PAYLOAD'
${encoded}
AIRI_PAYLOAD
base64 -d "$PAYLOAD" > "$ARCHIVE" || fail 'Payload base64 decode failed'
[[ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" == "$EXPECTED_ARCHIVE_SHA256" ]] || fail 'Compressed payload checksum mismatch'
gzip -dc "$ARCHIVE" > "$INSTALLER" || fail 'Payload decompression failed'
[[ "$(wc -c < "$INSTALLER" | tr -d '[:space:]')" == "$EXPECTED_SOURCE_BYTES" ]] || fail 'Installer payload size mismatch'
[[ "$(sha256sum "$INSTALLER" | awk '{print $1}')" == "$EXPECTED_SOURCE_SHA256" ]] || fail 'Installer payload checksum mismatch'
if [[ "\${1:-}" == '--verify-only' ]]; then log 'Payload verified; installation was not run.'; exit 0; fi
[[ $# == 0 ]] || fail 'Only --verify-only is supported as a bootstrap argument.'
log 'Payload verified; starting standalone-NPC v8 installer.'
bash "$INSTALLER"
`
}

function bootstrap(source) {
  return bootstrapFromArchive(source, deterministicGzip(source))
}

export function eggInstallerLoader(source) {
  assertNpcV8Source(source)
  const sourceHash = sha256(source)
  return `#!/usr/bin/env bash
# Compact Pterodactyl egg loader for the standalone-NPC v8 installer.
set -Eeuo pipefail
umask 077
REF="${EGG_INSTALL_REF}"
EXPECTED_SOURCE_SHA256="${sourceHash}"
URL="https://raw.githubusercontent.com/TTLouis/airi-factorio/$REF/deploy/pterodactyl/install.sh"
TMP="$(mktemp)"
log() { printf '[AIRI egg] %s\\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 78; }
cleanup() { local code=$?; trap - EXIT; rm -f -- "$TMP"; exit "$code"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for tool in bash curl grep mktemp rm; do command -v "$tool" >/dev/null || fail "Missing egg installer tool: $tool"; done
curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --proto '=https' --proto-redir '=https' "$URL" --output "$TMP" || fail 'Unable to download pinned AIRI installer'
grep -Fq "EXPECTED_SOURCE_SHA256=\\\"$EXPECTED_SOURCE_SHA256\\\"" "$TMP" || fail 'Pinned AIRI installer payload checksum does not match this egg'
log "Using immutable installer revision $REF"
bash "$TMP"
`
}

function variable(name, description, envVariable, defaultValue, rules, { viewable = true } = {}) {
  return {
    name,
    description,
    env_variable: envVariable,
    default_value: defaultValue,
    user_viewable: viewable,
    user_editable: true,
    rules,
    field_type: 'text',
  }
}

function egg(source) {
  return {
    _comment: 'DO NOT EDIT: generated by deploy/pterodactyl/build-payload.mjs',
    meta: { version: 'PTDL_v2', update_url: null },
    exported_at: '2026-09-14T00:00:00+00:00',
    name: 'AIRI Factorio Server (Standalone NPC v8)',
    author: 'noreply@ttlouis.space',
    description: 'Standalone-NPC AIRI Factorio server. AIRI owns a persistent zero-player character; optional human chat authorization is separate from NPC ownership. Loopback-only RCON is managed by the bundled supervisor.',
    features: [],
    docker_images: {
      'ghcr.io/ptero-eggs/yolks:debian_bookworm': 'ghcr.io/ptero-eggs/yolks:debian_bookworm',
    },
    file_denylist: [],
    startup: 'bash ./start-airi.sh',
    config: {
      files: '{}',
      startup: '{"done": "AIRI Factorio ready"}',
      logs: '{}',
      stop: '^C',
    },
    scripts: {
      installation: {
        script: eggInstallerLoader(source),
        container: 'ghcr.io/ptero-eggs/yolks:debian_bookworm',
        entrypoint: 'bash',
      },
    },
    variables: [
      variable('AIRI Actor Mode', 'Controlled actor mode. The v8 egg intentionally supports standalone NPC ownership only.', 'AIRI_ACTOR_MODE', 'npc', 'required|string|in:npc'),
      variable('AIRI Chat Player', 'Optional exact in-game player name allowed to issue !airi chat requests. This does not control that player character.', 'AIRI_CHAT_PLAYER', '', 'nullable|string|max:64'),
      variable('OpenAI API Key', 'Provider credential. Kept environment-only and never written to airi-config.json.', 'OPENAI_API_KEY', '', 'required|string|max:512', { viewable: false }),
      variable('AI Model', 'OpenAI-compatible model identifier used by AIRI.', 'OPENAI_MODEL', 'gpt-5.6', 'required|string|max:200'),
      variable('Provider Base URL', 'OpenAI-compatible API base URL. Remote endpoints must use HTTPS.', 'OPENAI_API_BASEURL', 'https://api.openai.com/v1', 'required|string|url|max:255'),
      variable('Save File Name', 'Save under /saves. Leave blank to use the newest existing save or create airi-world.zip.', 'SAVE_NAME', '', 'nullable|string|max:160'),
      variable('Max AI Requests Per Hour', 'Persisted hourly provider request cap.', 'MAX_PROVIDER_REQUESTS_PER_HOUR', '30', 'required|numeric|between:1,1200'),
      variable('Shutdown Timeout (ms)', 'Graceful Factorio save/stop timeout before forced termination.', 'SHUTDOWN_TIMEOUT_MS', '60000', 'required|numeric|between:1000,300000'),
      variable('Factorio Version', 'Factorio 2.0 headless version: latest, experimental, or exact 2.0.x.', 'FACTORIO_VERSION', 'latest', 'required|string|max:20'),
    ],
  }
}

export function buildArtifacts(source) {
  const installScript = bootstrap(source)
  const eggJson = `${JSON.stringify(egg(source), null, 4)}\n`
  return { installScript, eggJson }
}

function normalizeCheckoutText(text) {
  return text.replaceAll('\r\n', '\n')
}

function requiredMatch(text, regex, name) {
  const match = text.match(regex)
  if (!match) throw new Error(`Generated install.sh is missing ${name}`)
  return match[1]
}

export function verifyGeneratedArtifacts(source, installText, eggText) {
  assertNpcV8Source(source)
  const installScript = normalizeCheckoutText(installText)
  const currentEgg = normalizeCheckoutText(eggText)

  const expectedSourceHash = requiredMatch(installScript, /^EXPECTED_SOURCE_SHA256="([a-f0-9]{64})"$/m, 'EXPECTED_SOURCE_SHA256')
  const expectedSourceBytes = Number(requiredMatch(installScript, /^EXPECTED_SOURCE_BYTES="([0-9]+)"$/m, 'EXPECTED_SOURCE_BYTES'))
  const expectedArchiveHash = requiredMatch(installScript, /^EXPECTED_ARCHIVE_SHA256="([a-f0-9]{64})"$/m, 'EXPECTED_ARCHIVE_SHA256')

  const payloadStart = `cat > "$PAYLOAD" <<'AIRI_PAYLOAD'\n`
  const start = installScript.indexOf(payloadStart)
  if (start === -1) throw new Error('Generated install.sh is missing AIRI_PAYLOAD start marker')
  const bodyStart = start + payloadStart.length
  const end = installScript.indexOf('\nAIRI_PAYLOAD\n', bodyStart)
  if (end === -1) throw new Error('Generated install.sh is missing AIRI_PAYLOAD end marker')

  const encoded = installScript.slice(bodyStart, end).replace(/\s+/g, '')
  const archive = Buffer.from(encoded, 'base64')
  let decoded
  try {
    decoded = gunzipSync(archive)
  } catch (error) {
    throw new Error(`Generated install.sh payload is not valid gzip: ${error.message}`)
  }

  if (expectedSourceHash !== sha256(source)) throw new Error('Generated install.sh source checksum is stale')
  if (expectedSourceBytes !== source.length) throw new Error('Generated install.sh source byte count is stale')
  if (expectedArchiveHash !== sha256(archive)) throw new Error('Generated install.sh archive checksum is stale')
  if (!decoded.equals(source)) throw new Error('Generated install.sh payload does not reproduce payload-src/installer.sh')

  try {
    JSON.parse(currentEgg)
  } catch (error) {
    throw new Error(`Generated egg JSON is invalid: ${error.message}`)
  }

  const expectedEgg = `${JSON.stringify(egg(source), null, 4)}\n`
  if (currentEgg !== expectedEgg) throw new Error('Generated egg schema is stale')
  return true
}

function main() {
  const checkOnly = process.argv.includes('--check')
  if (process.argv.length > 3 || (process.argv.length === 3 && !checkOnly)) throw new Error('Usage: node build-payload.mjs [--check]')
  const source = readFileSync(sourcePath)

  if (checkOnly) {
    verifyGeneratedArtifacts(source, readFileSync(installPath, 'utf8'), readFileSync(eggPath, 'utf8'))
    console.log('Pterodactyl v8 artifacts are current and internally verified.')
    return
  }

  const { installScript, eggJson } = buildArtifacts(source)
  writeFileSync(installPath, installScript)
  writeFileSync(eggPath, eggJson)
  console.log('Generated standalone-NPC v8 install.sh and compact egg-airi-factorio-server.json.')
  console.log(`  payload source sha256: ${sha256(source)}`)
  console.log(`  install script bytes: ${Buffer.byteLength(installScript)}`)
  console.log(`  egg loader ref: ${EGG_INSTALL_REF}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
