import test from 'node:test'
import assert from 'node:assert/strict'

import { projectJevTriggerReasons } from './swarm-project-jev-trigger-policy.mjs'

function snapshot(overrides = {}) {
  return {
    schema: 'swarm_coordination_snapshot_v1',
    tick: 100,
    eventCursor: 'event-1',
    counts: {
      incompleteMissions: 1,
      incompleteObjectives: 2,
      incompleteProjects: 1,
      executingWork: 1,
      blockedWork: 0,
      openRequests: 0,
      activeClaims: 1,
      activeWarnings: 0,
      ...overrides,
    },
  }
}

test('initial canonical snapshot triggers one project Jev observation', () => {
  const result = projectJevTriggerReasons(undefined, snapshot())
  assert.equal(result.trigger, true)
  assert.deepEqual(result.reasons, ['initial_snapshot'])
})

test('simulation tick change alone does not spend another Jev decision', () => {
  const before = snapshot()
  const after = snapshot()
  after.tick = 1000

  const result = projectJevTriggerReasons(before, after, {
    previousBoard: { revision: 4 },
    currentBoard: { revision: 4 },
  })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, 'no_semantic_change')
})

test('blackboard event cursor change triggers even when aggregate counts stay equal', () => {
  const before = snapshot()
  const after = snapshot()
  after.eventCursor = 'event-2'

  const result = projectJevTriggerReasons(before, after)
  assert.equal(result.trigger, true)
  assert.deepEqual(result.reasons, ['coordination_event'])
})

test('strategic board revision change triggers independently of Factorio event cursor', () => {
  const before = snapshot()
  const after = snapshot()

  const result = projectJevTriggerReasons(before, after, {
    previousBoard: { revision: 4 },
    currentBoard: { revision: 5 },
  })
  assert.equal(result.trigger, true)
  assert.deepEqual(result.reasons, ['strategic_board_changed'])
})

test('runtime busy to quiescent transition triggers a strategic checkpoint', () => {
  const before = snapshot()
  const after = snapshot({
    executingWork: 0,
    activeClaims: 0,
  })

  const result = projectJevTriggerReasons(before, after)
  assert.equal(result.trigger, true)
  assert.ok(result.reasons.includes('runtime_became_quiescent'))
})

test('runtime idle to active transition triggers once', () => {
  const before = snapshot({
    executingWork: 0,
    activeClaims: 0,
  })
  const after = snapshot({
    executingWork: 1,
    activeClaims: 1,
  })

  const result = projectJevTriggerReasons(before, after)
  assert.equal(result.trigger, true)
  assert.ok(result.reasons.includes('runtime_became_active'))
})

test('blocker appearance or clearance triggers a project-level review', () => {
  const before = snapshot()
  const blocked = snapshot({
    blockedWork: 1,
    activeWarnings: 1,
  })

  const appeared = projectJevTriggerReasons(before, blocked)
  assert.ok(appeared.reasons.includes('blocker_state_changed'))

  const cleared = projectJevTriggerReasons(blocked, before)
  assert.ok(cleared.reasons.includes('blocker_state_changed'))
})

test('hierarchy completion count changes trigger even if sampled records are unchanged', () => {
  const before = snapshot()
  const after = snapshot({
    incompleteMissions: 0,
    incompleteObjectives: 0,
    incompleteProjects: 0,
  })

  const result = projectJevTriggerReasons(before, after)
  assert.ok(result.reasons.includes('hierarchy_completion_changed'))
})

test('open request pressure changes trigger bounded strategic review', () => {
  const before = snapshot({ openRequests: 0 })
  const after = snapshot({ openRequests: 2 })

  const result = projectJevTriggerReasons(before, after)
  assert.ok(result.reasons.includes('request_pressure_changed'))
})

test('invalid current snapshot fails closed without requesting Jev', () => {
  const result = projectJevTriggerReasons(snapshot(), { schema: 'wrong' })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, 'invalid_current_snapshot')
})
