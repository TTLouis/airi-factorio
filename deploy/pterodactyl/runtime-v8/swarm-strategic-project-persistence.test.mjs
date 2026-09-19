import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { SwarmStrategicProjectPersistence } from './swarm-strategic-project-persistence.mjs'
import { SwarmStrategicProjectStore } from './swarm-strategic-project-store.mjs'

async function tempFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'swarm-project-store-'))
  return {
    dir,
    filename: path.join(dir, 'strategic-project.json'),
  }
}

test('missing durable file preserves a valid empty global project store', async (t) => {
  const { dir, filename } = await tempFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  const persistence = new SwarmStrategicProjectPersistence({ filename, store })
  const loaded = await persistence.load()

  assert.equal(loaded.loaded, false)
  assert.equal(loaded.board.goal_id, 'goal-rocket')
  assert.equal(loaded.board.title, 'Launch a rocket')
})

test('global strategic project state round-trips through an atomic durable file', async (t) => {
  const { dir, filename } = await tempFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const source = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  source.update({
    current_milestone: { title: 'Automate red science' },
    next_milestones: [{ title: 'Automate green science' }],
    development_direction: 'vertical',
  })

  const writer = new SwarmStrategicProjectPersistence({
    filename,
    store: source,
  })
  await writer.save()

  const restored = new SwarmStrategicProjectStore()
  const reader = new SwarmStrategicProjectPersistence({
    filename,
    store: restored,
  })
  const loaded = await reader.load()

  assert.equal(loaded.loaded, true)
  assert.deepEqual(restored.current(), source.current())

  const stat = await fsp.stat(filename)
  assert.equal(stat.mode & 0o777, 0o600)
})

test('queued writes preserve newest strategic revision on disk', async (t) => {
  const { dir, filename } = await tempFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  let clock = 10
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    now: () => clock,
  })
  const persistence = new SwarmStrategicProjectPersistence({ filename, store })

  store.update({
    current_milestone: { title: 'Bootstrap power' },
  })
  const firstRevision = store.current().revision
  const firstWrite = persistence.save()

  clock = 20
  store.update({
    development_direction: 'vertical',
  })
  const latestRevision = store.current().revision
  const secondWrite = persistence.save()

  await Promise.all([firstWrite, secondWrite])
  await persistence.flush()

  const disk = JSON.parse(await fsp.readFile(filename, 'utf8'))
  assert.equal(disk.board.revision, latestRevision)
  assert.ok(latestRevision > firstRevision)
  assert.equal(disk.board.development_direction, 'vertical')
})

test('corrupt durable project state fails closed instead of silently resetting the goal', async (t) => {
  const { dir, filename } = await tempFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  await fsp.writeFile(filename, '{ definitely not json', 'utf8')
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-original',
    objective: 'Original goal',
  })
  const persistence = new SwarmStrategicProjectPersistence({ filename, store })

  await assert.rejects(() => persistence.load(), /JSON/)
  assert.equal(store.current().goal_id, 'goal-original')
})

test('unsupported durable schema is rejected by the global store restore gate', async (t) => {
  const { dir, filename } = await tempFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  await fsp.writeFile(filename, JSON.stringify({
    schema: 999,
    kind: 'swarm_strategic_project_store',
    board: {
      goal_id: 'goal-bad',
      title: 'Must not load',
    },
  }), 'utf8')

  const store = new SwarmStrategicProjectStore()
  const persistence = new SwarmStrategicProjectPersistence({ filename, store })
  await assert.rejects(() => persistence.load(), /Unsupported strategic project store snapshot/)
})
