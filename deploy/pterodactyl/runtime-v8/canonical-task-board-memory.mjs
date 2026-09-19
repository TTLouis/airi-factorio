import { NpcDialogueMemory } from './npc-agent-loop.mjs'
import { createTaskBoard, setTaskBoardStatus } from './common.mjs'
import { activateNextMilestone, completeCurrentMilestone, sanitizeProjectBoard, updateProjectBoard } from './project-board.mjs'

const STRICT_TASKS_BY_OPERATION = new Map([
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

  if (allowReplan) return plan
  return {
    ...plan,
    plan: canonical,
    // currentStep is advisory proposed focus only. Runtime completion authority
    // remains at currentIndex until grounded evidence is accepted.
    currentStep: matched >= 0 ? matched : currentIndex,
  }
}

export class CanonicalTaskBoardMemory extends NpcDialogueMemory {
  ensureProjectBoard(state) {
    if (!state) return undefined
    state.project_board = sanitizeProjectBoard(state.project_board, {
      goalId: state.goal_id,
      objective: state.objective,
      status: state.status,
      now: state.updated_at,
    })
    return state.project_board
  }

  markHierarchySplitPending(key, envelope = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || state.status !== 'active') return undefined
    const now = Date.now()
    state.hierarchy_split_pending = {
      kind: 'split_current_milestone',
      reason_code: String(envelope.reason_code ?? 'hierarchy_split_requested').slice(0, 120),
      reasoning_budget: ['micro', 'normal', 'deep', 'strategic'].includes(envelope.reasoning_budget) ? envelope.reasoning_budget : undefined,
      planning_horizon: ['immediate', 'checkpoint', 'subgoal', 'strategic'].includes(envelope.planning_horizon) ? envelope.planning_horizon : undefined,
      observation_budget: Number.isSafeInteger(envelope.observation_budget)
        ? Math.max(0, Math.min(8, envelope.observation_budget))
        : undefined,
      requested_at: now,
    }
    state.revision = (state.revision ?? 0) + 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    return state.hierarchy_split_pending
  }

  clearHierarchySplitPending(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state?.hierarchy_split_pending) return state
    state.hierarchy_split_pending = undefined
    state.revision = (state.revision ?? 0) + 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state
  }

  updateProjectBoard(key, patch = {}, options = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const now = Date.now()
    const current = this.ensureProjectBoard(state)
    const effectivePatch = options.preserveCurrentMilestone === true && current?.current_milestone
      ? { ...patch, current_milestone: current.current_milestone }
      : patch
    state.project_board = updateProjectBoard(current, effectivePatch, {
      goalId: state.goal_id,
      objective: state.objective,
      status: state.status,
      now,
    })
    state.revision = (state.revision ?? 0) + 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    return state.project_board
  }

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
    const plan = super.planContext(key)
    const project = this.ensureProjectBoard(state)
    const pending = state.hierarchy_split_pending
      ? `\n[HIERARCHY_TRANSITION] A Jev split decision is durably pending. Do not continue the old flat Plan Tracker. Resolve the transition by proposing one bounded project.currentMilestone and a milestone-local plan before new world mutation.\n${JSON.stringify(state.hierarchy_split_pending)}`
      : ''
    return `${plan}\n[PROJECT_STATE] Durable long-horizon hierarchy. Future milestones are tentative; the current Task Board remains the execution contract.\n${JSON.stringify(project)}${pending}`
  }

  currentPlan(key) {
    this.retireCompletedPlan(key)
    const state = super.currentPlan(key)
    this.ensureProjectBoard(state)
    return state
  }

  recordPlan(key, requestInfo, plan, options = {}) {
    // A completed goal is history, not an active task. Older persisted state may
    // still contain one from a previous runtime version, so retire it before a
    // new request can accidentally inherit its goal_id/objective.
    this.retireCompletedPlan(key)
    const result = super.recordPlan(key, requestInfo, plan, options)
    if (result?.state) this.ensureProjectBoard(result.state)
    return result
  }

  applyOutcomeAuthority(key, candidate, options = {}) {
    const before = key ? this.planByNpc.get(key) : undefined
    const boardBefore = before?.task_board
    const projectBefore = before ? this.ensureProjectBoard(before) : undefined
    const finalStepOfMilestone = candidate?.metadata?.scope === 'step'
      && projectBefore?.current_milestone
      && Array.isArray(boardBefore?.steps)
      && boardBefore.steps.length > 0
      && Number.isSafeInteger(boardBefore.active_index)
      && boardBefore.active_index === boardBefore.steps.length - 1

    const result = super.applyOutcomeAuthority(key, candidate, options)
    if (finalStepOfMilestone && result?.decision?.accepted === true && result?.state?.status === 'completed') {
      const state = result.state
      const transition = completeCurrentMilestone(projectBefore, {
        verified: true,
        goalId: state.goal_id,
        objective: state.objective,
        status: 'active',
        now: state.updated_at,
      })
      if (transition.changed) {
        state.status = 'active'
        state.admission_status = undefined
        state.blocker = ''
        state.pause_reason = ''
        state.persistent_runtime = undefined
        state.condition_wait = undefined
        state.project_board = transition.board
        state.milestone_transition_pending = true
        state.milestone_plan_pending = false
        state.plan = []
        state.current_step = 0
        state.revision = (state.revision ?? 0) + 1
        this.planByNpc.set(key, state)
        return { ...result, state, changed: true, milestoneCompleted: true }
      }
    }
    if (result?.state) this.ensureProjectBoard(result.state)
    return result
  }

  activateNextMilestone(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state || state.status !== 'active') return { state, changed: false, reason: 'no_active_project' }
    const now = Date.now()
    const transition = activateNextMilestone(this.ensureProjectBoard(state), {
      goalId: state.goal_id,
      objective: state.objective,
      status: state.status,
      now,
    })
    if (!transition.changed) return { state, changed: false, reason: transition.reason }
    state.project_board = transition.board
    state.milestone_transition_pending = false
    state.milestone_plan_pending = true
    state.task_board = createTaskBoard([], 0, { goalId: state.goal_id, now })
    state.plan = []
    state.current_step = 0
    state.revision = (state.revision ?? 0) + 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    return { state, changed: true, reason: transition.reason }
  }

  restore(snapshot) {
    const persistedProjects = new Map(
      Array.isArray(snapshot?.plans)
        ? snapshot.plans
            .filter(item => item && typeof item.key === 'string')
            .map(item => [item.key, item?.state?.project_board])
        : [],
    )
    super.restore(snapshot)
    for (const [key, state] of this.planByNpc.entries()) {
      state.project_board = sanitizeProjectBoard(persistedProjects.get(key), {
        goalId: state.goal_id,
        objective: state.objective,
        status: state.status,
        now: state.updated_at,
      })
      this.planByNpc.set(key, state)
    }
  }

  reconcileTaskBoard(key, previousBoard, plan, stateResult, options = {}) {
    const truthState = options.previousState ?? stateResult?.state
    if (options.newMilestone === true && stateResult?.state) {
      const state = stateResult.state
      const now = state.updated_at ?? Date.now()
      const incoming = Array.isArray(plan?.plan) ? plan.plan : []
      state.task_board = createTaskBoard(incoming, Number.isSafeInteger(plan?.currentStep) ? plan.currentStep : 0, {
        goalId: state.goal_id,
        now,
      })
      state.task_board = setTaskBoardStatus(state.task_board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now,
      })
      state.plan = state.task_board.steps.map(step => step.description)
      state.current_step = state.task_board.active_index
      state.milestone_transition_pending = false
      state.milestone_plan_pending = false
      this.planByNpc.set(key, state)
      return { ...stateResult, state }
    }
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
    if (!current || !verifiedBoard || verifiedBoard.status !== 'active') return verifiedBoard

    // Strict operation completion is grounded evidence, not semantic step
    // completion authority. The Runtime Completion Gate decides whether this
    // proof is sufficient for the active canonical step.
    return verifiedBoard
  }

  terminatePlan(key) {
    const previous = key ? this.planByNpc.get(key) : undefined
    if (!previous) return undefined
    this.planByNpc.delete(key)
    return previous
  }
}
