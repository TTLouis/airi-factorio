import assert from 'node:assert/strict'
import test from 'node:test'

import { AIRI_CONFIG_DEFAULTS, configuration, migrateConfig, Session } from './supervisor.mjs'

const env = {
  AIRI_ACTOR_MODE: 'npc',
  OPENAI_API_KEY: 'test-key-1234',
  OPENAI_API_BASEURL: 'https://api.example.test/v1',
}

test('provider timeout is a migrated non-secret config with a Pterodactyl env override', () => {
  assert.equal(AIRI_CONFIG_DEFAULTS.providerTimeoutMs, 120000)
  assert.equal(migrateConfig({}, {}).providerTimeoutMs, 120000)
  assert.equal(configuration({}, env).providerTimeoutMs, 120000)
  assert.equal(configuration({}, { ...env, PROVIDER_TIMEOUT_MS: '90000' }).providerTimeoutMs, 90000)
})

function sessionFixture() {
  const logs = []
  const commands = []
  const session = new Session({
    root: '/tmp',
    app: '/tmp',
    game: '/tmp',
    config: { chatPlayers: { mode: 'all', names: [] } },
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
    log: message => logs.push(message),
  })
  session.ready = true
  session.rcon = {
    command: async text => {
      commands.push(text)
      return 'ok'
    },
  }
  session.ensureAuthorization = async () => ({ actor_id: 18, epoch: 3 })
  return { session, logs, commands }
}

test('chat provider failure is reported in game and the event queue remains usable', async () => {
  const { session, logs, commands } = sessionFixture()
  let requests = 0
  session.agent = {
    active: false,
    request: async () => {
      requests++
      if (requests === 1) throw new Error('Provider timed out after 120000 ms')
      return { chatMessage: 'Recovered.' }
    },
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('2026-09-14 20:00:00 [CHAT] Louis: !airi first')
  await session.eventQueue
  assert.ok(logs.includes('Provider timed out after 120000 ms'))
  assert.ok(commands.some(command => command.includes('Request failed: Provider timed out after 120000 ms')))

  session.onGameLine('2026-09-14 20:00:01 [CHAT] Louis: !airi second')
  await session.eventQueue
  assert.ok(commands.some(command => command.includes('Recovered.')))
})

test('!airi stop cancels an in-flight model turn immediately and reports that the plan is paused', async () => {
  const { session, commands } = sessionFixture()
  let cancelled = 0
  let releaseQueue
  session.eventQueue = new Promise(resolve => { releaseQueue = resolve })
  session.agent = {
    active: true,
    request: async () => null,
    completed: async () => null,
    cancel: () => { cancelled++ },
  }

  session.onGameLine('2026-09-14 20:00:00 [CHAT] Louis: !airi stop')
  assert.equal(cancelled, 1)
  releaseQueue()
  await session.eventQueue
  assert.ok(commands.some(command => command.includes('airi_deployment')))
  assert.ok(commands.some(command => command.includes('Paused the current AIRI plan')))
})