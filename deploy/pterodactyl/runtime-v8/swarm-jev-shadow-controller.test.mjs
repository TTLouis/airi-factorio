import test from 'node:test'
import assert from 'node:assert/strict'

import { runSwarmJevShadowDecision } from './swarm-jev-shadow-controller.mjs'

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
