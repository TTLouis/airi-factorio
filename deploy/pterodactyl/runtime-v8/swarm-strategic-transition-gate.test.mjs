import test from 'node:test'
import assert from 'node:assert/strict'

import { authorizeStrategicMilestoneCompletion } from './swarm-strategic-transition-gate.mjs'

function verdict(overrides = {}) {
  return {
    authority: 'verdict_only',
    effects: [],
    strategic_milestone: {
      state: 'completed',
      authoritative: true,
      reason: 'strategic_milestone_verified',
    },
    ...overrides,
  }
}

test('only verdict-only authoritative strategic completion is admitted', () => {
  const result = authorizeStrategicMilestoneCompletion(verdict())
  assert.equal(result.authorized, true)
  assert.equal(result.reason, 'strategic_milestone_verified')
})

test('raw booleans and planner claims cannot authorize milestone completion', () => {
  assert.equal(authorizeStrategicMilestoneCompletion(true).authorized, false)
  assert.equal(authorizeStrategicMilestoneCompletion({ verified: true }).authorized, false)
  assert.equal(authorizeStrategicMilestoneCompletion({
    authority: 'planner',
    effects: [],
    strategic_milestone: {
      state: 'completed',
      authoritative: true,
      reason: 'strategic_milestone_verified',
    },
  }).authorized, false)
})

test('non-authoritative or receipt-only progress verdicts cannot close milestone', () => {
  const progress = verdict({
    strategic_milestone: {
      state: 'progress',
      authoritative: false,
      reason: 'strategic_milestone_receipt_only',
    },
  })
  const result = authorizeStrategicMilestoneCompletion(progress)
  assert.equal(result.authorized, false)
  assert.equal(result.reason, 'strategic_milestone_not_authoritatively_complete')
})

test('effect-bearing verdict object is rejected even if it claims completion', () => {
  const result = authorizeStrategicMilestoneCompletion(verdict({
    effects: [{ kind: 'complete_milestone' }],
  }))
  assert.equal(result.authorized, false)
  assert.equal(result.reason, 'outcome_snapshot_has_effects')
})

test('completed verdict with wrong provenance is rejected', () => {
  const result = authorizeStrategicMilestoneCompletion(verdict({
    strategic_milestone: {
      state: 'completed',
      authoritative: true,
      reason: 'model_said_done',
    },
  }))
  assert.equal(result.authorized, false)
  assert.equal(result.reason, 'strategic_milestone_verdict_source_mismatch')
})
