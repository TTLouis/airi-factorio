import test from 'node:test'
import assert from 'node:assert/strict'

import { SwarmProjectJevMonitor } from './swarm-project-jev-monitor.mjs'

function snapshot({
  tick = 100,
  eventCursor = 'event-1',
  executingWork = 0,
  activeClaims = 0,
} = {}) {
  return {
    schema: 'swarm_coordination_snapshot_v1',
    tick,
    eventCursor,
    limit: 12,
    counts: {
      missions: 1,
      incompleteMissions: 1,
      objectives: 1,
      incompleteObjectives: 1,
      projects: 1,
      incompleteProjects: 1,
      work: 1,
      requests: 0,
      claims: activeClaims,
      results: 0,
      agents: 1,
      actors: 1,
      openWork: executingWork > 0 ? 0 : 1,
      executingWork,
      blockedWork: 0,
      openRequests: 0,
      activeClaims,
      activeWarnings: 0,
    },
    missions: [{ id: 'mission-1', status: 'active' }],
    objectives: [{ id: 'objective-1', status: 'active' }],
    projects: [{ id: 'project-1', status: 'executing' }],
    work: executingWork > 0
      ? [{ id: 'work-1', status: 'active' }]
      : [{ id: 'work-1', status: 'open' }],
    requests: [],
    warnings: [],
    claims: activeClaims > 0 ? [{ id: 'claim-1', workId: 'work-1' }] : [],
    results: [],
    agents: [{ id: 'agent-1', state: executingWork > 0 ? 'working' : 'available' }],
    actors: [{ id: 'actor-1', state: 'online' }],
  }
}

function rconFrom(values) {
  let index = 0
  return {
    calls: 0,
    async command() {
      this.calls += 1
      const value = values[Math.min(index, values.length - 1)]
      index += 1
      return JSON.stringify(value)
    },
  }
}

test('initial monitor poll reads once and triggers one global Jev cycle', async () => {
  const rcon = rconFrom([snapshot()])
  const seen = []
  const service = {
    async trigger(reason, options) {
      seen.push({ reason, snapshot: structuredClone(options.snapshot) })
      return { authority: 'shadow', effects: [], scope: 'swarm_global' }
    },
  }
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service,
    strategicBoard: () => ({ revision: 1 }),
  })

  const result = await monitor.poll()
  assert.equal(rcon.calls, 1)
  assert.equal(result.triggered, true)
  assert.deepEqual(result.reasons, ['initial_snapshot'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].snapshot.tick, 100)
})

test('tick-only poll updates do not trigger another Jev decision', async () => {
  const rcon = rconFrom([
    snapshot({ tick: 100 }),
    snapshot({ tick: 101 }),
  ])
  let triggers = 0
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service: {
      async trigger() {
        triggers += 1
        return { authority: 'shadow', effects: [] }
      },
    },
    strategicBoard: () => ({ revision: 1 }),
  })

  const first = await monitor.poll()
  const second = await monitor.poll()

  assert.equal(first.triggered, true)
  assert.equal(second.triggered, false)
  assert.equal(second.reason, 'no_semantic_change')
  assert.equal(rcon.calls, 2)
  assert.equal(triggers, 1)
})

test('blackboard cursor change triggers with the same preloaded snapshot', async () => {
  const rcon = rconFrom([
    snapshot({ tick: 100, eventCursor: 'event-1' }),
    snapshot({ tick: 101, eventCursor: 'event-2' }),
  ])
  const seen = []
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service: {
      async trigger(reason, { snapshot: current }) {
        seen.push({ reason, tick: current.tick, cursor: current.eventCursor })
        return { authority: 'shadow', effects: [] }
      },
    },
  })

  await monitor.poll()
  const result = await monitor.poll()

  assert.equal(result.triggered, true)
  assert.ok(result.reasons.includes('coordination_event'))
  assert.deepEqual(seen.at(-1), {
    reason: 'coordination_event',
    tick: 101,
    cursor: 'event-2',
  })
})

test('strategic board revision change triggers even with no Factorio coordination event', async () => {
  const rcon = rconFrom([
    snapshot(),
    snapshot({ tick: 101 }),
  ])
  let revision = 1
  let triggers = 0
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service: {
      async trigger() {
        triggers += 1
        return { authority: 'shadow', effects: [] }
      },
    },
    strategicBoard: () => ({ revision }),
  })

  await monitor.poll()
  revision = 2
  const result = await monitor.poll()

  assert.equal(result.triggered, true)
  assert.deepEqual(result.reasons, ['strategic_board_changed'])
  assert.equal(triggers, 2)
})

test('busy to quiescent transition triggers project review', async () => {
  const rcon = rconFrom([
    snapshot({ executingWork: 1, activeClaims: 1 }),
    snapshot({ tick: 101, executingWork: 0, activeClaims: 0 }),
  ])
  const reasons = []
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service: {
      async trigger(reason) {
        reasons.push(reason)
        return { authority: 'shadow', effects: [] }
      },
    },
  })

  await monitor.poll()
  const result = await monitor.poll()

  assert.ok(result.reasons.includes('runtime_became_quiescent'))
  assert.ok(reasons.at(-1).includes('runtime_became_quiescent'))
})

test('concurrent monitor polls coalesce into one RCON read', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let calls = 0
  const rcon = {
    async command() {
      calls += 1
      await blocked
      return JSON.stringify(snapshot())
    },
  }
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service: {
      async trigger() {
        return { authority: 'shadow', effects: [] }
      },
    },
  })

  const first = monitor.poll()
  const second = monitor.poll()
  const third = monitor.poll()

  assert.strictEqual(first, second)
  assert.strictEqual(second, third)
  assert.equal(calls, 1)

  release()
  await first
  assert.equal(calls, 1)
})

test('resetBaseline forces the next valid snapshot to become a fresh initial trigger', async () => {
  const rcon = rconFrom([snapshot(), snapshot({ tick: 101 })])
  let triggers = 0
  const monitor = new SwarmProjectJevMonitor({
    rcon,
    service: {
      async trigger() {
        triggers += 1
        return { authority: 'shadow', effects: [] }
      },
    },
  })

  await monitor.poll()
  monitor.resetBaseline()
  const result = await monitor.poll()

  assert.equal(result.triggered, true)
  assert.deepEqual(result.reasons, ['initial_snapshot'])
  assert.equal(triggers, 2)
})
