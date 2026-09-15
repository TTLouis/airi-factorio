import { NpcDialogueMemory } from './npc-agent-loop.mjs'

const STRICT_TASKS_BY_OPERATION = new Map([
  ['walk_to_entity', ['walking_to_entity']],
  ['walk_to_player', ['walking_to_entity']],
  ['mine_entity', ['mining']],
  ['gather_resource', ['walking_to_entity', 'mining']],
  ['place_entity', ['placing']],
  ['set_machine_recipe', ['setting_recipe']],
  ['craft_item', ['crafting']],
  ['attack_nearest_enemy', ['attacking']],
  ['clear_enemy_area', ['attacking']],
])

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
  if (evidence?.kind !== 'operation_receipt' || typeof evidence.summary !== 'string') return undefined
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
  if (operation.name === 'execute_construction_plan') {
    const count = operation.args?.placement_count
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) return undefined
    return Array.from({ length: count }, () => 'placing')
  }
  return STRICT_TASKS_BY_OPERATION.get(operation.name)
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

  return {
    verified: true,
    batchId: receipt.batch_id,
    taskTypes: expectedTaskTypes,
    operationNames: operations.map(operation => operation.name),
  }
}

export function canonicalContinuationPlan(previousBoard, plan, { allowReplan = false } = {}) {
  if (allowReplan || !previousBoard || previousBoard.kind !== 'task_board_lite' || !Array.isArray(previousBoard.steps)) return plan
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
  const nextIndex = matched >= currentIndex ? matched : currentIndex

  return {
    ...plan,
    plan: canonical,
    currentStep: nextIndex,
  }
}

export class CanonicalTaskBoardMemory extends NpcDialogueMemory {
  reconcileTaskBoard(key, previousBoard, plan, stateResult, options = {}) {
    const guarded = canonicalContinuationPlan(previousBoard, plan, options)
    return super.reconcileTaskBoard(key, previousBoard, guarded, stateResult, options)
  }

  recordBoardEvidence(key, evidence) {
    const boardAfterReceipt = super.recordBoardEvidence(key, evidence)
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || state.status !== 'active' || !boardAfterReceipt || boardAfterReceipt.status !== 'active') return boardAfterReceipt

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
    const verifiedBoard = this.ensureTaskBoard(current)
    if (!current || !verifiedBoard || verifiedBoard.status !== 'active' || verifiedBoard.steps.length === 0) return verifiedBoard

    const currentIndex = Number.isSafeInteger(verifiedBoard.active_index) ? verifiedBoard.active_index : 0
    if (currentIndex >= verifiedBoard.steps.length - 1) {
      // Keep final goal completion conservative. The deterministic evidence is
      // attached to the last step, but the existing completion continuation is
      // still responsible for closing the whole user goal. This prevents a
      // provider continuation from reopening an already-completed durable goal.
      return verifiedBoard
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
    }, { allowReplan: false })
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