const SUPPORTED_REQUIREMENT_KINDS = new Set([
  'inventory_count',
  'entity_inventory_count',
  'entity_exists',
  'entity_state',
  'authoritative_operation_receipt',
  'runtime_controller_state',
])

function clean(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const DEFAULT_CONDITION_TIMEOUT_MS = 30 * 60 * 1000
const MAX_CONDITION_TIMEOUT_MS = 2 * 60 * 60 * 1000

function boundedTimeoutMs(value) {
  return Number.isSafeInteger(value)
    ? Math.max(1000, Math.min(value, MAX_CONDITION_TIMEOUT_MS))
    : DEFAULT_CONDITION_TIMEOUT_MS
}

function boundedRequirement(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = String(raw.kind ?? '')
  if (!SUPPORTED_REQUIREMENT_KINDS.has(kind)) return undefined
  const id = clean(raw.id || `requirement_${index + 1}`, 80)
  if (!id) return undefined

  if (kind === 'inventory_count') {
    const minimum = positiveInteger(raw.minimum)
    const itemName = clean(raw.item_name, 160)
    if (!minimum || !itemName) return undefined
    return { id, kind, item_name: itemName, minimum }
  }

  if (kind === 'entity_inventory_count') {
    const unitNumber = positiveInteger(raw.unit_number)
    const minimum = positiveInteger(raw.minimum)
    const itemName = clean(raw.item_name, 160)
    if (!unitNumber || !minimum || !itemName) return undefined
    return { id, kind, unit_number: unitNumber, item_name: itemName, minimum }
  }

  if (kind === 'entity_exists') {
    const unitNumber = positiveInteger(raw.unit_number)
    if (!unitNumber) return undefined
    return { id, kind, unit_number: unitNumber }
  }

  if (kind === 'entity_state') {
    const unitNumber = positiveInteger(raw.unit_number)
    const expected = clean(raw.expected, 80)
    if (!unitNumber || !['working', 'not_working', 'exists'].includes(expected)) return undefined
    return { id, kind, unit_number: unitNumber, expected }
  }

  if (kind === 'authoritative_operation_receipt') {
    const operationName = clean(raw.operation_name, 100)
    if (!operationName) return undefined
    return { id, kind, operation_name: operationName }
  }

  const controller = clean(raw.controller, 80)
  const expected = clean(raw.expected, 80)
  if (!controller || !['active', 'idle', 'healthy'].includes(expected)) return undefined
  return { id, kind, controller, expected }
}

export function sanitizeStepCompletionContract(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: 'semantic_unknown', requirements: [], confidence: 0 }
  }
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0
  if (raw.mode === 'semantic_unknown') return { mode: 'semantic_unknown', requirements: [], confidence }
  if (!['all', 'any'].includes(raw.mode)) return { mode: 'semantic_unknown', requirements: [], confidence }
  const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : []
  if (rawRequirements.length === 0 || rawRequirements.length > 8) {
    return { mode: 'semantic_unknown', requirements: [], confidence }
  }
  const requirements = rawRequirements.map(boundedRequirement)
  if (requirements.some(requirement => !requirement)) {
    return { mode: 'semantic_unknown', requirements: [], confidence }
  }
  const ids = new Set()
  for (const requirement of requirements) {
    if (ids.has(requirement.id)) return { mode: 'semantic_unknown', requirements: [], confidence }
    ids.add(requirement.id)
  }
  return { mode: raw.mode, requirements, confidence, source: clean(raw.source, 80) || undefined }

}

export function completionContractSupported(contract) {
  const normalized = sanitizeStepCompletionContract(contract)
  return normalized.mode !== 'semantic_unknown' && normalized.requirements.length > 0
}


const RECEIPT_SAFE_OPERATION_NAMES = new Set([
  'walk_to_entity',
  'walk_to_entity_exact',
  'walk_to_player',
  'mine_entity',
  'mine_entity_exact',
  'gather_resource',
  'harvest_product',
  'clear_construction_area',
  'place_entity',
  'place_candidate',
  'execute_construction_plan',
  'move_items',
  'move_items_exact',
  'move_items_with_player',
  'supply_entity',
  'set_machine_recipe',
  'craft_item',
  'attack_nearest_enemy',
  'clear_enemy_area',
])

