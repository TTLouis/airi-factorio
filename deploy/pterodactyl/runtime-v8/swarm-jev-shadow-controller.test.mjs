import test from 'node:test'
import assert from 'node:assert/strict'

import {
  runSwarmJevRecoveryShadowDecision,
  runSwarmJevShadowDecision,
} from './swarm-jev-shadow-controller.mjs'

test('shadow controller uses the existing decisionProvider(state, questions, options) contract', async () => {
  let seenState
  let seenQuestions
  let seenOptions
  let clock = 100

  const result = await runSwarmJevShadowDecision({
    snapshot: {
      missions: [{ id: 'mission-1', status: 'active', title: 'Automate science' }],
      raw_secret: 'must_not_reach_provider',
    },
    decisionProvider: async (state, questions, options) => {
      seenState = state
      seenQuestions = questions
      seenOptions = options
      clock = 125
      return {
        provider: 'jev',
        model: 'jev-test',
        answers: {
          routing: { choice: 'wait_runtime', confidence: 0.8 },
          granularity: { choice: 'keep', confidence: 0.9 },
          development: { choice: 'maintain', confidence: 0.85 },
          reasoning_budget: { choice: 'micro', confidence: 0.7 },
          planning_horizon: { choice: 'checkpoint' },
          observation_budget: { score: 1 },
        },
      }
    },
    providerOptions: {
      epoch: 3,
      actorId: 18,
    },
    now: () => clock,
  })

  assert.equal(seenState.schema, 'swarm_jev_shadow_v1')
  assert.equal(Object.hasOwn(seenState, 'raw_secret'), false)
  assert.equal(seenQuestions.routing.type, 'choice')
  assert.deepEqual(seenOptions, { epoch: 3, actorId: 18 })
  assert.equal(result.status, 'ok')
  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.equal(result.decision.routing, 'wait_runtime')
  assert.equal(result.decision.development, 'maintain')
  assert.equal(result.latency_ms, 25)
})

test('provider failure is telemetry only and falls back conservatively', async () => {
  let clock = 10
  const result = await runSwarmJevShadowDecision({
    decisionProvider: async () => {
      clock = 17
      throw new Error('decision provider unavailable\nwith noisy details')
    },
    now: () => clock,
  })

  assert.equal(result.status, 'provider_error')
  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.equal(result.error, 'decision provider unavailable with noisy details')
  assert.equal(result.decision.routing, 'wake_planner')
  assert.equal(result.decision.granularity, 'keep')
  assert.equal(result.decision.development, 'maintain')
  assert.equal(result.latency_ms, 7)
})

test('missing provider never blocks the swarm runtime', async () => {
  const result = await runSwarmJevShadowDecision({
    snapshot: {
      runtime: { healthy: true, active: true },
    },
  })

  assert.equal(result.status, 'provider_unavailable')
  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.equal(result.decision.routing, 'wake_planner')
  assert.equal(result.latency_ms, 0)
})

test('invalid Jev choices are normalized to conservative telemetry and still have no effects', async () => {
  const result = await runSwarmJevShadowDecision({
    decisionProvider: async () => ({
      answers: {
        routing: { choice: 'teleport' },
        granularity: { choice: 'explode' },
        development: { choice: 'random' },
        reasoning_budget: { choice: 'infinite' },
        planning_horizon: { choice: 'forever' },
        observation_budget: { score: 999 },
      },
    }),
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.decision.routing, 'wake_planner')
  assert.equal(result.decision.granularity, 'keep')
  assert.equal(result.decision.development, 'maintain')
  assert.equal(result.decision.reasoning_budget, 'normal')
  assert.equal(result.decision.planning_horizon, 'checkpoint')
  assert.equal(result.decision.observation_budget, 8)
  assert.deepEqual(result.effects, [])
})

test('shadow invocation cannot mutate the input snapshot through its projected context', async () => {
  const snapshot = {
    missions: [{ id: 'mission-1', status: 'active', title: 'Automate science' }],
  }
  const before = structuredClone(snapshot)

  await runSwarmJevShadowDecision({
    snapshot,
    decisionProvider: async (state) => {
      state.missions[0].status = 'satisfied'
      return { answers: {} }
    },
  })

  assert.deepEqual(snapshot, before)
})


test('recovery shadow skips Jev entirely while deterministic swarm recovery is pending', async () => {
  let calls = 0
  const result = await runSwarmJevRecoveryShadowDecision({
    recovery: {
      reconciliationActions: [{
        kind: 'release_claim',
        claimId: 'claim-1',
        workId: 'work-1',
        reason: 'body_revision_changed',
      }],
      runtime: { active: true },
    },
    decisionProvider: async () => {
      calls += 1
      throw new Error('must not be called')
    },
  })

  assert.equal(calls, 0)
  assert.equal(result.decision_called, false)
  assert.equal(result.status, 'deterministic_recovery_pending')
  assert.equal(result.route, 'defer_swarm_recovery')
  assert.equal(result.rejection_reason, 'swarm_reconciliation_precedes_jev')
  assert.deepEqual(result.effects, [])
})

test('recovery shadow validates Jev routing against authoritative runtime state', async () => {
  const result = await runSwarmJevRecoveryShadowDecision({
    recovery: {
      reconciliationActions: [],
      runtime: {
        active: false,
        idle: true,
      },
    },
    decisionProvider: async () => ({
      answers: {
        failure_class: { choice: 'runtime_busy' },
        next_recovery: { choice: 'wait_runtime', confidence: 0.8 },
      },
    }),
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.decision_called, true)
  assert.equal(result.requested_route, 'wait_runtime')
  assert.equal(result.route, 'pause_recoverable')
  assert.equal(result.rejection_reason, 'wait_runtime_without_authoritative_active_runtime')
  assert.deepEqual(result.effects, [])
})

test('recovery shadow accepts deterministic close only from authoritative outcome verdict', async () => {
  const decisionProvider = async () => ({
    answers: {
      failure_class: { choice: 'provider_format' },
      next_recovery: { choice: 'deterministic_close', confidence: 0.9 },
    },
  })

  const rejected = await runSwarmJevRecoveryShadowDecision({
    recovery: {
      outcome: { state: 'completed', authoritative: false },
    },
    decisionProvider,
  })
  assert.equal(rejected.route, 'fallback_runtime')

  const accepted = await runSwarmJevRecoveryShadowDecision({
    recovery: {
      outcome: { state: 'completed', authoritative: true },
    },
    decisionProvider,
  })
  assert.equal(accepted.route, 'deterministic_close')
})

test('recovery provider failure stays telemetry-only', async () => {
  const result = await runSwarmJevRecoveryShadowDecision({
    recovery: {
      runtime: { active: true },
    },
    decisionProvider: async () => {
      throw new Error('jev recovery unavailable')
    },
  })

  assert.equal(result.status, 'provider_error')
  assert.equal(result.route, 'fallback_runtime')
  assert.equal(result.decision_called, true)
  assert.deepEqual(result.effects, [])
  assert.equal(result.error, 'jev recovery unavailable')
})
