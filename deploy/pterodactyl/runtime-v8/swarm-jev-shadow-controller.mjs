import {
  buildSwarmJevShadowContext,
  parseSwarmJevShadowDecision,
  swarmJevShadowQuestions,
} from './swarm-jev-shadow.mjs'
import {
  buildSwarmRecoveryCapsule,
  parseSwarmRecoveryDecision,
  swarmRecoveryDecisionQuestions,
  validateSwarmRecoveryRoute,
} from './swarm-recovery-route.mjs'

function cleanError(error, max = 300) {
  const text = String(error instanceof Error ? error.message : error ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export async function runSwarmJevShadowDecision({
  decisionProvider,
  snapshot = {},
  providerOptions = {},
  now = () => Date.now(),
} = {}) {
  const context = buildSwarmJevShadowContext(snapshot)
  const questions = swarmJevShadowQuestions()

  if (typeof decisionProvider !== 'function') {
    return {
      authority: 'shadow',
      effects: [],
      status: 'provider_unavailable',
      context_schema: context.schema,
      question_ids: Object.keys(questions),
      decision: parseSwarmJevShadowDecision({ answers: {} }).decision,
      latency_ms: 0,
    }
  }

  const startedAt = now()
  try {
    const response = await decisionProvider(context, questions, providerOptions)
    const parsed = parseSwarmJevShadowDecision(response)
    return {
      authority: 'shadow',
      effects: [],
      status: 'ok',
      context_schema: context.schema,
      question_ids: Object.keys(questions),
      decision: parsed.decision,
      latency_ms: Math.max(0, now() - startedAt),
    }
  }
  catch (error) {
    return {
      authority: 'shadow',
      effects: [],
      status: 'provider_error',
      context_schema: context.schema,
      question_ids: Object.keys(questions),
      error: cleanError(error),
      decision: parseSwarmJevShadowDecision({ answers: {} }).decision,
      latency_ms: Math.max(0, now() - startedAt),
    }
  }
}


export async function runSwarmJevRecoveryShadowDecision({
  decisionProvider,
  recovery = {},
  providerOptions = {},
  now = () => Date.now(),
} = {}) {
  const capsule = buildSwarmRecoveryCapsule(recovery)
  const questions = swarmRecoveryDecisionQuestions()

  if (capsule.deterministic_recovery_pending) {
    return {
      authority: 'shadow',
      effects: [],
      status: 'deterministic_recovery_pending',
      capsule,
      question_ids: Object.keys(questions),
      requested_route: undefined,
      route: 'defer_swarm_recovery',
      rejection_reason: 'swarm_reconciliation_precedes_jev',
      decision_called: false,
      latency_ms: 0,
    }
  }

  if (typeof decisionProvider !== 'function') {
    return {
      authority: 'shadow',
      effects: [],
      status: 'provider_unavailable',
      capsule,
      question_ids: Object.keys(questions),
      requested_route: 'fallback_runtime',
      route: 'fallback_runtime',
      rejection_reason: '',
      decision_called: false,
      latency_ms: 0,
    }
  }

  const startedAt = now()
  try {
    const response = await decisionProvider(capsule, questions, providerOptions)
    const decision = parseSwarmRecoveryDecision(response)
    const validated = validateSwarmRecoveryRoute(decision, {
      reconciliationActions: recovery.reconciliationActions,
      runtime: recovery.runtime,
      outcome: recovery.outcome,
      observationBudgetAvailable: recovery.observationBudgetAvailable,
      blockerGrounded: recovery.blockerGrounded,
    })
    return {
      authority: 'shadow',
      effects: [],
      status: 'ok',
      capsule,
      question_ids: Object.keys(questions),
      decision,
      decision_called: true,
      ...validated,
      latency_ms: Math.max(0, now() - startedAt),
    }
  }
  catch (error) {
    return {
      authority: 'shadow',
      effects: [],
      status: 'provider_error',
      capsule,
      question_ids: Object.keys(questions),
      error: cleanError(error),
      requested_route: 'fallback_runtime',
      route: 'fallback_runtime',
      rejection_reason: '',
      decision_called: true,
      latency_ms: Math.max(0, now() - startedAt),
    }
  }
}
