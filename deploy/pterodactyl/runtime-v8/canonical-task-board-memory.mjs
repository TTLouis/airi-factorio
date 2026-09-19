import { NpcDialogueMemory } from './npc-agent-loop.mjs'
import { setTaskBoardStatus } from './common.mjs'

const STRICT_TASKS_BY_OPERATION = new Map([
  ['wait', ['waiting']],
  ['walk_to_entity', ['walking_to_entity']],
  ['walk_to_entity_exact', ['walking_to_entity']],
  ['walk_to_player', ['walking_to_entity']],
  ['mine_entity', ['mining']],
  ['mine_entity_exact', ['mining']],
  ['gather_resource', ['walking_to_entity', 'mining']],
  ['harvest_product', ['harvesting']],
  ['clear_construction_area', ['clearing_area']],
  ['place_entity', ['placing']],
  ['move_items', ['moving_items']],
  ['move_items_exact', ['moving_items']],
  ['move_items_with_player', ['moving_items']],
  ['set_machine_recipe', ['setting_recipe']],
  ['craft_item', ['crafting']],
  ['attack_nearest_enemy', ['attacking']],
  ['clear_enemy_area', ['attacking']],
])

const TRANSFER_OPERATION_NAMES = new Set(['move_items', 'move_items_exact', 'move_items_with_player', 'supply_entity'])

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function parseStoredOperation(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(' ')
  if (separator < 1) return undefined
  const name = value.slice(0, separator)
  let args
  try { args = JSON.parse(value.slice(separator + 1)) }
  catch { return undefined }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  return { name, args }
}

function parseReceiptSummary(evidence) {
  if (!['operation_receipt', 'operation_error_receipt'].includes(evidence?.kind) || typeof evidence.summary !== 'string') return undefined
  try {
    const parsed = JSON.parse(evidence.summary)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  }
  catch { return undefined }
}

function taskTypesMatch(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  return expected.every((taskType, index) => actual[index] === taskType)
}

function strictTaskTypesForOperation(operation) {
  if (operation.name === 'supply_entity') {
    const items = operation.args?.items
    if (!Array.isArray(items) || items.length < 1 || items.length > 8) return undefined
    return Array.from({ length: items.length }, () => 'moving_items')
  }
  if (operation.name === 'execute_construction_plan') {
    const count = operation.args?.placement_count
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) return undefined
    return Array.from({ length: count }, () => 'placing')
  }
  return STRICT_TASKS_BY_OPERATION.get(operation.name)
}

function stateHasUnverifiedTransferIntent(state) {
  if (!state) return false
  const stored = Array.isArray(state.last_operations) ? state.last_operations.slice(-16) : []
  const hasTransfer = stored.map(parseStoredOperation).some(operation => operation && TRANSFER_OPERATION_NAMES.has(operation.name))
  if (!hasTransfer) return false
  if (state.admission_status === 'admission_failed') return true
  return state.last_mutation_verified !== true
}

function transferFailureReason(evidence) {
  const receipt = parseReceiptSummary(evidence)
  const basic = receipt?.basic_operation
  const code = typeof basic?.code === 'string' && basic.code ? basic.code : undefined
  const reason = typeof receipt?.reason === 'string' && receipt.reason ? receipt.reason : undefined
  return code ?? reason ?? 'operation_failed'
}