function operationIntentRequirement(operation, index) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined
  const name = clean(operation.name, 100)
  const args = operation.args && typeof operation.args === 'object' && !Array.isArray(operation.args)
    ? operation.args
    : {}

  if (name === 'gather_resource' || name === 'harvest_product') {
    const itemName = clean(name === 'gather_resource' ? args.resource_name : args.product_name, 160)
    const minimum = positiveInteger(args.count)
    if (itemName && minimum) {
      return { id: `intent_${index + 1}`, kind: 'inventory_count', item_name: itemName, minimum }
    }
  }

  if (name === 'craft_item') {
    const itemName = clean(args.item_name, 160)
    const minimum = positiveInteger(args.count)
    if (itemName && minimum) {
      return { id: `intent_${index + 1}`, kind: 'inventory_count', item_name: itemName, minimum }
    }
  }

  if (name === 'supply_entity') {
    const unitNumber = positiveInteger(args.unit_number)
    const items = Array.isArray(args.items) ? args.items : []
    if (unitNumber && items.length === 1) {
      const itemName = clean(items[0]?.item_name, 160)
      const minimum = positiveInteger(items[0]?.count)
      if (itemName && minimum) {
        return { id: `intent_${index + 1}`, kind: 'entity_inventory_count', unit_number: unitNumber, item_name: itemName, minimum }
      }
    }
  }

  if (name === 'move_items_exact' && args.to_entity === true) {
    const unitNumber = positiveInteger(args.unit_number)
    const itemName = clean(args.item_name, 160)
    const minimum = positiveInteger(args.max_count)
    if (unitNumber && itemName && minimum) {
      return { id: `intent_${index + 1}`, kind: 'entity_inventory_count', unit_number: unitNumber, item_name: itemName, minimum }
    }
  }

  if (RECEIPT_SAFE_OPERATION_NAMES.has(name)) {
    return { id: `intent_${index + 1}`, kind: 'authoritative_operation_receipt', operation_name: name }
  }
  return undefined
}

export function completionCandidatesFromOperations(operations = []) {
  const bounded = Array.isArray(operations) ? operations.slice(0, 8) : []
  const intentRequirements = bounded.map(operationIntentRequirement).filter(Boolean)
  const candidates = []

  if (intentRequirements.length > 0) {
    candidates.push({
      mode: 'all',
      source: 'operation_intent',
      requirements: intentRequirements,
    })
  }

  const hasEffectPredicate = intentRequirements.some(requirement => requirement.kind !== 'authoritative_operation_receipt')
  const receiptRequirements = bounded
    .map((operation, index) => {
      const name = clean(operation?.name, 100)
      return RECEIPT_SAFE_OPERATION_NAMES.has(name)
        ? { id: `receipt_${index + 1}`, kind: 'authoritative_operation_receipt', operation_name: name }
        : undefined
    })
    .filter(Boolean)
  // A receipt-only candidate is deliberately weaker than a deterministic
  // effect predicate such as inventory_count. Do not offer Jev the weaker
  // escape hatch when the high-level operation intent already gives runtime a
  // stronger fact to verify.
  if (!hasEffectPredicate && receiptRequirements.length > 0) {
    candidates.push({
      mode: 'all',
      source: 'operation_receipt',
      requirements: receiptRequirements,
    })
  }

  return candidates
}

export function stepCheckpointDecisionQuestions(candidates = []) {
  const base = stepCompletionDecisionQuestions(candidates)
  return {
    ...base,
    checkpoint_boundary: {
      type: 'choice',
      instructions: 'Judge the semantic boundary before execution. Decide whether the proposed operation batch lands on a useful deterministic checkpoint for this canonical step, whether the step should remain open after the batch, or whether the semantic step should be split/replanned before treating this batch as its completion boundary.',
      criteria: {
        checkpoint_here: 'The supplied grounded contract is a good checkpoint for this semantic step. Runtime may close the step only after the contract is deterministically satisfied.',
        keep_step_open: 'The operation batch is useful progress, but it is not a sufficient semantic boundary. Keep the current canonical step open after the batch.',
        split_recommended: 'The canonical step is too compound or ambiguous for the proposed batch/contract boundary. Recommend a planner replan/split rather than pretending this batch closes the step.',
      },
    },
  }
}

