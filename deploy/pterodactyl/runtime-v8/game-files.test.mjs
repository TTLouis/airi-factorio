import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { prepareServerSettings } from './game-files.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-game-files-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

async function setupGame(root) {
  const game = path.join(root, 'game')
  await fsp.mkdir(path.join(game, 'data'), { recursive: true })
  const example = {
    name: 'Factorio server',
    description: 'Example server',
    visibility: { public: true, lan: true },
    username: '',
    token: '',
    game_password: '',
    max_players: 0,
    autosave_interval: 10,
    tags: ['example'],
    require_user_verification: true,
  }
  await fsp.writeFile(path.join(game, 'data', 'server-settings.example.json'), JSON.stringify(example, null, 2))
  return game
}

async function readSettings(root) {
  return JSON.parse(await fsp.readFile(path.join(root, 'data', 'server-settings.json'), 'utf8'))
}

test('blank username/token produces a hidden server on first creation', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  await prepareServerSettings(root, game, { username: '', token: '', public: false })
  const settings = await readSettings(root)
  assert.equal(settings.visibility.public, false)
  assert.equal(settings.visibility.lan, false)
  assert.equal(settings.username, '')
  assert.equal(settings.token, '')
  assert.equal(settings.require_user_verification, false)
})

test('matching username/token publishes the server', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  await prepareServerSettings(root, game, { username: 'ttlouis', token: 'dummy-token', public: true })
  const settings = await readSettings(root)
  assert.equal(settings.visibility.public, true)
  assert.equal(settings.visibility.lan, false)
  assert.equal(settings.username, 'ttlouis')
  assert.equal(settings.token, 'dummy-token')
})

test('unrelated settings survive repeated updates', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  await prepareServerSettings(root, game, { username: '', token: '', public: false })
  const data = path.join(root, 'data', 'server-settings.json')
  const first = JSON.parse(await fsp.readFile(data, 'utf8'))
  first.name = 'Custom Name'
  first.description = 'Custom description'
  first.max_players = 12
  first.autosave_interval = 42
  first.tags = ['custom', 'tag']
  await fsp.writeFile(data, JSON.stringify(first, null, 2))

  await prepareServerSettings(root, game, { username: 'ttlouis', token: 'dummy-token', public: true })
  const settings = await readSettings(root)
  assert.equal(settings.name, 'Custom Name')
  assert.equal(settings.description, 'Custom description')
  assert.equal(settings.max_players, 12)
  assert.equal(settings.autosave_interval, 42)
  assert.deepEqual(settings.tags, ['custom', 'tag'])
  assert.equal(settings.visibility.public, true)
  assert.equal(settings.username, 'ttlouis')
  assert.equal(settings.token, 'dummy-token')
})

test('changing environment-derived values updates managed settings without reinstall', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  await prepareServerSettings(root, game, { username: 'ttlouis', token: 'dummy-token', public: true })
  let settings = await readSettings(root)
  assert.equal(settings.visibility.public, true)

  await prepareServerSettings(root, game, { username: '', token: '', public: false })
  settings = await readSettings(root)
  assert.equal(settings.visibility.public, false)
  assert.equal(settings.username, '')
  assert.equal(settings.token, '')
})

test('an unchanged configuration does not rewrite the settings file', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  const factorio = { username: 'ttlouis', token: 'dummy-token', public: true }
  await prepareServerSettings(root, game, factorio)
  const data = path.join(root, 'data', 'server-settings.json')
  const before = (await fsp.stat(data)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  await prepareServerSettings(root, game, factorio)
  const after = (await fsp.stat(data)).mtimeMs
  assert.equal(before, after)
})

test('the secret token is never written to any log-visible location besides server-settings.json', async t => {
  const root = await temp(t)
  const game = await setupGame(root)
  await prepareServerSettings(root, game, { username: 'ttlouis', token: 'super-secret-token', public: true })
  const settingsText = await fsp.readFile(path.join(root, 'data', 'server-settings.json'), 'utf8')
  assert.match(settingsText, /super-secret-token/)
  const gameFiles = await fsp.readdir(path.join(root, 'data'))
  assert.deepEqual(gameFiles, ['server-settings.json'])
})
