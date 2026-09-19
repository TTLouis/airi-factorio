import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSwarmJevShadowContext,
  parseSwarmJevShadowDecision,
  swarmJevShadowQuestions,
  validateSwarmJevShadowDecision,
} from './swarm-jev-shadow.mjs'

test('shadow controller exposes Jev envelope questions without action authority', () => {
  const questions = swarmJevShadowQuestions()
  assert.equal(questions.routing.type, 'choice')
  assert.equal(questions.reasoning_budget.type, 'choice')
  assert.equal(questions.planning_horizon.type, 'choice')
  assert.equal(questions.observation_budget.type, 'score')
})

test('builds a bounded swarm snapshot for Jev instead of raw coordination state', () => {
  const context = buildSwarmJevShadowContext({
    project: {
      id: 'project-1',
      title: 'Automate blue science',
      status: 'active',
      current_milestone: { title: 'Establish oil processing' },
      development_direction: 'vertical',
    },
    missions: Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, status: 'active', title: `mission ${index}` })),
    requests: [{ id: 'r-1', status: 'open', kind: 'material_request' }],
    work: [{ id: 'w-1', status: 'claimed', description: 'Bring steel' }],
    claims: [{ claimId: 'c-1', status: 'active' }],
    actors: [{ agentId: 'agent-1', state: 'online' }],
    runtime: { healthy: true, active: true },
    evidence: [{ kind: 'result', id: 'e-1', summary: 'work completed' }],
  })

  assert.equal(context.schema, 'swarm_jev_shadow_v1')
  assert.equal(context.project.milestone, 'Establish oil processing')
  assert.equal(context.missions.length, 12)
  assert.equal(context.counts.missions, 20)
  assert.equal(context.runtime.healthy, true)
})

test('shadow decisions are telemetry only and can never directly mutate swarm state', () => {
  const parsed = parseSwarmJevShadowDecision({
    answers: {
      routing: { choice: 'wake_planner', confidence: 0.9 },
      granularity: { choice: 'split', confidence: 0.8 },
      development: { choice: 'vertical', confidence: 0.85 },
      reasoning_budget: { choice: 'strategic', confidence: 0.75 },
      planning_horizon: { choice: 'strategic' },
      observation_budget: { score: 3 },
    },
  })

  assert.equal(parsed.authority, 'shadow')
  assert.deepEqual(parsed.effects, [])
  assert.equal(parsed.decision.routing, 'wake_planner')
  assert.equal(parsed.decision.granularity, 'split')
  assert.equal(parsed.decision.development, 'vertical')
  assert.equal(validateSwarmJevShadowDecision(parsed), true)
  assert.equal(validateSwarmJevShadowDecision({ ...parsed, effects: ['mutate'] }), false)
})

test('invalid Jev output keeps conservative planner wake defaults even in shadow mode', () => {
  const parsed = parseSwarmJevShadowDecision({ answers: {} })
  assert.equal(parsed.decision.routing, 'wake_planner')
  assert.equal(parsed.decision.granularity, 'keep')
  assert.equal(parsed.decision.development, 'maintain')
  assert.equal(parsed.decision.reasoning_budget, 'normal')
  assert.equal(parsed.decision.planning_horizon, 'checkpoint')
  assert.equal(parsed.decision.observation_budget, 0)
})
