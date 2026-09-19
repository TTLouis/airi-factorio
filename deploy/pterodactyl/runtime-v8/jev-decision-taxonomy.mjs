const FAMILY_CHOICES = Object.freeze({
  granularity: ['keep', 'split', 'collapse'],
  development: ['vertical', 'horizontal', 'maintain', 'recover'],
  completion: ['incomplete', 'progress', 'completed', 'invalidated'],
  routing: ['wait_runtime', 'continue_runtime', 'wake_planner'],
  reasoning_budget: ['micro', 'normal', 'deep', 'strategic'],
  milestone_transition: ['advance_next', 'replan_project', 'project_complete_candidate'],
})

const PLANNING_HORIZONS = new Set(['immediate', 'checkpoint', 'subgoal', 'strategic'])

function clampConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

function boundedInteger(value, fallback = 0, maximum = 8) {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(maximum, value)) : fallback
}

function choiceOf(response, key) {
  return response?.answers?.[key]?.choice
}

function choiceConfidence(response, key) {
  return clampConfidence(response?.answers?.[key]?.confidence)
}

export function jevDecisionFamilyChoices() {
  return FAMILY_CHOICES
}

export function granularityDecisionQuestions() {
  return {
    granularity: {
      type: 'choice',
      instructions: 'Judge only whether the current semantic objective is at the right level for bounded planning/execution. Do not invent the decomposition itself; the Main LLM owns how a split is written.',
      criteria: {
        keep: 'The current objective is already a bounded milestone or plan-step-sized problem and can be planned/executed without another hierarchy layer.',
        split: 'The current objective spans multiple independently verifiable capability changes or phases and should be decomposed before direct execution.',
        collapse: 'The current decomposition is unnecessarily fragmented and adjacent work can safely be represented as one coherent semantic objective.',
      },
    },
  }
}

export function developmentDecisionQuestions() {
  return {
    development: {
      type: 'choice',
      instructions: 'Classify the intent of the next strategic move relative to the ACTIVE milestone and its critical path. Do not equate technology with vertical or factory expansion with horizontal; classify by why the work is needed.',
      criteria: {
        vertical: 'Advance the active milestone critical path by unlocking a required capability or removing a prerequisite blocker. Extra production can be vertical when insufficient capacity is itself the current blocker.',
        horizontal: 'Strengthen an already-available capability for sustained or future demand: capacity, redundancy, logistics, coverage, buffers, resource access, throughput, or reliability, when the current critical path is already viable.',
        maintain: 'The current plan and capability are valid; continue ordinary execution or deterministic passive progress without strategic redirection.',
        recover: 'The world invalidated the current plan/capability and the immediate need is to restore a valid state, such as after death, destruction, stale identity, lost power, exhausted access, or another invalidating change.',
      },
    },
  }
}

export function completionDecisionQuestions() {
  return {
    completion: {
      type: 'choice',
      instructions: 'Classify the semantic outcome from supplied authoritative evidence. An operation name or attempted action is not by itself proof that the semantic objective is complete.',
      criteria: {
        incomplete: 'The objective remains unsatisfied and the evidence does not yet establish meaningful forward progress.',
        progress: 'Authoritative evidence shows meaningful progress, but the objective is not yet satisfied.',
        completed: 'Authoritative evidence is sufficient to close the semantic objective.',
        invalidated: 'The objective/checkpoint can no longer be evaluated as planned because its assumptions or target state became invalid.',
      },
    },
  }
}

export function routingDecisionQuestions() {
  return {
    routing: {
      type: 'choice',
      instructions: 'Decide whether the Main LLM must wake now. Prefer runtime continuation/wait when deterministic work is already healthy and no new strategy is required.',
      criteria: {
        wait_runtime: 'An already-started deterministic process is healthy and the runtime should wait for its condition/checkpoint without waking the Main LLM.',
        continue_runtime: 'The next bounded continuation is already parameterized and can proceed through deterministic runtime control without new strategic reasoning.',
        wake_planner: 'New semantic reasoning, decomposition, strategy, or replanning is required before safe useful progress can continue.',
      },
    },
  }
}

export function milestoneTransitionDecisionQuestions() {
  return {
    milestone_transition: {
      type: 'choice',
      instructions: 'The current milestone has already been authoritatively verified complete by runtime outcome authority. Decide what strategic transition is needed next. Do not claim project completion yourself and do not invent milestone content.',
      criteria: {
        advance_next: 'The first tentative next milestone is still a sensible immediate continuation of the user project from the current world state.',
        replan_project: 'The queued next milestone is missing, stale, poorly scoped, or no longer the best immediate continuation; wake the Main LLM to choose a new bounded milestone.',
        project_complete_candidate: 'The evidence suggests the user-level project goal itself may now be satisfied; wake the Main LLM for grounded final-goal verification rather than completing it here.',
      },
    },
  }
}

