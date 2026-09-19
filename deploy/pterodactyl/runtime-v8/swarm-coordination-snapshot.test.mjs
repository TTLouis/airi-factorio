import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSwarmCoordinationSnapshot,
  readSwarmCoordinationSnapshot,
} from './swarm-coordination-snapshot.mjs'

function fixture(limit = 2) {
  return {
    schema: 'swarm_coordination_snapshot_v1',
    tick: 600,
    limit,
    counts: {
      missions: 5,
      objectives: 4,
      projects: 3,
      work: 8,
      requests: 2,
      claims: 1,
      results: 6,
      agents: 2,
      actors: 2,
      openWork: 1,
      executingWork: 1,
      blockedWork: 0,
      openRequests: 1,
      activeClaims: 1,
      activeWarnings: 1,
    },
    missions: [{ id: 'mission-1', status: 'active' }],
    objectives: [{ id: 'objective-1', status: 'active' }],
    projects: [{ id: 'project-1', status: 'executing' }],
    work: [{ id: 'work-1', status: 'active' }],
    requests: [{ id: 'request-1', status: 'open' }],
    warnings: [{ id: 'warning-1', active: true }],
    claims: [{ id: 'claim-1', workId: 'work-1' }],
    results: [{ id: 'result-1', workId: 'work-0' }],
    agents: [{ id: 'agent-1', state: 'working' }],
    actors: [{ id: 'actor-1', state: 'online' }],
  }
}

test('parses a bounded canonical coordination snapshot while preserving full counts', () => {
  const parsed = parseSwarmCoordinationSnapshot(fixture(), { requestedLimit: 2 })
  assert.equal(parsed.schema, 'swarm_coordination_snapshot_v1')
  assert.equal(parsed.tick, 600)
  assert.equal(parsed.limit, 2)
  assert.equal(parsed.counts.missions, 5)
  assert.equal(parsed.missions.length, 1)
  assert.equal(parsed.work[0].id, 'work-1')
})

test('parser rejects a snapshot that exceeds the requested bound', () => {
  const value = fixture(3)
  value.missions = [
    { id: 'mission-1', status: 'active' },
    { id: 'mission-2', status: 'active' },
    { id: 'mission-3', status: 'active' },
  ]
  assert.throws(
    () => parseSwarmCoordinationSnapshot(value, { requestedLimit: 2 }),
    /exceeded requested limit/,
  )
})

test('parser rejects malformed counts and missing canonical arrays', () => {
  const badCount = fixture()
  badCount.counts.missions = -1
  assert.throws(() => parseSwarmCoordinationSnapshot(badCount), /count missions/)

  const missing = fixture()
  delete missing.objectives
  assert.throws(() => parseSwarmCoordinationSnapshot(missing), /snapshot objectives/)
})

test('reader calls the single global swarm coordination remote interface', async () => {
  const commands = []
  const rcon = {
    async command(command) {
      commands.push(command)
      return JSON.stringify(fixture(12))
    },
  }

  const parsed = await readSwarmCoordinationSnapshot(rcon, { limit: 12 })
  assert.equal(parsed.tick, 600)
  assert.deepEqual(commands, [
    '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_swarm_coordination","snapshot",12)))',
  ])
})

test('reader clamps external requested limits before crossing RCON', async () => {
  let command = ''
  const value = fixture(32)
  const rcon = {
    async command(input) {
      command = input
      return JSON.stringify(value)
    },
  }

  const parsed = await readSwarmCoordinationSnapshot(rcon, { limit: 999 })
  assert.equal(parsed.limit, 32)
  assert.match(command, /"snapshot",32/)
})

test('parsed records do not share mutable references with supplied objects', () => {
  const value = fixture()
  const parsed = parseSwarmCoordinationSnapshot(value)
  parsed.missions[0].status = 'satisfied'
  assert.equal(value.missions[0].status, 'active')
})