export function parseStepCheckpointDecision(response, candidates = []) {
  const normalized = parseStepCompletionDecision(response, candidates)
  const boundary = response?.answers?.checkpoint_boundary?.choice
  return {
    ...normalized,
    boundary: ['checkpoint_here', 'keep_step_open', 'split_recommended'].includes(boundary)
      ? boundary
      : 'keep_step_open',
  }
}

export function stepCompletionDecisionQuestions(candidates = []) {
  const normalized = candidates
    .slice(0, 8)
    .map((candidate, index) => ({
      id: `candidate_${index + 1}`,
      contract: sanitizeStepCompletionContract(candidate),
    }))
    .filter(entry => completionContractSupported(entry.contract))
  const criteria = {
    semantic_unknown: 'No supplied grounded contract safely proves this semantic step complete. Runtime must require explicit verification.',
  }
  for (const entry of normalized) {
    criteria[entry.id] = `Use this runtime-supported grounded completion contract: ${JSON.stringify(entry.contract)}`
  }
  if (Object.keys(criteria).length === 1) {
    criteria.runtime_supported_unknown = 'The runtime supports completion contracts, but no bounded grounded candidate was supplied for this step.'
  }
  return {
    contract: {
      type: 'choice',
      instructions: 'Choose which supplied grounded facts would prove the semantic step complete. You are normalizing semantics only; you do not verify that the facts are currently true.',
      criteria,
    },
    compound_step: {
      type: 'noul',
      instructions: 'Is this semantic step compound enough that one simple requirement would be unsafe as sole completion proof?',
    },
  }
}

