import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildArtifacts, installerLoader, verifyGeneratedArtifacts } from './build-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PAYLOAD_REF = '92afd659485f5cb47a912615e669332c85ef9d12'
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
  assert.equal(model.default_value, 'replace-me')
  assert.equal(model.rules, 'required|string|max:200')
  assert.ok(!egg.variables.some(entry => entry.env_variable === 'AIRI_PLAYER'))
  assert.ok(!egg.variables.some(entry => entry.env_variable === 'AIRI_CHAT_PLAYER'))

  const providerUrl = egg.variables.find(entry => entry.env_variable === 'OPENAI_API_BASEURL')
  assert.ok(providerUrl)
  assert.equal(providerUrl.default_value, 'https://provider.invalid/v1')
  assert.equal(providerUrl.rules, 'required|string|url|max:255')

  const chatPlayers = egg.variables.find(entry => entry.env_variable === 'AIRI_CHAT_PLAYERS')
  assert.ok(chatPlayers)
  assert.equal(chatPlayers.default_value, '')
  assert.equal(chatPlayers.rules, 'nullable|string|max:512')

  const providerTimeout = egg.variables.find(entry => entry.env_variable === 'PROVIDER_TIMEOUT_MS')
  assert.ok(providerTimeout)
  assert.equal(providerTimeout.default_value, '120000')
  assert.equal(providerTimeout.rules, 'required|numeric|between:1000,600000')

  const factorioUsername = egg.variables.find(entry => entry.env_variable === 'FACTORIO_USERNAME')
  assert.ok(factorioUsername)
  assert.equal(factorioUsername.default_value, '')
  assert.equal(factorioUsername.user_viewable, true)

  const factorioToken = egg.variables.find(entry => entry.env_variable === 'FACTORIO_TOKEN')
  assert.ok(factorioToken)
  assert.equal(factorioToken.default_value, '')
  assert.equal(factorioToken.user_viewable, false)
})

test('committed Pterodactyl artifacts are internally valid', () => {
  const committedSource = readFileSync(join(here, 'payload-src', 'installer.sh'))
  const committedInstall = readFileSync(join(here, 'install.sh'), 'utf8')
  const committedEggText = readFileSync(join(here, 'egg-airi-factorio-server.json'), 'utf8')
  const egg = JSON.parse(committedEggText)

  assert.equal(verifyGeneratedArtifacts(committedSource, committedInstall, committedEggText), true)
  assert.equal(egg.scripts.installation.script, committedInstall)
  assert.match(committedInstall, new RegExp(PAYLOAD_REF))
  assert.match(committedInstall, /EXPECTED_SOURCE_SHA256="7bcddbab0e959d505a156269340fa2de2fe4c837bc83b0fc9d9f7b6df58dfff1"/)
})
