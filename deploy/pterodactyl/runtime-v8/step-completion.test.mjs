import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyConditionObservation,
  evaluateCompletionContract,
  makeConditionWait,
  parseStepCompletionDecision,
  sanitizeStepCompletionContract,
  stepCompletionDecisionQuestions,
} from './step-completion.mjs'

test('unsupported or malformed completion semantics fail closed', () => {
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ kind: 'natural_language', predicate: 'looks done' }],
  }).mode, 'semantic_unknown')
})

test('inventory completion requires grounded count truth', () => {
  const contract = sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 }],
  })
  assert.equal(evaluateCompletionContract(contract, {
    plates: { satisfied: false, summary: 'iron-plate=0' },
  }).satisfied, false)
  assert.equal(evaluateCompletionContract(contract, {
    plates: { satisfied: true, summary: 'iron-plate=9' },
  }).satisfied, true)
})

test('entity inventory completion requires exact identity', () => {
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ kind: 'entity_inventory_count', item_name: 'iron-plate', minimum: 9 }],
  }).mode, 'semantic_unknown')
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 9 }],
  }).requirements[0].unit_number, 582)
})

test('Jev completion decision may only select runtime-supplied candidate contracts', () => {
  const candidates = [{
    mode: 'all',
    requirements: [{ id: 'drill', kind: 'inventory_count', item_name: 'burner-mining-drill', minimum: 1 }],
  }]
  const questions = stepCompletionDecisionQuestions(candidates)
  assert.ok(questions.contract.criteria.candidate_1)
  const selected = parseStepCompletionDecision({
    answers: {
      contract: { type: 'choice', choice: 'candidate_1', confidence: 0.91 },
      compound_step: { type: 'noul', noul: 0.1 },
    },
  }, candidates)
  assert.equal(selected.contract.requirements[0].item_name, 'burner-mining-drill')

  const unknown = parseStepCompletionDecision({
    answers: {
      contract: { type: 'choice', choice: 'semantic_unknown', confidence: 0.95 },
      compound_step: { type: 'noul', noul: 0.8 },
    },
  }, candidates)
  assert.equal(unknown.contract.mode, 'semantic_unknown')
})

test('passive progress wait stays active while machine progresses and wakes when it stops', () => {
  const wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { mode: 'passive_progress', goalId: 'goal_1', stepId: 'step_2', maxChecks: 10 },
  )
  const active = applyConditionObservation(wait, { satisfied: true, progressing: true, progress_known: true })
  assert.equal(active.action, 'waiting')
  assert.equal(active.wait.state, 'active')
  const stopped = applyConditionObservation(active.wait, { satisfied: false, progressing: false, progress_known: true })
  assert.equal(stopped.action, 'wake')
  assert.equal(stopped.wait.state, 'satisfied')
})

test('completion wait verifies once and duplicate observations are stale after satisfaction', () => {
  const wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: 'goal_1', stepId: 'step_2', maxChecks: 10 },
  )
  const verified = applyConditionObservation(wait, { satisfied: true, summary: 'iron-plate=10' })
  assert.equal(verified.action, 'verified')
  assert.equal(applyConditionObservation(verified.wait, { satisfied: true }).action, 'stale')
})

test('timeout and exact-identity loss never fake completion', () => {
  const wait = makeConditionWait(
    { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 9 },
    { maxChecks: 1 },
  )
  const timed = applyConditionObservation(wait, { satisfied: false, progressing: true })
  assert.equal(timed.action, 'timeout')
  assert.notEqual(timed.wait.state, 'satisfied')

  const stale = applyConditionObservation(wait, { stale: true })
  assert.equal(stale.action, 'failed')
  assert.equal(stale.reason, 'stale_exact_identity')
})
