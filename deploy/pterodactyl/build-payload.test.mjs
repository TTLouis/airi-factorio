import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildArtifacts, channelInstaller, installerLoader, verifyGeneratedArtifacts } from './build-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PAYLOAD_REF = 'd6a6ba815cb724c9622d8a980a9c781cc60c0cb8'
const source = Buffer.from(`#!/usr/bin/env bash
AIRI_REF="0123456789abcdef0123456789abcdef01234567"
REVISION="test"
DEPLOYMENT_REVISION="airi-deploy-v8-test"
AIRI_ACTOR_MODE="\${AIRI_ACTOR_MODE:-npc}"
AIRI_CHAT_PLAYERS="\${AIRI_CHAT_PLAYERS:-}"
echo "$DEPLOYMENT_REVISION $AIRI_ACTOR_MODE $AIRI_CHAT_PLAYERS"
`)

test('swarm channel follows latest swarm branch only on reinstall', () => {
  const script = channelInstaller(source)
  assert.match(script, /DEFAULT_SOURCE_REF="feat\/swarm-pterodactyl-playable"/)
  assert.match(script, /CHANNEL="swarm-e2e"/)
  assert.match(script, /Resolved \$SOURCE_REF -> \$RESOLVED_SHA/)
  assert.match(script, /AIRI_REF=/)
  assert.match(script, /REVISION=/)
  assert.match(script, /restart keeps the installed exact SHA/)
})

test('bootstrap remains immutable and checksummed', () => {
  const script = installerLoader(source)
  assert.match(script, new RegExp(PAYLOAD_REF))
  assert.match(script, /EXPECTED_SOURCE_SHA256="[a-f0-9]{64}"/)
  assert.match(script, /--verify-only/)
})

test('swarm egg exposes current Pterodactyl environment contract', () => {
  const { eggJson } = buildArtifacts(source)
  const egg = JSON.parse(eggJson)
  const vars = Object.fromEntries(egg.variables.map(entry => [entry.env_variable, entry]))
  assert.equal(vars.AIRI_SOURCE_REF.default_value, 'feat/swarm-pterodactyl-playable')
  for (const name of ['AIRI_CHAT_PLAYERS', 'OPENAI_MODEL', 'OPENAI_API_BASEURL', 'PROVIDER_TIMEOUT_MS', 'FACTORIO_USERNAME', 'FACTORIO_TOKEN', 'MAX_PROVIDER_REQUESTS_PER_HOUR']) assert.ok(vars[name], name)
  assert.equal(vars.OPENAI_API_KEY.user_viewable, false)
  assert.equal(vars.FACTORIO_TOKEN.user_viewable, false)
  assert.ok(!vars.AIRI_CHAT_PLAYER)
})

test('generated artifact verifier rejects drift', () => {
  const canonical = buildArtifacts(source)
  assert.equal(verifyGeneratedArtifacts(source, canonical.installScript, canonical.eggJson), true)
  assert.throws(() => verifyGeneratedArtifacts(Buffer.concat([source, Buffer.from('# drift\n')]), canonical.installScript, canonical.eggJson), /stale/)
})

test('committed Pterodactyl artifacts are internally valid', () => {
  const committedSource = readFileSync(join(here, 'payload-src', 'installer.sh'))
  const committedInstall = readFileSync(join(here, 'install.sh'), 'utf8')
  const committedEggText = readFileSync(join(here, 'egg-airi-factorio-server.json'), 'utf8')
  assert.equal(verifyGeneratedArtifacts(committedSource, committedInstall, committedEggText), true)
})