export function verifyDeterministicReceipt(state, evidence) {
  const receipt = parseReceiptSummary(evidence)
  if (!receipt) return { verified: false, reason: 'not_completed_operation_receipt' }
  if (receipt.outcome !== 'completed' || receipt.task_state !== 'idle' || receipt.queue_length !== 0) {
    return { verified: false, reason: 'batch_not_cleanly_completed' }
  }
  if (!Number.isSafeInteger(receipt.batch_id) || receipt.batch_id < 1) {
    return { verified: false, reason: 'missing_batch_identity' }
  }

  const stored = Array.isArray(state?.last_operations) ? state.last_operations.slice(-16) : []
  if (stored.length === 0) return { verified: false, reason: 'missing_operation_intent' }
  const operations = stored.map(parseStoredOperation)
  if (operations.some(operation => !operation)) return { verified: false, reason: 'invalid_operation_intent' }

  const expectedTaskTypes = []
  for (const operation of operations) {
    const taskTypes = strictTaskTypesForOperation(operation)
    if (!taskTypes) {
      return { verified: false, reason: `operation_requires_additional_verification:${operation.name}` }
    }
    expectedTaskTypes.push(...taskTypes)
  }

  if (receipt.task_count !== expectedTaskTypes.length || !taskTypesMatch(receipt.task_types, expectedTaskTypes)) {
    return { verified: false, reason: 'receipt_operation_mismatch' }
  }

  const transferOperations = operations.filter(operation => TRANSFER_OPERATION_NAMES.has(operation.name))
  if (transferOperations.length > 0) {
    const basic = receipt.basic_operation
    if (!basic
      || basic.accepted !== true
      || basic.completed !== true
      || basic.code !== 'completed'
      || basic.type !== 'moving_items'
      || !Number.isSafeInteger(basic.moved_count)
      || basic.moved_count <= 0) {
      return { verified: false, reason: 'transfer_effect_not_verified' }
    }
    const finalOperation = operations[operations.length - 1]
    if (TRANSFER_OPERATION_NAMES.has(finalOperation.name)) {
      const expectedTarget = finalOperation.name === 'supply_entity'
        ? finalOperation.args?.unit_number
        : finalOperation.args?.unit_number
      if (Number.isSafeInteger(expectedTarget) && basic.target_unit_number !== expectedTarget) {
        return { verified: false, reason: 'transfer_target_mismatch' }
      }
      const expectedToEntity = finalOperation.name === 'move_items_with_player'
        ? undefined
        : finalOperation.name === 'supply_entity'
          ? true
          : finalOperation.args?.to_entity
      if (typeof expectedToEntity === 'boolean' && basic.to_entity !== expectedToEntity) {
        return { verified: false, reason: 'transfer_direction_mismatch' }
      }
    }
  }

  return {
    verified: true,
    batchId: receipt.batch_id,
    taskTypes: expectedTaskTypes,
    operationNames: operations.map(operation => operation.name),
  }
}

function attemptedLaterCanonicalStep(previousBoard, plan) {
  if (!previousBoard || previousBoard.kind !== 'task_board_lite' || !Array.isArray(previousBoard.steps)) return false
  const canonical = previousBoard.steps.map(step => String(step?.description ?? '')).filter(Boolean)
  if (canonical.length === 0) return false
  const currentIndex = Number.isSafeInteger(previousBoard.active_index)
    ? Math.min(Math.max(previousBoard.active_index, 0), canonical.length - 1)
    : 0
  const incoming = Array.isArray(plan?.plan) ? plan.plan : []
  const incomingIndex = Number.isSafeInteger(plan?.currentStep)
    ? Math.min(Math.max(plan.currentStep, 0), Math.max(0, incoming.length - 1))
    : 0
  const incomingActive = incoming[incomingIndex]
  const matched = incomingActive === undefined
    ? -1
    : canonical.findIndex(description => clean(description) === clean(incomingActive))
  return matched > currentIndex
}

export function canonicalContinuationPlan(previousBoard, plan, { allowReplan = false, previousState } = {}) {
  if (!previousBoard || previousBoard.kind !== 'task_board_lite' || !Array.isArray(previousBoard.steps)) return plan
  const canonical = previousBoard.steps.map(step => String(step?.description ?? '')).filter(Boolean)
  if (canonical.length === 0) return plan

  const currentIndex = Number.isSafeInteger(previousBoard.active_index)
    ? Math.min(Math.max(previousBoard.active_index, 0), canonical.length - 1)
    : 0
  const incoming = Array.isArray(plan?.plan) ? plan.plan : []
  const incomingIndex = Number.isSafeInteger(plan?.currentStep)
    ? Math.min(Math.max(plan.currentStep, 0), Math.max(0, incoming.length - 1))
    : 0
  const incomingActive = incoming[incomingIndex]
  const matched = incomingActive === undefined
    ? -1
    : canonical.findIndex(description => clean(description) === clean(incomingActive))

  if (stateHasUnverifiedTransferIntent(previousState) && matched > currentIndex) {
    return {
      ...plan,
      plan: canonical,
      currentStep: currentIndex,
    }
  }

  if (allowReplan) return plan
  return {
    ...plan,
    plan: allowReplan ? plan.plan : canonical,
    currentStep: currentIndex,
  }
}

