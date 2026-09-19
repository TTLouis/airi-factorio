import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSwarmRecoveryCapsule,
  deterministicSwarmRecoveryPending,
  parseSwarmRecoveryDecision,
  shouldInvokeSwarmRecoveryJev,
  swarmRecoveryDecisionQuestions,
  swarmRecoveryFailureClassHint,
  validateSwarmRecoveryRoute,
} from './swarm-recovery-route.mjs'

function response(route, failure = 'unknown') {
  return {
    model: 'jev-test',
    provider: 'jev',
    answers: {
      failure_class: { choice: failure },
      next_recovery: { choice: route, confidence: 0.91 },
    },
  }
}

test('recovery questions explicitly defer actor and claim reconciliation to swarm runtime', () => {
  const questions = swarmRecoveryDecisionQuestions()
  assert.match(questions.failure_class.instructions, /after deterministic swarm reconciliation has had first priority/i)
  assert.match(questions.next_recovery.instructions, /actor\/claim reconciliation always takes precedence/i)
})

test('deterministic swarm reconciliation suppresses Jev recovery routing entirely', () => {
  const actions = [{
    kind: 'release_claim',
    claimId: 'claim-1',
    workId: 'work-1',
    reason: 'body_revision_changed',
  }]

  assert.equal(deterministicSwarmRecoveryPending(actions), true)
  assert.equal(shouldInvokeSwarmRecoveryJev({ reconciliationActions: actions }), false)

  const validated = validateSwarmRecoveryRoute(
    parseSwarmRecoveryDecision(response('replan_high', 'semantic_replan')),
    { reconciliationActions: actions },
  )
  assert.equal(validated.requested_route, 'replan_high')
  assert.equal(validated.route, 'defer_swarm_recovery')
  assert.equal(validated.rejection_reason, 'swarm_reconciliation_precedes_jev')
  assert.equal(validated.deterministic_recovery_actions, 1)
})

test('Jev becomes eligible only after deterministic reconciliation is clear', () => {
  assert.equal(shouldInvokeSwarmRecoveryJev({ reconciliationActions: [] }), true)
  const validated = validateSwarmRecoveryRoute(
    parseSwarmRecoveryDecision(response('replan_high', 'semantic_replan')),
    { reconciliationActions: [] },
  )
  assert.equal(validated.route, 'replan_high')
})

test('deterministic close requires independent authoritative outcome verdict', () => {
  const decision = parseSwarmRecoveryDecision(response('deterministic_close', 'provider_format'))

  const rejected = validateSwarmRecoveryRoute(decision, {
    outcome: { state: 'completed', authoritative: false },
  })
  assert.equal(rejected.route, 'fallback_runtime')
  assert.equal(rejected.rejection_reason, 'deterministic_close_without_authoritative_completion')

  const accepted = validateSwarmRecoveryRoute(decision, {
    outcome: { state: 'completed', authoritative: true },
  })
  assert.equal(accepted.route, 'deterministic_close')
})

test('healthy swarm condition watcher counts as authoritative runtime activity', () => {
  const decision = parseSwarmRecoveryDecision(response('wait_runtime', 'runtime_busy'))
  const validated = validateSwarmRecoveryRoute(decision, {
    runtime: {
      active: false,
      condition_wait: { state: 'active' },
    },
  })
  assert.equal(validated.route, 'wait_runtime')
  assert.equal(validated.runtime.condition_wait_active, true)
})

test('idle runtime rejects wait and uses recoverable pause', () => {
  const decision = parseSwarmRecoveryDecision(response('wait_runtime', 'runtime_busy'))
  const validated = validateSwarmRecoveryRoute(decision, {
    runtime: { active: false, idle: true },
  })
  assert.equal(validated.route, 'pause_recoverable')
  assert.equal(validated.rejection_reason, 'wait_runtime_without_authoritative_active_runtime')
})

test('blocker proposal requires canonical evidence gate outside Jev', () => {
  const decision = parseSwarmRecoveryDecision(response('propose_blocker', 'grounded_world_failure'))
  const rejected = validateSwarmRecoveryRoute(decision, {
    runtime: { idle: true },
    blockerGrounded: false,
  })
  assert.equal(rejected.route, 'pause_recoverable')
  assert.equal(rejected.rejection_reason, 'blocker_proposal_without_canonical_evidence')

  const accepted = validateSwarmRecoveryRoute(decision, {
    runtime: { idle: true },
    blockerGrounded: true,
  })
  assert.equal(accepted.route, 'propose_blocker')
})

test('observation budget remains a hard runtime gate', () => {
  const decision = parseSwarmRecoveryDecision(response('targeted_observation', 'missing_fact'))
  assert.equal(validateSwarmRecoveryRoute(decision, {
    observationBudgetAvailable: true,
  }).route, 'targeted_observation')

  const rejected = validateSwarmRecoveryRoute(decision, {
    observationBudgetAvailable: false,
  })
  assert.equal(rejected.route, 'fallback_runtime')
  assert.equal(rejected.rejection_reason, 'targeted_observation_budget_exhausted')
})

test('failure hint never invents grounded world failure from a text error', () => {
  assert.equal(swarmRecoveryFailureClassHint('invalid provider JSON'), 'provider_format')
  assert.equal(swarmRecoveryFailureClassHint('finish=length output budget exhausted'), 'provider_budget')
  assert.equal(swarmRecoveryFailureClassHint('one fresh mutable fact is missing'), 'missing_fact')
  assert.equal(swarmRecoveryFailureClassHint('turret destroyed and everything is terrible'), 'unknown')
})


test('recovery capsule is shadow-only and suppresses Jev while reconciliation is pending', () => {
  const capsule = buildSwarmRecoveryCapsule({
    reason: 'invalid provider JSON',
    reconciliationActions: [{
      kind: 'release_claim',
      claimId: 'claim-1',
      workId: 'work-1',
      reason: 'body_revision_changed',
    }],
    runtime: {
      active: true,
    },
    outcome: {
      state: 'progress',
      authoritative: true,
      reason: 'mission_progress',
    },
    observationBudgetAvailable: false,
    blockerGrounded: false,
  })

  assert.equal(capsule.authority, 'shadow')
  assert.deepEqual(capsule.effects, [])
  assert.equal(capsule.deterministic_recovery_pending, true)
  assert.equal(capsule.deterministic_recovery_actions, 1)
  assert.equal(capsule.jev_eligible, false)
  assert.equal(capsule.failure_class_hint, 'provider_format')
  assert.equal(capsule.runtime.active, true)
  assert.equal(capsule.observation_budget_available, false)
})