export function parseStepCompletionDecision(response, candidates = []) {
  const choice = response?.answers?.contract?.choice
  const confidence = typeof response?.answers?.contract?.confidence === 'number'
    ? Math.max(0, Math.min(1, response.answers.contract.confidence))
    : 0
  const compound = typeof response?.answers?.compound_step?.noul === 'number'
    ? Math.max(0, Math.min(1, response.answers.compound_step.noul))
    : undefined
  if (!choice || choice === 'semantic_unknown' || choice === 'runtime_supported_unknown') {
    return { contract: { mode: 'semantic_unknown', requirements: [], confidence }, compound_probability: compound }
  }
  const match = /^candidate_([1-8])$/.exec(choice)
  if (!match) return { contract: { mode: 'semantic_unknown', requirements: [], confidence }, compound_probability: compound }
  const selected = sanitizeStepCompletionContract(candidates[Number(match[1]) - 1])
  return {
    contract: { ...selected, confidence },
    compound_probability: compound,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

function evaluateRequirementFact(requirement, fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { satisfied: false, missing: true }
  if (fact.kind !== requirement.kind) return { satisfied: false, mismatched: true }
  if (requirement.kind === 'inventory_count') {
    return { satisfied: fact.item_name === requirement.item_name && Number.isFinite(fact.current) && fact.current >= requirement.minimum }
  }
  if (requirement.kind === 'entity_inventory_count') {
    return { satisfied: fact.stale !== true && fact.unit_number === requirement.unit_number && fact.item_name === requirement.item_name && Number.isFinite(fact.current) && fact.current >= requirement.minimum }
  }
  if (requirement.kind === 'entity_exists') {
    return { satisfied: fact.stale !== true && fact.unit_number === requirement.unit_number && fact.exists === true }
  }
  if (requirement.kind === 'entity_state') {
    const exact = fact.stale !== true && fact.unit_number === requirement.unit_number && fact.exists === true
    return { satisfied: requirement.expected === 'exists' ? exact : requirement.expected === 'working' ? exact && fact.working === true : exact && fact.working === false }
  }
  if (requirement.kind === 'authoritative_operation_receipt') {
    const names = Array.isArray(fact.operation_names) ? fact.operation_names : []
    return { satisfied: fact.authoritative === true && (fact.operation_name === requirement.operation_name || names.includes(requirement.operation_name)) }
  }
  return { satisfied: fact.authoritative === true && fact.controller === requirement.controller && fact.state === requirement.expected }
}

export function evaluateCompletionContract(contract, facts = {}) {
  const normalized = sanitizeStepCompletionContract(contract)
  if (normalized.mode === 'semantic_unknown') return { status: 'unknown', satisfied: false, contract: normalized, results: [] }
  const results = normalized.requirements.map(requirement => {
    const fact = facts[requirement.id]
    const evaluated = evaluateRequirementFact(requirement, fact)
    return { id: requirement.id, kind: requirement.kind, ...evaluated, progressing: fact?.progressing === true, summary: clean(fact?.summary, 300) }
  })
  const satisfied = normalized.mode === 'any' ? results.some(result => result.satisfied) : results.every(result => result.satisfied)
  return { status: satisfied ? 'verified' : 'waiting', satisfied, contract: normalized, results }
}

export function conditionFromRequirement(requirement) {
  const normalized = boundedRequirement(requirement, 0)
  if (!normalized) return undefined
  if (!['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'].includes(normalized.kind)) return undefined
  const { id: _requirementId, ...condition } = normalized
  return condition
}

export function makeConditionWait(requirement, {
  id,
  stepId,
  goalId,
  mode = 'completion',
  maxChecks = 900,
  timeoutMs = DEFAULT_CONDITION_TIMEOUT_MS,
  actorId,
  actorEpoch,
  now = Date.now(),
} = {}) {
  const condition = conditionFromRequirement(requirement)
  if (!condition) return undefined
  const lifecycleActorId = positiveInteger(actorId)
  const lifecycleActorEpoch = nonNegativeInteger(actorEpoch)
  return {
    id: clean(id || `condition_${now.toString(36)}`, 100),
    goal_id: clean(goalId, 100),
    step_id: clean(stepId, 80),
    ...(lifecycleActorId !== undefined ? { actor_id: lifecycleActorId } : {}),
    ...(lifecycleActorEpoch !== undefined ? { actor_epoch: lifecycleActorEpoch } : {}),
    mode: mode === 'passive_progress' ? 'passive_progress' : 'completion',
    condition,
    state: 'active',
    checks: 0,
    max_checks: Number.isSafeInteger(maxChecks) ? Math.max(1, Math.min(maxChecks, 7200)) : 900,
    timeout_ms: boundedTimeoutMs(timeoutMs),
    registered_at: now,
    updated_at: now,
  }
}

export function applyConditionObservation(wait, observation, { now = Date.now() } = {}) {
  if (!wait || wait.state !== 'active') return { wait, action: 'stale' }
  const checks = (Number.isSafeInteger(wait.checks) ? wait.checks : 0) + 1
  const base = { ...wait, checks, updated_at: now, last_observation: observation }
  if (observation?.stale === true) return { wait: { ...base, state: 'failed' }, action: 'failed', reason: 'stale_exact_identity' }
  if (observation?.error) return { wait: { ...base, state: 'failed' }, action: 'failed', reason: clean(observation.error, 160) }

  const timedOut = Number.isFinite(wait.registered_at)
    && Number.isSafeInteger(wait.timeout_ms)
    && now - wait.registered_at >= wait.timeout_ms

  if (wait.mode === 'passive_progress') {
    if (timedOut || checks >= wait.max_checks) {
      return { wait: { ...base, state: 'timeout' }, action: 'timeout', reason: 'condition_timeout' }
    }
    if (observation?.progressing === true) return { wait: base, action: 'waiting' }
    return { wait: { ...base, state: 'failed' }, action: 'wake', reason: 'passive_progress_stopped' }
  }

  if (observation?.satisfied === true) return { wait: { ...base, state: 'satisfied' }, action: 'verified' }
  if (timedOut || checks >= wait.max_checks) {
    return { wait: { ...base, state: 'timeout' }, action: 'timeout', reason: 'condition_timeout' }
  }
  if (observation?.progressing === false && observation?.progress_known === true) {
    return { wait: { ...base, state: 'failed' }, action: 'failed', reason: 'condition_unsatisfied_and_not_progressing' }
  }
  return { wait: base, action: 'waiting' }
}