export class CanonicalTaskBoardMemory extends NpcDialogueMemory {
  retireCompletedPlan(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || state.status !== 'completed') return state
    this.planByNpc.delete(key)
    return undefined
  }

  planContext(key) {
    const state = this.retireCompletedPlan(key)
    if (!state) {
      return '[PLAN_STATE] No active durable goal. Completed goals are retired from the current task slot and remain only in bounded dialogue history. Do not resume or steer a completed goal merely because the human says continue; a new actionable instruction must start a new goal.'
    }
    return super.planContext(key)
  }

  currentPlan(key) {
    this.retireCompletedPlan(key)
    return super.currentPlan(key)
  }

  recordPlan(key, requestInfo, plan, options = {}) {
    // A completed goal is history, not an active task. Older persisted state may
    // still contain one from a previous runtime version, so retire it before a
    // new request can accidentally inherit its goal_id/objective.
    this.retireCompletedPlan(key)
    return super.recordPlan(key, requestInfo, plan, options)
  }

  reconcileTaskBoard(key, previousBoard, plan, stateResult, options = {}) {
    const truthState = options.previousState ?? stateResult?.state
    const guarded = canonicalContinuationPlan(previousBoard, plan, { ...options, previousState: truthState })
    const result = super.reconcileTaskBoard(key, previousBoard, guarded, stateResult, options)
    if (result?.state?.status === 'completed') this.planByNpc.delete(key)
    return result
  }

  recordBoardEvidence(key, evidence) {
    const boardAfterReceipt = super.recordBoardEvidence(key, evidence)
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || !boardAfterReceipt) return boardAfterReceipt

    if (evidence?.kind === 'operation_error_receipt' && stateHasUnverifiedTransferIntent(state)) {
      const reason = transferFailureReason(evidence)
      return this.applyOutcomeAuthority(key, {
        kind: 'world_blocked',
        source: 'autorio',
        reason_code: `transfer_failed:${reason}`,
        candidate_blocker: `transfer_failed:${reason}`,
        evidence: [evidence],
      }).state?.task_board ?? boardAfterReceipt
    }

    if (state.status !== 'active' || boardAfterReceipt.status !== 'active') return boardAfterReceipt

    const verification = verifyDeterministicReceipt(state, evidence)
    if (!verification.verified) return boardAfterReceipt
    const ref = `batch_${verification.batchId}`
    if ((boardAfterReceipt.evidence ?? []).some(item => item?.kind === 'deterministic_verification' && item?.ref === ref)) {
      return boardAfterReceipt
    }

    super.recordBoardEvidence(key, {
      kind: 'deterministic_verification',
      ref,
      summary: JSON.stringify({
        verdict: 'verified_complete',
        semantics: 'Every operation in this batch has strict runtime completion semantics; the completed batch receipt therefore proves the current step action finished without a model guess.',
        batch_id: verification.batchId,
        operations: verification.operationNames,
        task_types: verification.taskTypes,
      }),
    })

    const current = this.planByNpc.get(key)
    if (current) {
      current.last_mutation_verified = true
      current.last_verified_batch_id = verification.batchId
      this.planByNpc.set(key, current)
    }
    const verifiedBoard = this.ensureTaskBoard(current)
    if (!current || !verifiedBoard || verifiedBoard.status !== 'active' || verifiedBoard.steps.length === 0) return verifiedBoard

    const currentIndex = Number.isSafeInteger(verifiedBoard.active_index) ? verifiedBoard.active_index : 0
    if (currentIndex >= verifiedBoard.steps.length - 1) {
      const verificationEvidence = [...(verifiedBoard.evidence ?? [])].reverse().find(item => item?.kind === 'deterministic_verification' && item?.ref === ref)
      return this.applyOutcomeAuthority(key, {
        kind: 'verified_complete',
        source: 'deterministic_runtime',
        reason_code: 'verified_final_step',
        evidence: verificationEvidence ? [verificationEvidence] : [],
      }).state?.task_board ?? verifiedBoard
    }

    const canonical = verifiedBoard.steps.map(step => String(step?.description ?? '')).filter(Boolean)
    const nextIndex = currentIndex + 1
    const stateResult = super.reconcileTaskBoard(key, verifiedBoard, {
      plan: canonical,
      currentStep: nextIndex,
    }, {
      state: current,
      blockedByHarness: false,
      changed: true,
    }, { allowReplan: false, authoritativeAdvance: true })
    const next = stateResult?.state
    if (!next) return verifiedBoard
    next.status = 'active'
    next.blocker = ''
    next.pause_reason = ''
    next.plan = canonical
    next.current_step = nextIndex
    next.revision += 1
    next.updated_at = Date.now()
    this.planByNpc.set(key, next)
    return next.task_board
  }

  terminatePlan(key) {
    const previous = key ? this.planByNpc.get(key) : undefined
    if (!previous) return undefined
    this.planByNpc.delete(key)
    return previous
  }
}
