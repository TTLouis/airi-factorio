import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SwarmSessionDirectory,
  canonicalMemoryKey,
  displayNameForAgent,
  normalizeSwarmRoster,
  routeSwarmMessage,
} from './swarm-session-router.mjs'

function status(bodyRevision = 1) {
  return {
    actors: [
      {
        actorId: 'actor-1',
        runtime: { state: 'online', bodyRevision, agentId: 'agent-1' },
        agent: { id: 'agent-1', state: 'available' },
      },
      {
        actorId: 'actor-2',
        runtime: { state: 'online', bodyRevision: 2, agentId: 'agent-2' },
        agent: { id: 'agent-2', state: 'working' },
      },
      {
        actorId: 'actor-3',
        runtime: { state: 'missing', bodyRevision: 4, agentId: 'agent-3' },
        agent: { id: 'agent-3', state: 'recovering' },
      },
    ],
  }
}

test('logical agent names and durable keys are deterministic', () => {
  assert.equal(displayNameForAgent('agent-1'), 'AIRI-Astra')
  assert.equal(displayNameForAgent('agent-2'), 'AIRI-Mika')
  assert.equal(displayNameForAgent('agent-65'), 'AIRI-Astra-2')
  assert.equal(canonicalMemoryKey('agent-2'), 'npc:agent-2')
})

test('normalizes live swarm status without treating a missing body as a new identity', () => {
  const roster = normalizeSwarmRoster(status())
  assert.deepEqual(roster.map(item => ({
    agentId: item.agentId,
    actorId: item.actorId,
    displayName: item.displayName,
    available: item.available,
    bodyRevision: item.bodyRevision,
  })), [
    { agentId: 'agent-1', actorId: 'actor-1', displayName: 'AIRI-Astra', available: true, bodyRevision: 1 },
    { agentId: 'agent-2', actorId: 'actor-2', displayName: 'AIRI-Mika', available: true, bodyRevision: 2 },
    { agentId: 'agent-3', actorId: 'actor-3', displayName: 'AIRI-Nova', available: false, bodyRevision: 4 },
  ])
})

test('routes only explicit leading names away from the default agent', () => {
  const roster = normalizeSwarmRoster(status())

  let routed = routeSwarmMessage('@Mika mine copper', roster, 'agent-1')
  assert.equal(routed.kind, 'agent')
  assert.equal(routed.explicit, true)
  assert.equal(routed.agent.agentId, 'agent-2')
  assert.equal(routed.text, 'mine copper')

  routed = routeSwarmMessage('AIRI-Mika: bring me plates', roster, 'agent-1')
  assert.equal(routed.kind, 'agent')
  assert.equal(routed.agent.agentId, 'agent-2')
  assert.equal(routed.text, 'bring me plates')

  routed = routeSwarmMessage('agent-2: defend here', roster, 'agent-1')
  assert.equal(routed.kind, 'agent')
  assert.equal(routed.agent.agentId, 'agent-2')

  routed = routeSwarmMessage('Ask Mika whether copper is nearby', roster, 'agent-1')
  assert.equal(routed.kind, 'agent')
  assert.equal(routed.explicit, false)
  assert.equal(routed.agent.agentId, 'agent-1')
  assert.equal(routed.text, 'Ask Mika whether copper is nearby')
})

test('does not broadcast unknown mentions or unavailable defaults', () => {
  const roster = normalizeSwarmRoster(status())
  const unknown = routeSwarmMessage('@Nobody mine iron', roster, 'agent-1')
  assert.deepEqual(unknown, { kind: 'unknown_target', requested: 'Nobody', text: 'mine iron' })

  const fallback = routeSwarmMessage('continue', roster, 'agent-3')
  assert.equal(fallback.kind, 'agent')
  assert.equal(fallback.agent.agentId, 'agent-1')
})

test('session directory preserves session object and canonical memory across body replacement', () => {
  const created = []
  const directory = new SwarmSessionDirectory(entry => {
    const session = {
      createdFor: entry.agentId,
      canonicalKey: entry.canonicalKey,
      bindings: [],
      bindActor(actorId, revision) {
        this.bindings.push([actorId, revision])
      },
    }
    created.push(session)
    return session
  })

  directory.reconcile(status(1))
  const before = directory.get('agent-1')
  assert.equal(before.displayName, 'AIRI-Astra')
  assert.equal(before.canonicalKey, 'npc:agent-1')

  directory.reconcile(status(9))
  const after = directory.get('agent-1')
  assert.equal(after.session, before.session)
  assert.equal(after.displayName, 'AIRI-Astra')
  assert.equal(after.canonicalKey, 'npc:agent-1')
  assert.deepEqual(after.session.bindings, [['actor-1', 1], ['actor-1', 9]])
  assert.equal(created.filter(item => item.createdFor === 'agent-1').length, 1)
})

test('session directory retains durable session when an agent temporarily disappears from live roster', () => {
  const directory = new SwarmSessionDirectory(entry => ({ id: entry.agentId }))
  directory.reconcile(status())
  const session = directory.get('agent-2').session
  directory.reconcile({ actors: [] })
  const retained = directory.get('agent-2')
  assert.equal(retained.session, session)
  assert.equal(retained.present, false)
  assert.equal(retained.available, false)
})
