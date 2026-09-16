import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareServerSettings } from './game-files.mjs'
import { configuration, migrateConfigFile, Session } from './supervisor.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-config-authority-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

async function setupGame(root) {
  const game = path.join(root, 'game')
  await fsp.mkdir(path.join(game, 'data'), { recursive: true })
  await fsp.writeFile(path.join(game, 'data', 'server-settings.example.json'), JSON.stringify({
    name: 'Factorio server',
    description: 'Example server',
    visibility: { public: true, lan: true },
    username: '',
    token: '',
    game_password: '',
    max_players: 0,
    require_user_verification: true,
  }, null, 2))
  return game
}

function fixtureSecret(label) {
  return `fixture-${label}-${'x'.repeat(16)}`
}

function eggEnv(overrides = {}) {
  return {
    AIRI_ACTOR_MODE: 'npc',
    AIRI_CHAT_PLAYERS: 'Alice,Bob',
    OPENAI_API_KEY: fixtureSecret('provider-key'),
    OPENAI_MODEL: 'egg-model-a',
    OPENAI_API_BASEURL: 'https://provider-a.example.test/v1',
    PROVIDER_TIMEOUT_MS: '150000',
    SAVE_NAME: 'egg-a.zip',
    SERVER_PORT: '35123',
    MAX_PROVIDER_REQUESTS_PER_HOUR: '333',
    SHUTDOWN_TIMEOUT_MS: '71000',
    FACTORIO_USERNAME: 'egg-user',
    FACTORIO_TOKEN: fixtureSecret('factorio-token'),
    ...overrides,
  }
}

test('Egg environment overrides stored runtime config and is synchronized into airi-config.json on every restart', async t => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  const legacyProviderKey = fixtureSecret('legacy-provider-key')
  const legacyFactorioToken = fixtureSecret('legacy-factorio-token')
  const stored = {
    actorMode: 'npc',
    chatPlayers: 'StoredPlayer',
    providerUrl: 'https://stored.example.test/v1',
    model: 'stored-model',
    save: 'stored.zip',
    providerTimeoutMs: 1001,
    gamePort: 35001,
    maxProviderRequestsPerHour: 2,
    shutdownTimeoutMs: 2001,
    key: legacyProviderKey,
    apiKey: legacyProviderKey,
    factorioUsername: 'stored-user',
    factorioToken: legacyFactorioToken,
    unknownLegacyField: 'drop-me',
  }
  await fsp.writeFile(filename, `${JSON.stringify(stored, null, 2)}\n`)

  const firstEnv = eggEnv()
  const direct = configuration(stored, firstEnv)
  assert.equal(direct.actorMode, 'npc')
  assert.deepEqual(direct.chatPlayers, { mode: 'allowlist', names: ['Alice', 'Bob'] })
  assert.equal(direct.model, 'egg-model-a')
  assert.equal(direct.base, 'https://provider-a.example.test/v1')
  assert.equal(direct.key, firstEnv.OPENAI_API_KEY)
  assert.equal(direct.providerTimeoutMs, 150000)
  assert.equal(direct.save, 'egg-a.zip')
  assert.equal(direct.gamePort, 35123)
  assert.equal(direct.budget, 333)
  assert.equal(direct.stopMs, 71000)
  assert.deepEqual(direct.factorio, {
    username: 'egg-user',
    token: firstEnv.FACTORIO_TOKEN,
    public: true,
  })

  const firstPersisted = await migrateConfigFile(filename, firstEnv)
  assert.deepEqual(firstPersisted, {
    actorMode: 'npc',
    chatPlayers: 'Alice,Bob',
    providerUrl: 'https://provider-a.example.test/v1',
    model: 'egg-model-a',
    save: 'egg-a.zip',
    providerTimeoutMs: 150000,
    gamePort: 35123,
    maxProviderRequestsPerHour: 333,
    shutdownTimeoutMs: 71000,
  })
  let fileText = await fsp.readFile(filename, 'utf8')
  assert.equal(fileText.includes(firstEnv.OPENAI_API_KEY), false)
  assert.equal(fileText.includes(firstEnv.FACTORIO_TOKEN), false)
  assert.equal(fileText.includes(legacyProviderKey), false)
  assert.equal(fileText.includes(legacyFactorioToken), false)
  assert.equal(fileText.includes('factorioUsername'), false)
  assert.equal(fileText.includes('unknownLegacyField'), false)

  const secondEnv = eggEnv({
    AIRI_CHAT_PLAYERS: 'none',
    OPENAI_API_KEY: fixtureSecret('provider-key-b'),
    OPENAI_MODEL: 'egg-model-b',
    OPENAI_API_BASEURL: 'https://provider-b.example.test/v1',
    PROVIDER_TIMEOUT_MS: '190000',
    SAVE_NAME: '',
    SERVER_PORT: '35234',
    MAX_PROVIDER_REQUESTS_PER_HOUR: '444',
    SHUTDOWN_TIMEOUT_MS: '82000',
    FACTORIO_USERNAME: '',
    FACTORIO_TOKEN: '',
  })
  const secondPersisted = await migrateConfigFile(filename, secondEnv)
  const secondEffective = configuration(secondPersisted, secondEnv)

  assert.deepEqual(secondPersisted, {
    actorMode: 'npc',
    chatPlayers: 'none',
    providerUrl: 'https://provider-b.example.test/v1',
    model: 'egg-model-b',
    save: '',
    providerTimeoutMs: 190000,
    gamePort: 35234,
    maxProviderRequestsPerHour: 444,
    shutdownTimeoutMs: 82000,
  })
  assert.deepEqual(secondEffective.chatPlayers, { mode: 'disabled', names: [] })
  assert.equal(secondEffective.model, 'egg-model-b')
  assert.equal(secondEffective.base, 'https://provider-b.example.test/v1')
  assert.equal(secondEffective.key, secondEnv.OPENAI_API_KEY)
  assert.equal(secondEffective.providerTimeoutMs, 190000)
  assert.equal(secondEffective.save, '')
  assert.equal(secondEffective.gamePort, 35234)
  assert.equal(secondEffective.budget, 444)
  assert.equal(secondEffective.stopMs, 82000)
  assert.deepEqual(secondEffective.factorio, { username: '', token: '', public: false })

  fileText = await fsp.readFile(filename, 'utf8')
  assert.equal(fileText.includes(secondEnv.OPENAI_API_KEY), false)
  assert.equal(fileText.includes('FACTORIO_TOKEN'), false)
})

