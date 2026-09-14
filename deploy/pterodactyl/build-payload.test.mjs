import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildArtifacts, installerLoader, verifyGeneratedArtifacts } from './build-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PAYLOAD_REF = 'c60728afc4d348d9739a3c7de70bec86cc9c708a'
const source = Buffer.from(`#!/usr/bin/env bash
AIRI_REF="0123456789abcdef0123456789abcdef01234567"
DEPLOYMENT_REVISION="airi-deploy-v8-test"
AIRI_ACTOR_MODE="\${AIRI_ACTOR_MODE:-npc}"
AIRI_CHAT_PLAYER="\${AIRI_CHAT_PLAYER:-}"
echo "$DEPLOYMENT_REVISION $AIRI_ACTOR_MODE $AIRI_CHAT_PLAYER"
`)

test('generated artifacts share one immutable checksummed installer loader', () => {
  const canonical = buildArtifacts(source)
  assert.equal(canonical.installScript, installerLoader(source))
  assert.equal(verifyGeneratedArtifacts(source, canonical.installScript, canonical.eggJson), true)

  const egg = JSON.parse(canonical.eggJson)
  assert.equal(egg.scripts.installation.script, canonical.installScript)
  assert.match(canonical.installScript, new RegExp(PAYLOAD_REF))
  assert.match(canonical.installScript, /payload-src\/installer\.sh/)
  assert.match(canonical.installScript, /EXPECTED_SOURCE_SHA256="[a-f0-9]{64}"/)
})

test('generated artifact verifier rejects payload/source drift', () => {
  const canonical = buildArtifacts(source)
  const changedSource = Buffer.concat([source, Buffer.from('# changed\n')])
  assert.throws(
    () => verifyGeneratedArtifacts(changedSource, canonical.installScript, canonical.eggJson),
    /install\.sh loader is stale|egg schema is stale/,
  )
})

test('generated egg is valid PTDL_v2 JSON with the v8 variable contract', () => {
  const canonical = buildArtifacts(source)
  const egg = JSON.parse(canonical.eggJson)
  assert.equal(egg.meta.version, 'PTDL_v2')
  const model = egg.variables.find(entry => entry.env_variable === 'OPENAI_MODEL')
  assert.ok(model)
  assert.equal(model.rules, 'required|string|max:200')
  assert.ok(!egg.variables.some(entry => entry.env_variable === 'AIRI_PLAYER'))
})

test('committed Pterodactyl artifacts are internally valid', () => {
  const committedSource = readFileSync(join(here, 'payload-src', 'installer.sh'))
  const committedInstall = readFileSync(join(here, 'install.sh'), 'utf8')
  const committedEggText = readFileSync(join(here, 'egg-airi-factorio-server.json'), 'utf8')
  const egg = JSON.parse(committedEggText)

  assert.equal(verifyGeneratedArtifacts(committedSource, committedInstall, committedEggText), true)
  assert.equal(egg.scripts.installation.script, committedInstall)
  assert.match(committedInstall, new RegExp(PAYLOAD_REF))
  assert.match(committedInstall, /EXPECTED_SOURCE_SHA256="c5ae9291b5d8ce16deb4356b20e0c1b2629ff350794393c61500dac8f3836170"/)
})
