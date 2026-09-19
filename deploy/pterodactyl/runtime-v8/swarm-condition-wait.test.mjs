import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applySwarmConditionObservation,
  makeSwarmConditionWait,
  observeSwarmWaitCondition,
  pollSwarmConditionWait,
  sanitizeSwarmWaitCondition,
} from './swarm-condition-wait.mjs'

test('only bounded exact swarm record status waits are admitted', () => {
  assert.deepEqual(sanitizeSwarmWaitCondition({
    kind: 'request_status',
    record_id: 'request-1',
    expected_status: 'anything-from-model-is-ignored',
  }), {
    kind: 'request_status',
    record_id: 'request-1',
    expected_status: 'satisfied',
    min_revision: undefined,
  })

  assert.equal(sanitizeSwarmWaitCondition({
    kind: 'arbitrary_expression',
    record_id: 'x',
  }), undefined)
})

test('swarm waits use simulation ticks and are not tied to actor identity', () => {
  const wait = makeSwarmConditionWait({
    kind: 'work_status',
    record_id: 'work-1',
  }, {
    registeredTick: 600,
    ownerGoalId: 'goal-1',
    ownerMilestoneId: 'milestone-1',
  })

  assert.equal(wait.registered_tick, 600)
  assert.equal(wait.updated_tick, 600)
  assert.equal(Object.hasOwn(wait, 'registered_at'), false)
  assert.equal(Object.hasOwn(wait, 'actor_id'), false)
  assert.equal(Object.hasOwn(wait, 'actor_epoch'), false)
})

test('exact record status observation verifies only the canonical success state', () => {
  const condition = {
    kind: 'work_status',
    record_id: 'work-1',
  }

  const active = observeSwarmWaitCondition(condition, {
    work: [{ id: 'work-1', status: 'active', revision: 4 }],
  })
  assert.equal(active.satisfied, false)
  assert.equal(active.progressing, true)

  const completed = observeSwarmWaitCondition(condition, {
    work: [{ id: 'work-1', status: 'completed', revision: 5 }],
  })
  assert.equal(completed.satisfied, true)
  assert.equal(completed.status, 'completed')
})

test('missing exact identity fails closed instead of matching a replacement record', () => {
  const observation = observeSwarmWaitCondition({
    kind: 'request_status',
    record_id: 'request-old',
  }, {
    requests: [{ id: 'request-new', status: 'satisfied', revision: 1 }],
  })

  assert.equal(observation.stale, true)
  assert.equal(observation.error, 'exact_target_missing')
  assert.equal(observation.satisfied, false)
})

test('revision regression invalidates the watcher', () => {
  const observation = observeSwarmWaitCondition({
    kind: 'mission_status',
    record_id: 'mission-1',
    min_revision: 8,
  }, {
    missions: [{ id: 'mission-1', status: 'active', revision: 7 }],
  })

  assert.equal(observation.stale, true)
  assert.equal(observation.error, 'target_revision_regressed')
})

test('successful deterministic condition verification never mutates the target snapshot', () => {
  const snapshot = {
    requests: [{ id: 'request-1', status: 'satisfied', revision: 3 }],
  }
  const before = structuredClone(snapshot)
  const wait = makeSwarmConditionWait({
    kind: 'request_status',
    record_id: 'request-1',
  }, {
    registeredTick: 100,
  })

  const result = pollSwarmConditionWait(wait, snapshot, { tick: 120 })
  assert.equal(result.action, 'verified')
  assert.equal(result.wait.state, 'satisfied')
  assert.deepEqual(snapshot, before)
})

test('terminal unsatisfied target wakes instead of faking completion', () => {
  const wait = makeSwarmConditionWait({
    kind: 'work_status',
    record_id: 'work-1',
  }, {
    registeredTick: 100,
  })

  const result = pollSwarmConditionWait(wait, {
    work: [{ id: 'work-1', status: 'cancelled', revision: 2 }],
  }, { tick: 130 })

  assert.equal(result.action, 'wake')
  assert.equal(result.reason, 'target_terminal_without_satisfaction')
  assert.notEqual(result.wait.state, 'satisfied')
})

test('timeouts advance only with simulation tick', () => {
  const wait = makeSwarmConditionWait({
    kind: 'objective_status',
    record_id: 'objective-1',
  }, {
    registeredTick: 100,
    timeoutTicks: 60,
  })

  const stillWaiting = applySwarmConditionObservation(wait, {
    satisfied: false,
    progressing: true,
    progress_known: true,
  }, { tick: 159 })
  assert.equal(stillWaiting.action, 'waiting')

  const timedOut = applySwarmConditionObservation(wait, {
    satisfied: false,
    progressing: true,
    progress_known: true,
  }, { tick: 160 })
  assert.equal(timedOut.action, 'timeout')
  assert.equal(timedOut.reason, 'condition_timeout')
})

test('missing simulation tick fails closed', () => {
  const wait = makeSwarmConditionWait({
    kind: 'mission_status',
    record_id: 'mission-1',
  }, {
    registeredTick: 100,
  })

  const result = applySwarmConditionObservation(wait, {
    satisfied: false,
    progressing: true,
  })
  assert.equal(result.action, 'failed')
  assert.equal(result.reason, 'missing_simulation_tick')
})

test('project wait understands swarm Project completion, not Strategic Project Board completion', () => {
  const result = observeSwarmWaitCondition({
    kind: 'project_status',
    record_id: 'project-1',
  }, {
    projects: [{ id: 'project-1', status: 'complete', revision: 4 }],
    strategic_project_board: {
      goal_id: 'project-1',
      status: 'completed',
    },
  })

  assert.equal(result.satisfied, true)
  assert.equal(result.status, 'complete')
})
