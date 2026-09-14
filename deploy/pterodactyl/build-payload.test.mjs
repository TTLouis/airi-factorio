import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

import { bootstrapFromArchive, buildArtifacts, verifyGeneratedArtifacts } from './build-payload.mjs'

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