test('Factorio Egg credentials are rewritten into the exact launched server-settings.json on restart', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  const firstEnv = eggEnv()
  const firstConfig = configuration({}, firstEnv)
  const settingsFile = await prepareServerSettings(root, game, firstConfig.factorio)
  assert.equal(settingsFile, path.join(root, 'data', 'server-settings.json'))

  let settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'))
  assert.equal(settings.visibility.public, true)
  assert.equal(settings.visibility.lan, false)
  assert.equal(settings.require_user_verification, true)
  assert.equal(settings.username, 'egg-user')
  assert.equal(settings.token, firstEnv.FACTORIO_TOKEN)

  const firstSession = new Session({
    root,
    app: root,
    game,
    config: firstConfig,
    save: path.join(root, 'saves', 'world.zip'),
    settingsFile,
    modDir: path.join(root, 'mods-run'),
    ini: path.join(root, 'config.ini'),
    log: () => {},
  })
  const firstArgs = firstSession.gameArgs(40001)
  assert.equal(firstArgs[firstArgs.indexOf('--server-settings') + 1], settingsFile)

  const secondEnv = eggEnv({ FACTORIO_USERNAME: '', FACTORIO_TOKEN: '' })
  const secondConfig = configuration({}, secondEnv)
  const settingsAfterRestart = await prepareServerSettings(root, game, secondConfig.factorio)
  assert.equal(settingsAfterRestart, settingsFile)

  settings = JSON.parse(await fsp.readFile(settingsAfterRestart, 'utf8'))
  assert.equal(settings.visibility.public, false)
  assert.equal(settings.visibility.lan, false)
  assert.equal(settings.require_user_verification, false)
  assert.equal(settings.username, '')
  assert.equal(settings.token, '')

  const secondSession = new Session({
    root,
    app: root,
    game,
    config: secondConfig,
    save: path.join(root, 'saves', 'world.zip'),
    settingsFile: settingsAfterRestart,
    modDir: path.join(root, 'mods-run'),
    ini: path.join(root, 'config.ini'),
    log: () => {},
  })
  const secondArgs = secondSession.gameArgs(40002)
  assert.equal(secondArgs[secondArgs.indexOf('--server-settings') + 1], settingsAfterRestart)
})
