import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AIRI_CONFIG_DEFAULTS, migrateConfig, migrateConfigFile } from './supervisor.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-config-migration-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

test('a fresh (empty) config gains an explicit providerUrl', () => {
  const next = migrateConfig({}, {})
  assert.equal(next.providerUrl, AIRI_CONFIG_DEFAULTS.providerUrl)
})

test('an old config missing providerUrl is migrated to the default while preserving other values', () => {
  const next = migrateConfig({ model: 'foo' }, {})
  assert.equal(next.model, 'foo')
  assert.equal(next.providerUrl, AIRI_CONFIG_DEFAULTS.providerUrl)
  assert.equal(next.actorMode, AIRI_CONFIG_DEFAULTS.actorMode)
})

test('a custom stored providerUrl survives migration when there is no env override', () => {
  const next = migrateConfig({ providerUrl: 'https://custom.example/v1' }, {})
  assert.equal(next.providerUrl, 'https://custom.example/v1')
})

test('OPENAI_API_BASEURL is synchronized into providerUrl so the file reflects the effective endpoint', () => {
  const next = migrateConfig(
    { providerUrl: 'https://stale-stored-value.example/v1' },
    { OPENAI_API_BASEURL: 'https://env-override.example/v1' },
  )
  assert.equal(next.providerUrl, 'https://env-override.example/v1')
})

test('OPENAI_API_KEY is never written into the migrated config', () => {
  const next = migrateConfig({}, { OPENAI_API_KEY: 'super-secret-key' })
  assert.equal('key' in next, false)
  assert.equal('apiKey' in next, false)
  assert.equal(JSON.stringify(next).includes('super-secret-key'), false)
})

test('factorioUsername is stripped from the migrated config, including from a legacy stored value', () => {
  const fresh = migrateConfig({}, { FACTORIO_USERNAME: 'ttlouis' })
  assert.equal('factorioUsername' in fresh, false)

  const legacy = migrateConfig({ factorioUsername: 'ttlouis-old' }, {})
  assert.equal('factorioUsername' in legacy, false)
})

test('migrateConfigFile writes a fresh file with an explicit providerUrl', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  const next = await migrateConfigFile(filename, {})
  const onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, AIRI_CONFIG_DEFAULTS.providerUrl)
  assert.deepEqual(onDisk, next)
})

test('migrateConfigFile migrates an existing file missing providerUrl without discarding user values', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await fsp.writeFile(filename, `${JSON.stringify({ model: 'foo' }, null, 2)}\n`)
  await migrateConfigFile(filename, {})
  const onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.model, 'foo')
  assert.equal(onDisk.providerUrl, AIRI_CONFIG_DEFAULTS.providerUrl)
})

test('migrateConfigFile does not rewrite an already-migrated, unchanged file', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await migrateConfigFile(filename, {})
  const before = (await fsp.stat(filename)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  await migrateConfigFile(filename, {})
  const after = (await fsp.stat(filename)).mtimeMs
  assert.equal(before, after)
})

test('migrateConfigFile keeps providerUrl visible and consistent with OPENAI_API_BASEURL across restarts', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await migrateConfigFile(filename, {})
  let onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, AIRI_CONFIG_DEFAULTS.providerUrl)

  await migrateConfigFile(filename, { OPENAI_API_BASEURL: 'https://env-override.example/v1' })
  onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, 'https://env-override.example/v1')

  // Removing the env override does not erase what was durably written: the
  // env-synced value is now the stored preference, same as if the user had
  // set it directly, until something else overrides or edits it again.
  await migrateConfigFile(filename, {})
  onDisk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(onDisk.providerUrl, 'https://env-override.example/v1')
})

test('migrateConfigFile never persists OPENAI_API_KEY to disk', async (t) => {
  const root = await temp(t)
  const filename = path.join(root, 'airi-config.json')
  await migrateConfigFile(filename, { OPENAI_API_KEY: 'super-secret-key' })
  const text = await fsp.readFile(filename, 'utf8')
  assert.equal(text.includes('super-secret-key'), false)
})
