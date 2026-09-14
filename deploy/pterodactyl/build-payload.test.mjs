import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootstrapFromArchive, buildArtifacts, verifyGeneratedArtifacts } from './build-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = Buffer.from(`#!/usr/bin/env bash
AIRI_REF="0123456789abcdef0123456789abcdef01234567"
DEPLOYMENT_REVISION="airi-deploy-v8-test"
AIRI_ACTOR_MODE="\${AIRI_ACTOR_MODE:-npc}"
AIRI_CHAT_PLAYER="\${AIRI_CHAT_PLAYER:-}"
echo "$DEPLOYMENT_REVISION $AIRI_ACTOR_MODE $AIRI_CHAT_PLAYER"
`)

function gzipAtLevel(bytes, level) {
  const archive = gzipSync(bytes, { level })
  archive[4] = 0
  archive[5] = 0
  archive[6] = 0
  archive[7] = 0
  return archive
}

test('generated artifact verifier accepts the same payload with a different gzip encoding', () => {
  const canonical = buildArtifacts(source)
  assert.equal(verifyGeneratedArtifacts(source, canonical.installScript, canonical.eggJson), true)

  const alternateInstall = bootstrapFromArchive(source, gzipAtLevel(source, 1))
  assert.notEqual(alternateInstall, canonical.installScript)

  // The compact egg no longer embeds the gzip/bootstrap bytes, so it remains
  // valid as long as the standalone install.sh decodes to the same source.
  assert.equal(verifyGeneratedArtifacts(source, alternateInstall, canonical.eggJson), true)
})

test('generated artifact verifier rejects payload/source drift', () => {
  const canonical = buildArtifacts(source)
  const changedSource = Buffer.concat([source, Buffer.from('# changed\n')])
  assert.throws(
    () => verifyGeneratedArtifacts(changedSource, canonical.installScript, canonical.eggJson),
    /checksum is stale|does not reproduce|schema is stale/,
  )
})

test('generated egg is valid JSON and uses the immutable compact installer loader', () => {
  const canonical = buildArtifacts(source)
  const egg = JSON.parse(canonical.eggJson)
  const model = egg.variables.find(entry => entry.env_variable === 'OPENAI_MODEL')
  assert.ok(model)
  assert.equal(model.rules, 'required|string|max:200')
  assert.match(egg.scripts.installation.script, /raw\.githubusercontent\.com\/TTLouis\/airi-factorio\/b75c93dd784509f78f04123e613fe618cdd8fb05\/deploy\/pterodactyl\/install\.sh/)
  assert.match(egg.scripts.installation.script, /EXPECTED_SOURCE_SHA256=/)
})

test('committed Pterodactyl artifacts are internally valid', () => {
  const committedSource = readFileSync(join(here, 'payload-src', 'installer.sh'))
  const committedInstall = readFileSync(join(here, 'install.sh'), 'utf8')
  const committedEggText = readFileSync(join(here, 'egg-airi-factorio-server.json'), 'utf8')
  const egg = JSON.parse(committedEggText)

  assert.equal(verifyGeneratedArtifacts(committedSource, committedInstall, committedEggText), true)
  const model = egg.variables.find(entry => entry.env_variable === 'OPENAI_MODEL')
  assert.equal(model.rules, 'required|string|max:200')
  assert.match(egg.scripts.installation.script, /b75c93dd784509f78f04123e613fe618cdd8fb05/)
  assert.notEqual(egg.scripts.installation.script, committedInstall)
})
