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

test('generated artifact verifier accepts a self-consistent payload without recompressing it', () => {
  const canonical = buildArtifacts(source)
  assert.equal(verifyGeneratedArtifacts(source, canonical.installScript, canonical.eggJson), true)

  const alternateInstall = bootstrapFromArchive(source, gzipAtLevel(source, 1))
  assert.notEqual(alternateInstall, canonical.installScript)

  const alternateEgg = JSON.parse(canonical.eggJson)
  alternateEgg.scripts.installation.script = alternateInstall
  const alternateEggText = `${JSON.stringify(alternateEgg, null, 4)}\n`

  assert.equal(verifyGeneratedArtifacts(source, alternateInstall, alternateEggText), true)
})

test('generated artifact verifier rejects payload/source drift', () => {
  const canonical = buildArtifacts(source)
  const changedSource = Buffer.concat([source, Buffer.from('# changed\n')])
  assert.throws(
    () => verifyGeneratedArtifacts(changedSource, canonical.installScript, canonical.eggJson),
    /checksum is stale|does not reproduce/,
  )
})

test('committed Pterodactyl egg is valid JSON with a valid model rule', () => {
  const egg = JSON.parse(readFileSync(join(here, 'egg-airi-factorio-server.json'), 'utf8'))
  const model = egg.variables.find(entry => entry.env_variable === 'OPENAI_MODEL')
  assert.ok(model)
  assert.equal(model.rules, 'required|string|max:200|regex:/^[a-zA-Z0-9._:\\\\/-]+$/')
  assert.equal(egg.scripts.installation.script, readFileSync(join(here, 'install.sh'), 'utf8'))
})
