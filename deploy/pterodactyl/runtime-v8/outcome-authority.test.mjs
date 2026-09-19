import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authoritativeRuntimeState,
  hasAuthoritativeBlockerEvidence,
  hasAuthoritativeCompletionEvidence,
  isLifecycleMetaStep,
  normalizeCanonicalPlan,
  validateOutcomeCandidate,
} from './outcome-authority.mjs'

test('provider/recovery failure alone can never become durable BLOCKED', () => {
  const decision = validateOutcomeCandidate({
    kind: 'recoverable_provider_failure',
    source: 'strict_recovery',
    reason_code: 'invalid_json',
  }, { world: { task_state: 'idle', queue_length: 0 } })
  assert.equal(decision.accepted, true)
  assert.equal(decision.durable_status, 'paused')
  assert.notEqual(decision.durable_status, 'blocked')
})

test('recoverable provider failure leaves authoritative runtime work active', () => {
  const decision = validateOutcomeCandidate({
    kind: 'recoverable_provider_failure',
    source: 'output_budget_recovery',
    reason_code: 'finish_length',
  }, { world: { task_state: 'walking_to_entity', queue_length: 1 } })
  assert.equal(decision.durable_status, 'active')
})

test('provider or Jev blocker claims are rejected without grounded evidence', () => {
  for (const source of ['main_planner', 'jev', 'strict_recovery', 'action_omission_repair']) {
    const decision = validateOutcomeCandidate({
      kind: 'world_blocked',
      source,
      reason_code: 'claimed_blocker',
      candidate_blocker: 'provider_reported_blocker',
      evidence: [{ kind: 'provider_blocker', summary: 'model says blocked' }],
    })
    assert.equal(decision.accepted, false)
    assert.equal(decision.rejection_reason, 'world_blocked_without_authoritative_evidence')
  }
})

test('authoritative preflight and Autorio failure evidence may ground WORLD_BLOCKED', () => {
  for (const kind of ['operation_preflight_rejection', 'operation_admission_failure', 'operation_error_receipt']) {
    const decision = validateOutcomeCandidate({
      kind: 'world_blocked',
      source: 'deterministic_runtime',
      reason_code: 'runtime_rejection',
      candidate_blocker: 'runtime_rejection',
      evidence: [{ kind, summary: 'authoritative runtime evidence' }],
    })
    assert.equal(decision.accepted, true)
    assert.equal(decision.durable_status, 'blocked')
  }
})

test('COMPLETED requires deterministic/authoritative completion evidence', () => {
  const rejected = validateOutcomeCandidate({ kind: 'verified_complete', source: 'main_planner', reason_code: 'provider_says_done' })
  assert.equal(rejected.accepted, false)
  const accepted = validateOutcomeCandidate({
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'verified_final_step',
    evidence: [{ kind: 'deterministic_verification', ref: 'batch_8' }],
  })
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.durable_status, 'completed')
})

test('runtime_active is independently validated and cannot strand idle queue zero', () => {
  assert.equal(validateOutcomeCandidate({ kind: 'runtime_active', source: 'jev' }, {
    world: { task_state: 'idle', queue_length: 0 },
  }).accepted, false)
  assert.equal(validateOutcomeCandidate({ kind: 'runtime_active', source: 'jev' }, {
    world: { task_state: 'idle', queue_length: 1 },
  }).accepted, true)
})

test('cancelled outcomes require server authority', () => {
  assert.equal(validateOutcomeCandidate({ kind: 'cancelled', source: 'jev' }).accepted, false)
  const paused = validateOutcomeCandidate({
    kind: 'cancelled',
    source: 'server_lifecycle',
    reason_code: 'ui_pause',
    metadata: { server_authoritative: true, transition: 'paused', pause_reason: 'ui_pause' },
  })
  assert.equal(paused.accepted, true)
  assert.equal(paused.durable_status, 'paused')
})

test('canonical plan ingestion removes lifecycle narration but preserves world work and verification', () => {
  const normalized = normalizeCanonicalPlan([
    'Gather coal',
    'Verify at least 20 coal',
    'Report completion to player',
    'Wait for next instruction',
  ], 2)
  assert.deepEqual(normalized.plan, ['Gather coal', 'Verify at least 20 coal'])
  assert.equal(normalized.currentStep, 1)
  assert.equal(isLifecycleMetaStep('Tell the player it is done'), true)
  assert.equal(isLifecycleMetaStep('Wait 120 ticks for smelting'), false)
})

test('authority evidence classes remain intentionally narrow', () => {
  assert.equal(hasAuthoritativeBlockerEvidence([{ kind: 'provider_blocker' }]), false)
  assert.equal(hasAuthoritativeBlockerEvidence([{ kind: 'fresh_world_observation' }]), true)
  assert.equal(hasAuthoritativeCompletionEvidence([{ kind: 'operation_receipt' }]), false)
  assert.equal(hasAuthoritativeCompletionEvidence([{ kind: 'deterministic_verification' }]), true)
  assert.equal(authoritativeRuntimeState({ task_state: 'idle', queue_length: 0 }).idle, true)
})