export function parseMilestoneTransitionDecision(response) {
  return parseDecisionFamily(response, 'milestone_transition', 'replan_project')
}

export function reasoningBudgetDecisionQuestions() {
  return {
    reasoning_budget: {
      type: 'choice',
      instructions: 'Choose the semantic reasoning budget for the NEXT Main LLM decision only. Do not scale budget merely because the overall user goal is long; base it on the complexity and uncertainty of the immediate decision.',
      criteria: {
        micro: 'The next decision is nearly determined by grounded state and needs minimal reasoning.',
        normal: 'The next decision is ordinary bounded planning with limited dependencies and branching.',
        deep: 'The next decision has substantial dependency depth, uncertainty, branching, or conflicting world state and merits stronger reasoning.',
        strategic: 'The next decision changes milestone/project direction, performs major decomposition, or chooses among consequential long-horizon alternatives.',
      },
    },
  }
}

export function decisionEnvelopeQuestions() {
  return {
    ...routingDecisionQuestions(),
    ...reasoningBudgetDecisionQuestions(),
    planning_horizon: {
      type: 'choice',
      instructions: 'Choose how far the Main LLM should plan on this wake. Use the shortest horizon that can resolve the current semantic problem.',
      criteria: {
        immediate: 'Plan only the next concrete action or tightly bounded step.',
        checkpoint: 'Plan far enough to reach the active verification checkpoint.',
        subgoal: 'Plan enough work to resolve the current milestone-sized subproblem.',
        strategic: 'Plan or revise project/milestone direction.',
      },
    },
    observation_budget: {
      type: 'number',
      instructions: 'Maximum count of independent targeted read-only observations justified before the planner must act, block truthfully, or return for another control decision. Use 0 when current grounded evidence is enough. Runtime will clamp and enforce this budget.',
      min: 0,
      max: 8,
    },
  }
}

export function parseDecisionFamily(response, family, fallback) {
  const choices = FAMILY_CHOICES[family]
  if (!choices) throw new Error(`Unknown Jev decision family: ${family}`)
  const selected = choiceOf(response, family)
  const safeFallback = choices.includes(fallback) ? fallback : choices[0]
  return {
    family,
    decision: choices.includes(selected) ? selected : safeFallback,
    confidence: choiceConfidence(response, family),
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function parseHierarchyTelemetry(response) {
  const granularity = parseDecisionFamily(response, 'granularity', 'keep')
  const development = parseDecisionFamily(response, 'development', 'maintain')
  const reasoning = parseDecisionFamily(response, 'reasoning_budget', 'normal')
  const horizon = choiceOf(response, 'planning_horizon')
  return {
    granularity: granularity.decision,
    granularity_confidence: granularity.confidence,
    development: development.decision,
    development_confidence: development.confidence,
    reasoning_budget: reasoning.decision,
    reasoning_confidence: reasoning.confidence,
    planning_horizon: PLANNING_HORIZONS.has(horizon) ? horizon : 'checkpoint',
    observation_budget: boundedInteger(response?.answers?.observation_budget?.number, 0, 8),
  }
}

export function parseDecisionEnvelope(response) {
  const routing = parseDecisionFamily(response, 'routing', 'wake_planner')
  const hierarchy = parseHierarchyTelemetry(response)
  return {
    routing: routing.decision,
    routing_confidence: routing.confidence,
    ...hierarchy,
    model: routing.model,
    provider: routing.provider,
    usage: routing.usage,
  }
}

export function hierarchyRuntimeGate(hierarchy, { runtimeHealthy = false, boundary = 'completion' } = {}) {
  const granularity = FAMILY_CHOICES.granularity.includes(hierarchy?.granularity) ? hierarchy.granularity : 'keep'
  const development = FAMILY_CHOICES.development.includes(hierarchy?.development) ? hierarchy.development : 'maintain'
  if (boundary !== 'completion') {
    return { allow_runtime_continuation: false, reason: 'non_completion_boundary', granularity, development }
  }
  if (runtimeHealthy !== true) {
    return { allow_runtime_continuation: false, reason: 'no_authoritative_active_runtime', granularity, development }
  }
  if (granularity !== 'keep') {
    return { allow_runtime_continuation: false, reason: 'granularity_requires_planner', granularity, development }
  }
  if (development !== 'maintain') {
    return { allow_runtime_continuation: false, reason: 'development_requires_planner', granularity, development }
  }
  return { allow_runtime_continuation: true, reason: 'maintain_with_authoritative_runtime', granularity, development }
}
