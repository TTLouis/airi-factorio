import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decisionEnvelopeQuestions,
  developmentDecisionQuestions,
  granularityDecisionQuestions,
  jevDecisionFamilyChoices,
  parseDecisionEnvelope,
  parseDecisionFamily,
  parseHierarchyTelemetry,
  hierarchyRuntimeGate,
} from './jev-decision-taxonomy.mjs'

test('exposes separate bounded Jev decision families', () => {
  assert.deepEqual(jevDecisionFamilyChoices(), {
    granularity: ['keep', 'split', 'collapse'],
    development: ['vertical', 'horizontal', 'maintain', 'recover'],
    completion: ['incomplete', 'progress', 'completed', 'invalidated'],
    routing: ['wait_runtime', 'continue_runtime', 'wake_planner'],
    reasoning_budget: ['micro', 'normal', 'deep', 'strategic'],
    milestone_transition: ['advance_next', 'replan_project', 'project_complete_candidate'],
  })
})

test('defines vertical and horizontal by intent relative to the active milestone', () => {
  const question = developmentDecisionQuestions().development
  assert.match(question.instructions, /relative to the ACTIVE milestone/i)
  assert.match(question.instructions, /Do not equate technology with vertical or factory expansion with horizontal/i)
  assert.match(question.criteria.vertical, /critical path/i)
  assert.match(question.criteria.vertical, /Extra production can be vertical/i)
  assert.match(question.criteria.horizontal, /already-available capability/i)
  assert.match(question.criteria.horizontal, /critical path is already viable/i)
  assert.match(question.criteria.recover, /invalidated/i)
})

test('keeps Jev responsible for whether to split, not how to split', () => {
  const question = granularityDecisionQuestions().granularity
  assert.match(question.instructions, /Do not invent the decomposition itself/i)
  assert.match(question.instructions, /Main LLM owns how a split is written/i)
  assert.match(question.criteria.split, /multiple independently verifiable/i)
})

test('decision envelope separates wake routing, reasoning, horizon, and observation allowance', () => {
  const questions = decisionEnvelopeQuestions()
  assert.equal(questions.routing.type, 'choice')
  assert.equal(questions.reasoning_budget.type, 'choice')
  assert.equal(questions.planning_horizon.type, 'choice')
  assert.equal(questions.observation_budget.type, 'score')
  assert.match(questions.reasoning_budget.instructions, /Do not scale budget merely because the overall user goal is long/i)
  assert.match(questions.observation_budget.instructions, /targeted read-only observations/i)
  assert.equal(questions.observation_budget.criteria.length, 9)
})

test('parses valid decisions and clamps confidence and observation budget', () => {
  const response = {
    answers: {
      development: { choice: 'vertical', confidence: 1.4 },
      routing: { choice: 'wake_planner', confidence: 0.82 },
      reasoning_budget: { choice: 'deep', confidence: 0.71 },
      planning_horizon: { choice: 'subgoal' },
      observation_budget: { score: 20 },
    },
    model: 'jev-test',
    provider: 'jev',
  }
  assert.deepEqual(parseDecisionFamily(response, 'development', 'maintain'), {
    family: 'development',
    decision: 'vertical',
    confidence: 1,
    model: 'jev-test',
    provider: 'jev',
    usage: undefined,
  })
  assert.deepEqual(parseDecisionEnvelope(response), {
    routing: 'wake_planner',
    routing_confidence: 0.82,
    reasoning_budget: 'deep',
    reasoning_confidence: 0.71,
    planning_horizon: 'subgoal',
    observation_budget: 8,
    model: 'jev-test',
    provider: 'jev',
    usage: undefined,
  })
})

test('uses conservative fallbacks for invalid Jev output', () => {
  const response = {
    answers: {
      routing: { choice: 'teleport' },
      reasoning_budget: { choice: 'infinite' },
      planning_horizon: { choice: 'whole_game' },
      observation_budget: { score: -3 },
    },
  }
  assert.equal(parseDecisionFamily(response, 'granularity', 'keep').decision, 'keep')
  assert.deepEqual(parseDecisionEnvelope(response), {
    routing: 'wake_planner',
    routing_confidence: 0,
    reasoning_budget: 'normal',
    reasoning_confidence: 0,
    planning_horizon: 'checkpoint',
    observation_budget: 0,
    model: undefined,
    provider: undefined,
    usage: undefined,
  })
})

test('parses hierarchy telemetry independently from routing authority', () => {
  const response = {
    answers: {
      granularity: { choice: 'split', confidence: 0.91 },
      development: { choice: 'vertical', confidence: 0.84 },
      reasoning_budget: { choice: 'strategic', confidence: 0.77 },
      planning_horizon: { choice: 'strategic' },
      observation_budget: { score: 4 },
    },
  }
  assert.deepEqual(parseHierarchyTelemetry(response), {
    granularity: 'split',
    granularity_confidence: 0.91,
    development: 'vertical',
    development_confidence: 0.84,
    reasoning_budget: 'strategic',
    reasoning_confidence: 0.77,
    planning_horizon: 'strategic',
    observation_budget: 4,
  })
})

test('runtime gate only skips the planner for maintain+keep on an authoritative completion runtime', () => {
  assert.deepEqual(
    hierarchyRuntimeGate({ granularity: 'keep', development: 'maintain' }, { runtimeHealthy: true, boundary: 'completion' }),
    {
      allow_runtime_continuation: true,
      reason: 'maintain_with_authoritative_runtime',
      granularity: 'keep',
      development: 'maintain',
    },
  )
  assert.equal(hierarchyRuntimeGate({ granularity: 'split', development: 'maintain' }, { runtimeHealthy: true }).allow_runtime_continuation, false)
  assert.equal(hierarchyRuntimeGate({ granularity: 'keep', development: 'vertical' }, { runtimeHealthy: true }).allow_runtime_continuation, false)
  assert.equal(hierarchyRuntimeGate({ granularity: 'keep', development: 'maintain' }, { runtimeHealthy: false }).allow_runtime_continuation, false)
  assert.equal(hierarchyRuntimeGate({ granularity: 'keep', development: 'maintain' }, { runtimeHealthy: true, boundary: 'failure' }).allow_runtime_continuation, false)
})


test('milestone transition decision never grants Jev project-completion authority', async () => {
  const { milestoneTransitionDecisionQuestions, parseMilestoneTransitionDecision } = await import('./jev-decision-taxonomy.mjs')
  const question = milestoneTransitionDecisionQuestions().milestone_transition
  assert.match(question.instructions, /authoritatively verified complete/i)
  assert.match(question.instructions, /Do not claim project completion yourself/i)
  const parsed = parseMilestoneTransitionDecision({
    answers: {
      milestone_transition: { choice: 'advance_next', confidence: 0.88 },
    },
  })
  assert.equal(parsed.decision, 'advance_next')
  assert.equal(parseMilestoneTransitionDecision({ answers: {} }).decision, 'replan_project')
})
