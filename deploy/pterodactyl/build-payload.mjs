#!/usr/bin/env node
// Regenerates the checksummed AIRI_PAYLOAD blob embedded in install.sh and
// egg-airi-factorio-server.json from the real, diffable source at
// payload-src/installer.sh.
//
// What "byte-identical" means here, precisely: the thing that actually gets
// installed on a server is whatever install.sh's own bootstrap logic
// produces after `base64 -d | gzip -dc` — i.e. the *decompressed* payload.
// This script's real safety guarantee is that decompressing its freshly
// built blob reproduces payload-src/installer.sh exactly. The *compressed*
// bytes are allowed to differ from what's currently embedded (gzip isn't a
// canonical encoding — a different gzip implementation/version can compress
// identical input to a different, equally valid bitstream), so
// EXPECTED_BASE64_BYTES is expected to change even when nothing about the
// installed content has changed. If the decompressed round-trip doesn't
// match byte-for-byte, this script refuses to touch anything.
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'payload-src', 'installer.sh')
const installShPath = join(here, 'install.sh')
const eggJsonPath = join(here, 'egg-airi-factorio-server.json')

const HEREDOC_START = `cat > "$PAYLOAD" <<'AIRI_PAYLOAD'`
const HEREDOC_END = `AIRI_PAYLOAD`
const LEGACY_SOURCE_PIN = '78ef2acf788189981d82aa9e15e9c33b3dedb29c'

function wrap_base64(base64) {
  // Matches GNU coreutils `base64`'s default 76-column wrapping, which is
  // what produced the payload currently embedded in both files.
  const lines = []
  for (let i = 0; i < base64.length; i += 76) {
    lines.push(base64.slice(i, i + 76))
  }
  return lines
}

function gzip_deterministic(buffer) {
  const compressed = gzipSync(buffer, { level: 9 })
  // Zero the MTIME field (gzip header bytes 4-7) so the same input always
  // compresses to the same bytes, regardless of when this script runs —
  // matching the mtime=0 convention already present in the currently
  // embedded blob (inspected directly: header is 1f 8b 08 00 00 00 00 00 ..).
  compressed[4] = 0
  compressed[5] = 0
  compressed[6] = 0
  compressed[7] = 0
  return compressed
}

function assertNpcV8Source(source) {
  const text = source.toString('utf8')
  const failures = []
  if (!text.includes('airi-deploy-v8')) failures.push('missing v8 deployment guard revision')
  if (!text.includes('AIRI_ACTOR_MODE')) failures.push('missing AIRI_ACTOR_MODE configuration')
  if (!text.includes('AIRI_CHAT_PLAYER')) failures.push('missing AIRI_CHAT_PLAYER chat-authorization separation')
  if (text.includes('airi-deploy-v7')) failures.push('still contains the v7 deployment guard')
  if (text.includes('explicit-authorized-single-connected-player')) failures.push('still contains the connected-player source patch contract')
  if (text.includes(`AIRI_REF="${LEGACY_SOURCE_PIN}"`)) failures.push('still pins the legacy connected-player source revision')
  if (text.includes('operationCommands')) failures.push('still exposes the legacy operationCommands model contract')
  if (failures.length) {
    throw new Error(`REFUSING to regenerate Pterodactyl artifacts from a legacy payload source: ${failures.join('; ')}. Finish the v8 NPC payload integration first.`)
  }
}

function splice_between(text, startMarker, endMarker, replacement) {
  const startIdx = text.indexOf(startMarker)
  if (startIdx === -1) {
    throw new Error(`start marker not found: ${startMarker}`)
  }
  const bodyStart = text.indexOf('\n', startIdx) + 1
  const endIdx = text.indexOf(endMarker, bodyStart)
  if (endIdx === -1) {
    throw new Error(`end marker not found: ${endMarker}`)
  }
  return text.slice(0, bodyStart) + replacement + text.slice(endIdx)
}

function replace_constant(text, name, value) {
  const re = new RegExp(`^(${name}=")[^"]*(")`, 'm')
  if (!re.test(text)) {
    throw new Error(`constant not found: ${name}`)
  }
  return text.replace(re, `$1${value}$2`)
}

function main() {
  const source = readFileSync(sourcePath)

  // The repository has moved to the validated standalone-NPC runtime. Do not
  // accidentally publish a freshly checksummed egg that still contains the
  // previous connected-player v7 deployment contract while v8 integration is
  // in progress.
  assertNpcV8Source(source)

  const compressed = gzip_deterministic(source)
  const base64 = compressed.toString('base64')
  const base64Lines = wrap_base64(base64)

  const expectedSha256 = createHash('sha256').update(source).digest('hex')
  const expectedBytes = String(source.length)
  const expectedBase64Bytes = String(base64.length)

  // Verify round-trip BEFORE touching anything: decode our own freshly built
  // blob exactly the way install.sh's bootstrap does, and confirm it
  // reproduces payload-src/installer.sh byte-for-byte.
  const roundTrip = execFileSync('gzip', ['-dc'], { input: compressed, maxBuffer: 1024 * 1024 * 16 })
  if (Buffer.compare(roundTrip, source) !== 0) {
    console.error('REFUSING to update install.sh / egg JSON: round-trip decode did not reproduce payload-src/installer.sh byte-for-byte.')
    process.exit(1)
  }

  let installSh = readFileSync(installShPath, 'utf8')
  const usesCrlf = installSh.includes('\r\n')
  const newline = usesCrlf ? '\r\n' : '\n'
  const newBody = base64Lines.join(newline) + newline

  installSh = splice_between(installSh, HEREDOC_START, HEREDOC_END, newBody)
  installSh = replace_constant(installSh, 'EXPECTED_SHA256', expectedSha256)
  installSh = replace_constant(installSh, 'EXPECTED_BYTES', expectedBytes)
  installSh = replace_constant(installSh, 'EXPECTED_BASE64_BYTES', expectedBase64Bytes)

  // The egg JSON embeds the exact same script as a JSON string (this is an
  // invariant the existing README already documents — see deploy/pterodactyl/README.md).
  // JSON.stringify correctly escapes the CR/LF bytes now in installSh; we
  // only need to additionally escape `/` as `\/` to match the panel
  // exporter's own style (cosmetic — both are valid JSON) and strip the
  // surrounding quotes JSON.stringify adds.
  const escapedScript = JSON.stringify(installSh).slice(1, -1).replaceAll('/', '\\/')

  let eggJson = readFileSync(eggJsonPath, 'utf8')
  const scriptFieldRe = /("script":\s*")((?:[^"\\]|\\.)*)(")/
  if (!scriptFieldRe.test(eggJson)) {
    throw new Error('scripts.installation.script field not found in egg JSON')
  }
  eggJson = eggJson.replace(scriptFieldRe, (_match, prefix, _old, suffix) => `${prefix}${escapedScript}${suffix}`)

  writeFileSync(installShPath, installSh)
  writeFileSync(eggJsonPath, eggJson)

  console.log('Payload rebuilt from payload-src/installer.sh.')
  console.log(`  decompressed sha256: ${expectedSha256}`)
  console.log(`  decompressed bytes:  ${expectedBytes}`)
  console.log(`  base64 bytes:        ${expectedBase64Bytes}`)
  console.log('Round-trip verified: decoding the new blob reproduces payload-src/installer.sh exactly.')
}

main()
