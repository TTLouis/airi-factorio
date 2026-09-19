export const SWARM_RECOVERY_FAILURE_CLASSES = new Set([
  'provider_format',
  'provider_budget',
  'missing_fact',
  'semantic_replan',
  'runtime_busy',
  'grounded_world_failure',
  'unknown',
])

export const SWARM_JEV_RECOVERY_ROUTES = new Set([
  'deterministic_close',
  'wait_runtime',
  'targeted_observation',
  'retry_compact',
  'continue_low',
  'replan_high',
  'pause_recoverable',
  'propose_blocker',
  'fallback_runtime',
])

function clamp01(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

export function swarmRecoveryFailureClassHint(reason) {
  const text = String(reason ?? '')
  if (/finish=length|output budget|provider_output_budget_exhausted/i.test(text)) return 'provider_budget'
  if (/invalid provider|invalid json|strict json|malformed|parse/i.test(text)) return 'provider_format'
  if (/observation|missing fact|fresh mutable fact/i.test(text)) return 'missing_fact'
  if (/strategy|replan|dependency/i.test(text)) return 'semantic_replan'
  return 'unknown'
}

export function swarmRecoveryDecisionQuestions() {
  return {
    failure_class: {
      type: 'choice',
      instructions: 'Classify only the unresolved semantic/provider failure after deterministic swarm reconciliation has had first priority. Do not invent actor, claim, lease, or world facts.',
      criteria: {
        provider_format: 'Malformed or invalid provider response/tool-call formatting.',
        provider_budget: 'Provider output budget or finish=length exhaustion.',
        missing_fact: 'Exactly one bounded fresh fact may resolve the next decision.',
        semantic_replan: 'The remaining strategy requires semantic reconsideration.',
        runtime_busy: 'Authoritative swarm/runtime work is already active.',
        grounded_world_failure: 'Supplied canonical swarm evidence supports a real blocker.',
        unknown: 'The bounded capsule is insufficient to classify safely.',
      },
    },
    next_recovery: {
      type: 'choice',
      instructions: 'Choose the smallest bounded semantic recovery. Runtime validates the route. Deterministic swarm actor/claim reconciliation always takes precedence.',
      criteria: {
        deterministic_close: 'Existing authoritative outcome evidence already proves the semantic target complete.',
        wait_runtime: 'Authoritative runtime or a healthy condition watcher is active.',
        targeted_observation: 'Exactly one admissible observation is needed.',
        retry_compact: 'Retry once with compact context.',
        continue_low: 'Continue once with compact low-reasoning context.',
        replan_high: 'Wake the planner because strategy changed.',
        pause_recoverable: 'No authoritative work is active; preserve state and pause.',
        propose_blocker: 'Canonical evidence supports a real blocker.',
        fallback_runtime: 'Use the existing safe runtime fallback.',
      },
    },
  }
}

export function parseSwarmRecoveryDecision(response) {
  const failure = response?.answers?.failure_class?.choice
  const route = response?.answers?.next_recovery?.choice
  if (!SWARM_RECOVERY_FAILURE_CLASSES.has(failure)) {
    throw new Error('Decision provider returned invalid swarm recovery failure class')
  }
  if (!SWARM_JEV_RECOVERY_ROUTES.has(route)) {
    throw new Error('Decision provider returned invalid swarm recovery route')
  }
  return {
    failure_class: failure,
    route,
    confidence: clamp01(response?.answers?.next_recovery?.confidence),
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function deterministicSwarmRecoveryPending(reconciliationActions) {
  return Array.isArray(reconciliationActions) && reconciliationActions.length > 0
}

export function shouldInvokeSwarmRecoveryJev({ reconciliationActions = [] } = {}) {
  return !deterministicSwarmRecoveryPending(reconciliationActions)
}

function authoritativeRuntimeState(runtime = {}) {
  const conditionWaitActive = runtime?.condition_wait_active === true
    || runtime?.condition_wait?.state === 'active'
  const active = runtime?.active === true
    || runtime?.authoritative_active === true
    || conditionWaitActive === true
  const idle = runtime?.idle === true
    || (
      runtime?.active === false
      && runtime?.authoritative_active !== true
      && conditionWaitActive !== true
    )
  return {
    active,
    idle,
    condition_wait_active: conditionWaitActive,
  }
}

function finalCompletionProven(outcome) {
  return outcome?.state === 'completed' && outcome?.authoritative === true
}

export function validateSwarmRecoveryRoute(decision, {
  reconciliationActions = [],
  runtime = {},
  outcome,
  observationBudgetAvailable = true,
  blockerGrounded = false,
} = {}) {
  const requested = SWARM_JEV_RECOVERY_ROUTES.has(decision?.route)
    ? decision.route
    : 'fallback_runtime'
  const runtimeState = authoritativeRuntimeState(runtime)

  if (deterministicSwarmRecoveryPending(reconciliationActions)) {
    return {
      requested_route: requested,
      route: 'defer_swarm_recovery',
      rejection_reason: 'swarm_reconciliation_precedes_jev',
      runtime: runtimeState,
      deterministic_recovery_actions: reconciliationActions.length,
    }
  }

  let route = requested
  let rejection_reason = ''

  if (route === 'deterministic_close' && !finalCompletionProven(outcome)) {
    route = 'fallback_runtime'
    rejection_reason = 'deterministic_close_without_authoritative_completion'
  }
  else if (route === 'wait_runtime' && !runtimeState.active) {
    route = runtimeState.idle ? 'pause_recoverable' : 'fallback_runtime'
    rejection_reason = 'wait_runtime_without_authoritative_active_runtime'
  }
  else if (route === 'pause_recoverable' && !runtimeState.idle) {
    route = runtimeState.active ? 'wait_runtime' : 'fallback_runtime'
    rejection_reason = 'pause_recoverable_requires_authoritative_idle'
  }
  else if (route === 'targeted_observation' && observationBudgetAvailable !== true) {
    route = 'fallback_runtime'
    rejection_reason = 'targeted_observation_budget_exhausted'
  }
  else if (route === 'propose_blocker' && blockerGrounded !== true) {
    route = runtimeState.active
      ? 'wait_runtime'
      : runtimeState.idle
        ? 'pause_recoverable'
        : 'fallback_runtime'
    rejection_reason = 'blocker_proposal_without_canonical_evidence'
  }

  return {
    requested_route: requested,
    route,
    rejection_reason,
    runtime: runtimeState,
    deterministic_recovery_actions: 0,
  }
}
