import fsp from 'node:fs/promises'
import path from 'node:path'

import { AgentLoopError, NpcAgentLoop as BaseNpcAgentLoop, NpcDialogueMemory as BaseNpcDialogueMemory } from '../staging/npc-agent-loop.mjs'
import {
  addTaskBoardEvidence,
  reconcileTaskBoard,
  sanitizeTaskBoard,
  setTaskBoardStatus,
  taskBoardProgress,
} from './common.mjs'
import { executeAuthorizedBatch } from './supervisor-adapter.mjs'
import { isObservationToolName, renderOperation, renderOperationPreflight, toolCommand } from './structured-policy.mjs'

export { AgentLoopError }

const TRACE_MAX_BYTES = 5 * 1024 * 1024
const TRACE_FILES = 5
const SENSITIVE_TRACE_KEY = /(?:authorization|api.?key|token|password|secret|cookie|session)/i
const STATE_SCHEMA = 1
const PLAN_HISTORY_LIMIT = 24
const DUPLICATE_OBSERVATION_MESSAGE = '[HARNESS] Duplicate observation suppressed. The result is unchanged from the earlier identical tool call already present in this decision context; reuse it and act or report a blocker.'
const OUTPUT_BUDGET_RECOVERY_MESSAGE = '[HARNESS] The immediately preceding provider response exhausted its output budget before emitting content or tool calls. Continue the same logical request and goal from this unchanged harness context. Tools remain available. Do not treat the empty response as an action, plan update, completion, or evidence. Do not replay any world mutation already proven complete by the supplied receipts or canonical Task Board. Return the next necessary tool call(s) or one valid strict-JSON plan.'
const ACTION_OMISSION_MAX_TOKENS = 700
const ACTION_OMISSION_BLOCKER_PREFIX = 'BLOCKED:'
const ACTION_OMISSION_REPAIR_MESSAGE = 'Finite canonical work remains, but no executable operation was submitted. Reuse the authoritative evidence already collected and do not repeat completed observations. If that evidence already parameterizes the next action, submit the next executable operation now. If exactly one mutable fact is genuinely missing, use exactly one targeted observation for that fact; after it, no more observation turns are allowed. Do not stop and wait for a human "continue" message. Otherwise keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact missing fact or truthful blocker.'
const ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE = 'The single targeted observation for this decision is complete. Do not observe again or switch to another read-only tool. Submit the next executable operation now, or keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact still-missing fact or truthful blocker.'
const EXACT_ENTITY_TARGET_OPERATIONS = new Set([
  'walk_to_entity_exact',
  'mine_entity_exact',
  'supply_entity',
  'rotate_entity',
  'move_items_exact',
  'set_machine_recipe',
])

const DURABLE_PLAN_PROMPT = `
## Durable goal and plan state

The Pterodactyl harness may provide a [PLAN_STATE] message. It is harness-owned durable goal/plan context for this logical NPC and survives ordinary model turns and server restarts. Use it to resume a prior task, answer what you were doing, or continue after a pause. It is not authoritative live Factorio state: re-observe mutable game state before depending on it.

The task_board field is the canonical single-NPC Task Board Lite. Its stable step ids, statuses, completed count, evidence, and revision are harness-owned. Your plan/currentStep fields are proposals used to advance or intentionally replan the remaining work; do not assume that changing the length of your plan array resets completed progress.

For a multi-step request, keep the plan stable enough that the harness can track progress across Autorio batches. currentStep must identify the step you are actually executing or verifying now. If you replan, preserve already-completed intent instead of silently replacing the whole task with a vague new one.

Plan entries must represent goal-bearing Factorio work or verification. Do not add terminal lifecycle/meta steps such as "Stop", "Done", "Finish", or "Report completion"; stopping after the verified goal is represented by returning plan: [], currentStep: 0, operations: [].

An empty operations array normally means no new Autorio world action will happen after your reply. Never claim that a finite action is continuing when neither a new operation nor a live persistent runtime mode exists. Persistent controllers such as follow are different: if a read-only status tool proves the controller is active, healthy, and live, operations: [] may accurately describe that background mode without submitting a duplicate operation. When the whole requested goal is actually verified complete, return plan: [], currentStep: 0, operations: [], and say it is complete.

When finite canonical work remains but execution is truthfully impossible, keep the remaining plan and start chatMessage with "BLOCKED: " followed by the exact missing fact or blocker. This is the explicit no-mutation blocker contract. Future-tense prose such as "I will take the items" is not a blocker and does not authorize the harness to invent an operation.

Before a non-empty operation batch, chatMessage should tell the human what concrete current plan step AIRI is about to attempt. Do not say mining, construction, transfer, crafting, or any other mutation has started unless that mutation is in the admitted/running operation batch or authoritative runtime evidence proves it. Navigation completion proves arrival only; it never proves that a later mining or construction action started. [MOD] completion/error messages may include a detailed getTaskStatus snapshot. Use that receipt plus any needed read-only verification to advance, replan, complete, or report a blocker.
`.trim()

function cleanMemoryText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function sanitizeDurableModelText(value, max = 2000) {
  let text = cleanMemoryText(value, max)
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return cleanMemoryText(JSON.stringify(sanitizeDurableModelValue(JSON.parse(trimmed))), max)
    }
    catch {}
  }
  text = text
    .replace(/(["']?(?:target_)?unit_number["']?\s*[:=]\s*)\d+/gi, '$1[historical-id-omitted]')
    .replace(/(["']?observed_unit_numbers["']?\s*[:=]\s*)\[[^\]]*\]/gi, '$1[historical-ids-omitted]')
    .replace(/\b(?:unit_number|target_unit_number)[_:#-]?\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\bunit[_:#-]\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\b(?:exact\s+entity\s+target\s+|target\s+)?unit\s+#?\d+\b/gi, 'historical exact identity [omitted]')
  return cleanMemoryText(text, max)
}

function sanitizeDurableModelValue(value) {
  if (Array.isArray(value)) return value.map(item => sanitizeDurableModelValue(item))
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeDurableModelText(value, Math.max(2000, value.length)) : value
  }
  const staleExact = value.code === 'stale_exact_target' || value.reason_code === 'stale_exact_target'
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)unit_number$/i.test(key) || /(?:^|_)unit_numbers$/i.test(key)) continue
    if (key === 'unit' && Number.isSafeInteger(child)) continue
    if (staleExact && key === 'identity' && Number.isSafeInteger(child)) continue
    result[key] = sanitizeDurableModelValue(child)
  }
  return result
}

function durableEntityLocator(observation, semanticRole = '') {
  if (!observation || typeof observation !== 'object') return undefined
  const position = observation.position && Number.isFinite(observation.position.x) && Number.isFinite(observation.position.y)
    ? { x: observation.position.x, y: observation.position.y }
    : undefined
  const surface = typeof observation.surface === 'string' && observation.surface
    ? cleanMemoryText(observation.surface, 128)
    : undefined
  const locator = {
    name: typeof observation.name === 'string' ? cleanMemoryText(observation.name, 200) : undefined,
    type: typeof observation.type === 'string' ? cleanMemoryText(observation.type, 100) : undefined,
    surface,
    surface_index: Number.isSafeInteger(observation.surface_index) ? observation.surface_index : undefined,
    position,
    role: semanticRole ? sanitizeDurableModelText(semanticRole, 500) : undefined,
  }
  return Object.fromEntries(Object.entries(locator).filter(([, child]) => child !== undefined && child !== ''))
}

function durableOperationView(operation, { observation, semanticRole = '' } = {}) {
  if (!operation || typeof operation !== 'object') return sanitizeDurableModelValue(operation)
  const name = cleanMemoryText(operation.name, 100)
  const args = sanitizeDurableModelValue(operation.args ?? {})
  const hadExactIdentity = Number.isSafeInteger(operation.args?.unit_number)
  const targetLocator = durableEntityLocator(observation, semanticRole)
  return {
    name,
    args,
    ...(targetLocator && Object.keys(targetLocator).length > 0 ? { target_locator: targetLocator } : {}),
    ...(hadExactIdentity ? { exact_identity_lifetime: 'request_scoped; re-observe before any later exact operation' } : {}),
    ...(!targetLocator && semanticRole ? { role: sanitizeDurableModelText(semanticRole, 500) } : {}),
  }
}

function parseStoredOperation(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(' ')
  if (separator < 1) return undefined
  try {
    const args = JSON.parse(value.slice(separator + 1))
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
    return { name: value.slice(0, separator), args }
  }
  catch {
    return undefined
  }
}

function storedOperationView(value, semanticRole = '', observation) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.target_locator || value.exact_identity_lifetime) return sanitizeDurableModelValue(value)
    return durableOperationView(value, { observation, semanticRole })
  }
  const parsed = parseStoredOperation(value)
  if (parsed) return durableOperationView(parsed, { observation, semanticRole })
  return sanitizeDurableModelText(value, 800)
}

function historicalExactTargetLocator(state, unitNumber) {
  if (!state || !Number.isSafeInteger(unitNumber)) return undefined
  const role = currentPlanStep(state.plan, state.current_step)
  for (const entry of [...(Array.isArray(state.exact_target_audit) ? state.exact_target_audit : [])].reverse()) {
    if (entry?.unit_number === unitNumber && entry.locator) return sanitizeDurableModelValue(entry.locator)
  }
  const raw = Array.isArray(state.last_operations) ? state.last_operations : []
  const durable = Array.isArray(state.durable_last_operations) ? state.durable_last_operations : []
  for (let index = raw.length - 1; index >= 0; index--) {
    const operation = parseStoredOperation(raw[index])
    if (operation?.args?.unit_number !== unitNumber) continue
    const locator = durable[index]?.target_locator
    if (locator) return sanitizeDurableModelValue(locator)
  }
  const evidence = Array.isArray(state.task_board?.evidence) ? state.task_board.evidence : []
  for (const item of [...evidence].reverse()) {
    if (typeof item?.summary !== 'string') continue
    try {
      const parsed = JSON.parse(item.summary)
      if (parsed?.identity === unitNumber && parsed?.last_observed) {
        return durableEntityLocator(parsed.last_observed, role)
      }
      const basic = parsed?.basic_operation
      if (basic?.target_unit_number === unitNumber) {
        return durableEntityLocator({ name: basic.entity_name }, role)
      }
    }
    catch {}
  }
  return undefined
}

function modelFacingLastOperations(state) {
  const role = currentPlanStep(state?.plan, state?.current_step)
  const durable = Array.isArray(state?.durable_last_operations) && state.durable_last_operations.length > 0
    ? state.durable_last_operations
    : undefined
  if (durable) return durable.slice(-16).map(operation => storedOperationView(operation, role))
  return (Array.isArray(state?.last_operations) ? state.last_operations : []).slice(-16).map((value) => {
    const parsed = parseStoredOperation(value)
    const unitNumber = parsed?.args?.unit_number
    const locator = Number.isSafeInteger(unitNumber) ? historicalExactTargetLocator(state, unitNumber) : undefined
    return storedOperationView(value, role, locator)
  })
}

function modelFacingEntityReferences(state) {
  if (!state) return []
  const role = currentPlanStep(state.plan, state.current_step)
  const references = []
  for (const entry of Array.isArray(state.exact_target_audit) ? state.exact_target_audit : []) {
    if (entry?.locator) references.push(sanitizeDurableModelValue(entry.locator))
  }
  for (const operation of Array.isArray(state.durable_last_operations) ? state.durable_last_operations : []) {
    if (operation?.target_locator) references.push(sanitizeDurableModelValue(operation.target_locator))
  }
  for (const item of Array.isArray(state.task_board?.evidence) ? state.task_board.evidence : []) {
    if (typeof item?.summary !== 'string') continue
    try {
      const parsed = JSON.parse(item.summary)
      if (parsed?.last_observed) references.push(durableEntityLocator(parsed.last_observed, role))
    }
    catch {}
  }
  const unique = new Map()
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue
    const safe = sanitizeDurableModelValue(reference)
    const position = safe.position
    const key = JSON.stringify([
      safe.name ?? '',
      safe.type ?? '',
      safe.surface ?? '',
      safe.surface_index ?? '',
      position?.x ?? '',
      position?.y ?? '',
      safe.role ?? '',
    ])
    unique.set(key, safe)
  }
  return [...unique.values()].slice(-16)
}

function modelFacingTaskBoard(board) {
  return sanitizeDurableModelValue(visibleTaskBoard(board))
}

function sanitizeTraceValue(value, key = '') {
  if (SENSITIVE_TRACE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .slice(0, 20000)
  }
  if (Array.isArray(value)) return value.map(item => sanitizeTraceValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeTraceValue(childValue, childKey)]))
}

function safePlan(plan) {
  return Array.isArray(plan) ? plan.slice(0, 30).map(step => cleanMemoryText(step, 500)) : []
}

function currentPlanStep(plan, currentStep) {
  if (!Array.isArray(plan) || plan.length === 0) return ''
  return plan[Math.min(Math.max(currentStep, 0), plan.length - 1)] ?? ''
}

function safePersistentRuntime(value) {
  if (!value || typeof value !== 'object') return undefined
  if (value.kind !== 'follow') return undefined
  return {
    kind: 'follow',
    active: value.active === true,
    healthy: value.healthy === true,
    controller_live: value.controller_live === true,
    state: cleanMemoryText(value.state, 32),
    target_player: cleanMemoryText(value.target_player, 128),
    current_distance: Number.isFinite(value.current_distance) ? value.current_distance : undefined,
    desired_distance: Number.isFinite(value.desired_distance) ? value.desired_distance : undefined,
    last_progress_tick: Number.isFinite(value.last_progress_tick) ? value.last_progress_tick : undefined,
    stuck_for_ticks: Number.isFinite(value.stuck_for_ticks) ? value.stuck_for_ticks : undefined,
    path_request_id: Number.isSafeInteger(value.path_request_id) ? value.path_request_id : undefined,
    path_attempts: Number.isSafeInteger(value.path_attempts) ? value.path_attempts : undefined,
    waypoints_remaining: Number.isSafeInteger(value.waypoints_remaining) ? value.waypoints_remaining : undefined,
    last_repath_tick: Number.isFinite(value.last_repath_tick) ? value.last_repath_tick : undefined,
    last_failure: cleanMemoryText(value.last_failure, 300),
  }
}

function visibleTaskBoard(board) {
  if (!board || board.kind !== 'task_board_lite') return undefined
  return {
    kind: board.kind,
    goal_id: board.goal_id,
    status: board.status,
    blocker: board.blocker,
    pause_reason: board.pause_reason,
    revision: board.revision,
    completed_count: board.completed_count,
    total_steps: board.total_steps,
    active_index: board.active_index,
    active_step_id: board.active_step_id,
    steps: board.steps,
    evidence: (board.evidence ?? []).slice(-8),
    events: (board.events ?? []).slice(-12),
  }
}

function compactBasicOperationResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  return {
    operation_id: Number.isSafeInteger(result.operation_id) ? result.operation_id : undefined,
    type: typeof result.type === 'string' ? cleanMemoryText(result.type, 64) : undefined,
    accepted: result.accepted === true,
    completed: result.completed === true,
    code: typeof result.code === 'string' ? cleanMemoryText(result.code, 64) : undefined,
    entity_name: typeof result.entity_name === 'string' ? cleanMemoryText(result.entity_name, 200) : undefined,
    target_unit_number: Number.isSafeInteger(result.target_unit_number) ? result.target_unit_number : undefined,
    player_name: typeof result.player_name === 'string' ? cleanMemoryText(result.player_name, 128) : undefined,
    item_name: typeof result.item_name === 'string' ? cleanMemoryText(result.item_name, 200) : undefined,
    requested_count: Number.isSafeInteger(result.requested_count) ? result.requested_count : undefined,
    moved_count: Number.isSafeInteger(result.moved_count) ? result.moved_count : undefined,
    to_entity: typeof result.to_entity === 'boolean' ? result.to_entity : undefined,
    to_player: typeof result.to_player === 'boolean' ? result.to_player : undefined,
  }
}

function receiptEvidence(raw, outcome) {
  try {
    const parsed = JSON.parse(raw)
    const receipt = outcome === 'failed'
      ? (parsed?.last_cancelled_batch ?? parsed?.last_completed_batch)
      : (parsed?.last_completed_batch ?? parsed?.last_cancelled_batch)
    const batchId = Number.isSafeInteger(receipt?.batch_id) ? receipt.batch_id : undefined
    return {
      kind: outcome === 'failed' ? 'operation_error_receipt' : 'operation_receipt',
      ref: batchId === undefined ? '' : `batch_${batchId}`,
      summary: JSON.stringify({
        outcome,
        task_state: parsed?.task_state,
        queue_length: parsed?.queue_length,
        batch_id: batchId,
        task_count: receipt?.task_count,
        task_types: Array.isArray(receipt?.task_types) ? receipt.task_types.slice(0, 16) : undefined,
        tick: receipt?.tick,
        reason: receipt?.reason,
        basic_operation: compactBasicOperationResult(parsed?.basic_operation?.last_result),
      }),
    }
  }
  catch {
    return {
      kind: outcome === 'failed' ? 'operation_error_receipt' : 'operation_receipt',
      ref: '',
      summary: cleanMemoryText(raw, 1200),
    }
  }
}

export class NpcDialogueMemory extends BaseNpcDialogueMemory {
  constructor(options = {}) {
    super(options)
    this.planByNpc = new Map()
    this.nextContextOverride = new Map()
  }

  ensureTaskBoard(state) {
    if (!state) return undefined
    if (!state.task_board) {
      state.task_board = sanitizeTaskBoard(undefined, {
        fallbackPlan: state.plan,
        fallbackCurrentStep: state.current_step,
        goalId: state.goal_id,
        now: state.updated_at,
      })
      state.task_board = setTaskBoardStatus(state.task_board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now: state.updated_at,
      })
    }
    return state.task_board
  }

  remember(key, turnId, { sender, user, assistant, operations = [] }) {
    const bucket = this.bucket(key)
    const actionText = operations.length
      ? cleanMemoryText(operations.map(operation => JSON.stringify(storedOperationView(operation))).join('; '), this.maxFieldChars)
      : ''
    const next = {
      id: turnId,
      sender: cleanMemoryText(sender, 128),
      user: cleanMemoryText(user, this.maxFieldChars),
      assistant: cleanMemoryText(assistant, this.maxFieldChars),
      actions: actionText,
    }
    const index = bucket.recent.findIndex(turn => turn.id === turnId)
    if (index >= 0) {
      const previous = bucket.recent[index]
      next.actions = actionText || previous.actions
      bucket.recent[index] = next
    }
    else {
      bucket.recent.push(next)
    }
    this.compact(bucket)
  }

  dialogueContext(key) {
    const bucket = this.byNpc.get(key)
    if (!bucket || (!bucket.summary && bucket.recent.length === 0)) return ''
    const lines = [
      '[MEMORY] Bounded prior dialogue for this NPC. Historical exact entity identities are non-executable; re-observe mutable game state before depending on it.',
    ]
    if (bucket.summary) lines.push(`Compacted earlier dialogue:\n${sanitizeDurableModelText(bucket.summary, this.maxSummaryChars)}`)
    if (bucket.recent.length) {
      lines.push('Recent dialogue:')
      for (const turn of bucket.recent) {
        lines.push(`[CHAT] ${sanitizeDurableModelText(turn.sender, 128)}: ${sanitizeDurableModelText(turn.user, this.maxFieldChars)}`)
        lines.push(`[AIRI] ${sanitizeDurableModelText(turn.assistant, this.maxFieldChars)}`)
        if (turn.actions) lines.push(`[ACTIONS] ${sanitizeDurableModelText(turn.actions, this.maxFieldChars)}`)
      }
    }
    const text = lines.join('\n')
    if (text.length <= this.maxContextChars) return text
    const prefix = `${lines[0]}\nCompacted earlier dialogue:\n[older memory compacted]\n`
    return `${prefix}${text.slice(-Math.max(0, this.maxContextChars - prefix.length))}`
  }

  planContext(key) {
    const state = this.planByNpc.get(key)
    if (!state) return ''
    const taskBoard = this.ensureTaskBoard(state)
    const visible = {
      goal_id: sanitizeDurableModelText(state.goal_id, 100),
      owner: sanitizeDurableModelText(state.owner, 128),
      objective: sanitizeDurableModelText(state.objective, 1000),
      status: state.status,
      admission_status: state.admission_status,
      blocker: sanitizeDurableModelText(state.blocker, 500),
      pause_reason: sanitizeDurableModelText(state.pause_reason, 300),
      persistent_runtime: sanitizeDurableModelValue(state.persistent_runtime),
      task_board: modelFacingTaskBoard(taskBoard),
      entity_references: modelFacingEntityReferences(state),
      plan: (state.plan ?? []).map(step => sanitizeDurableModelText(step, 500)),
      current_step: state.current_step,
      current_step_text: sanitizeDurableModelText(currentPlanStep(state.plan, state.current_step), 500),
      revision: state.revision,
      last_chat_message: sanitizeDurableModelText(state.last_chat_message, 2000),
      last_operations: modelFacingLastOperations(state),
      history: (state.history ?? []).slice(-8).map(entry => sanitizeDurableModelValue(entry)),
    }
    return `[PLAN_STATE] Harness-owned durable goal/plan state. Absolute location and semantic role may be durable, but any historical unit_number is non-executable. Re-observe the current entity in this active request before issuing an exact operation.\n${JSON.stringify(visible)}`
  }

  setNextContextOverride(key, content) {
    if (!key || typeof content !== 'string' || content.length === 0) return
    this.nextContextOverride.set(key, content)
  }

  context(key) {
    const override = this.nextContextOverride.get(key)
    if (override !== undefined) {
      this.nextContextOverride.delete(key)
      return override
    }
    return [this.dialogueContext(key), this.planContext(key)].filter(Boolean).join('\n')
  }

  clearTaskContext(key) {
    const result = super.clearTaskContext(key)
    if (key) this.nextContextOverride.delete(key)
    return result
  }

  currentPlan(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    this.ensureTaskBoard(state)
    return state
  }

  recordPlan(key, requestInfo, plan, { continuation = false, persistentRuntime, durableOperations = [], exactTargetAudit = [] } = {}) {
    const previous = this.planByNpc.get(key)
    const hasOperations = plan.operations.length > 0
    const incomingDurableOperations = (Array.isArray(durableOperations) ? durableOperations : []).slice(0, 16).map(operation => sanitizeDurableModelValue(operation))
    const mergedExactTargetAudit = [
      ...(Array.isArray(previous?.exact_target_audit) ? previous.exact_target_audit : []),
      ...(Array.isArray(exactTargetAudit) ? exactTargetAudit : []),
    ].slice(-32)
    const incomingPlan = safePlan(plan.plan)
    const incomingStep = Number.isSafeInteger(plan.currentStep) ? plan.currentStep : 0
    const now = Date.now()
    const runtime = safePersistentRuntime(persistentRuntime)
    const runtimeHealthy = runtime?.active === true && runtime.healthy === true && runtime.controller_live === true

    if (!hasOperations && !continuation && !runtimeHealthy) {
      return { state: previous, blockedByHarness: false, changed: false }
    }

    const history = previous
      ? [...previous.history, {
          revision: previous.revision,
          status: previous.status,
          current_step: previous.current_step,
          step: currentPlanStep(previous.plan, previous.current_step),
          chat: previous.last_chat_message,
        }].slice(-PLAN_HISTORY_LIMIT)
      : []

    if (hasOperations) {
      const state = {
        goal_id: previous?.goal_id ?? `goal_${now.toString(36)}`,
        owner: cleanMemoryText(requestInfo?.sender ?? previous?.owner ?? 'unknown', 128),
        objective: cleanMemoryText(previous?.objective ?? requestInfo?.text ?? '', 1000),
        status: 'active',
        admission_status: 'proposed',
        blocker: '',
        pause_reason: '',
        persistent_runtime: previous?.persistent_runtime,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: (previous?.revision ?? 0) + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: plan.operations.slice(0, 16).map(operation => cleanMemoryText(`${operation.name} ${JSON.stringify(operation.args ?? {})}`, 800)),
        durable_last_operations: incomingDurableOperations,
        exact_target_audit: mergedExactTargetAudit,
        last_mutation_verified: false,
        last_verified_batch_id: undefined,
        updated_at: now,
        history,
      }
      this.planByNpc.set(key, state)
      return { state, blockedByHarness: false, changed: true }
    }

    if (runtimeHealthy && incomingPlan.length > 0) {
      const state = {
        ...(previous ?? {}),
        goal_id: previous?.goal_id ?? `goal_${now.toString(36)}`,
        owner: cleanMemoryText(requestInfo?.sender ?? previous?.owner ?? 'unknown', 128),
        objective: cleanMemoryText(previous?.objective ?? requestInfo?.text ?? '', 1000),
        status: 'active',
        admission_status: undefined,
        blocker: '',
        pause_reason: '',
        persistent_runtime: runtime,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: (previous?.revision ?? 0) + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: [],
        durable_last_operations: [],
        exact_target_audit: mergedExactTargetAudit,
        updated_at: now,
        history,
      }
      this.planByNpc.set(key, state)
      return { state, blockedByHarness: false, persistentRuntimeActive: true, changed: true }
    }

    if (!previous) return { state: undefined, blockedByHarness: false, changed: false }

    if (incomingPlan.length > 0) {
      const preserveBlockedMutation = previous.status === 'blocked'
        && previous.last_mutation_verified !== true
        && Array.isArray(previous.last_operations)
        && previous.last_operations.length > 0
      const state = {
        ...previous,
        status: 'blocked',
        admission_status: preserveBlockedMutation ? previous.admission_status : undefined,
        blocker: preserveBlockedMutation && previous.blocker
          ? previous.blocker
          : 'no_autorio_operation_for_remaining_plan',
        pause_reason: '',
        persistent_runtime: runtime,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: previous.revision + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: preserveBlockedMutation ? previous.last_operations : [],
        durable_last_operations: preserveBlockedMutation ? modelFacingLastOperations(previous) : [],
        exact_target_audit: mergedExactTargetAudit,
        updated_at: now,
        history,
      }
      this.planByNpc.set(key, state)
      return { state, blockedByHarness: true, changed: true }
    }

    const state = {
      ...previous,
      status: 'completed',
      admission_status: undefined,
      blocker: '',
      pause_reason: '',
      persistent_runtime: undefined,
      plan: [],
      current_step: 0,
      revision: previous.revision + 1,
      last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
      last_operations: [],
      durable_last_operations: [],
      exact_target_audit: mergedExactTargetAudit,
      updated_at: now,
      history,
    }
    this.planByNpc.set(key, state)
    return { state, blockedByHarness: false, changed: true }
  }

  reconcileTaskBoard(key, previousBoard, plan, stateResult, { allowReplan = false } = {}) {
    const state = stateResult?.state
    if (!state) return stateResult
    const now = state.updated_at ?? Date.now()
    let board = previousBoard
      ? sanitizeTaskBoard(previousBoard, { fallbackPlan: state.plan, fallbackCurrentStep: state.current_step, goalId: state.goal_id, now })
      : sanitizeTaskBoard(state.task_board, { fallbackPlan: state.plan, fallbackCurrentStep: state.current_step, goalId: state.goal_id, now })

    if (state.status === 'completed') {
      board = setTaskBoardStatus(board, 'completed', { now })
    }
    else {
      board = reconcileTaskBoard(board, plan.plan, plan.currentStep, { now, allowReplan })
      board = setTaskBoardStatus(board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now,
      })
    }

    state.task_board = board
    if (state.status !== 'completed') {
      state.plan = board.steps.map(step => step.description)
      state.current_step = board.active_index
    }
    this.planByNpc.set(key, state)
    return { ...stateResult, state }
  }

  recordBoardEvidence(key, evidence) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const board = this.ensureTaskBoard(state)
    state.task_board = addTaskBoardEvidence(board, evidence)
    state.revision += 1
    state.updated_at = Date.now()
    this.planByNpc.set(key, state)
    return state.task_board
  }

  setAdmissionState(key, admissionStatus, { blocker = '', evidence } = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const now = Date.now()
    state.admission_status = admissionStatus
    if (admissionStatus === 'admission_failed') {
      state.status = 'blocked'
      state.blocker = cleanMemoryText(blocker || 'operation_admission_failed', 500)
      state.pause_reason = ''
      let board = this.ensureTaskBoard(state)
      board = setTaskBoardStatus(board, 'blocked', { blocker: state.blocker, now })
      if (evidence) board = addTaskBoardEvidence(board, { ...evidence, now })
      state.task_board = board
    }
    state.revision += 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    return state
  }

  beginActionOmissionRecovery(key, requestInfo, plan) {
    const previous = key ? this.planByNpc.get(key) : undefined
    const now = Date.now()
    if (!previous) {
      const incomingPlan = safePlan(plan?.plan)
      if (incomingPlan.length === 0) return undefined
      const incomingStep = Number.isSafeInteger(plan?.currentStep)
        ? Math.min(Math.max(plan.currentStep, 0), incomingPlan.length - 1)
        : 0
      const state = {
        goal_id: `goal_${now.toString(36)}`,
        owner: cleanMemoryText(requestInfo?.sender ?? 'unknown', 128),
        objective: cleanMemoryText(requestInfo?.text ?? '', 1000),
        status: 'active',
        admission_status: 'action_omission_repair',
        blocker: '',
        pause_reason: '',
        persistent_runtime: undefined,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: 1,
        last_chat_message: cleanMemoryText(plan?.chatMessage, 2000),
        last_operations: [],
        durable_last_operations: [],
        exact_target_audit: [],
        last_mutation_verified: false,
        last_verified_batch_id: undefined,
        updated_at: now,
        history: [],
      }
      state.task_board = sanitizeTaskBoard(undefined, {
        fallbackPlan: state.plan,
        fallbackCurrentStep: state.current_step,
        goalId: state.goal_id,
        now,
      })
      state.task_board = setTaskBoardStatus(state.task_board, 'active', { now })
      this.planByNpc.set(key, state)
      return state
    }

    if (previous.status !== 'active') return previous
    previous.admission_status = 'action_omission_repair'
    previous.blocker = ''
    previous.pause_reason = ''
    previous.task_board = setTaskBoardStatus(this.ensureTaskBoard(previous), 'active', { now })
    previous.revision += 1
    previous.updated_at = now
    this.planByNpc.set(key, previous)
    return previous
  }

  blockRemainingPlan(key, { blocker, reason = '', chatMessage = '', evidenceKind = 'lifecycle_blocker' } = {}) {
    const state = key ? this.planByNpc.get(key) : undefined
    if (!state) return undefined
    const now = Date.now()
    const code = cleanMemoryText(blocker || 'action_omission_after_repair', 500)
    state.status = 'blocked'
    state.admission_status = undefined
    state.blocker = code
    state.pause_reason = ''
    state.persistent_runtime = undefined
    if (chatMessage) state.last_chat_message = cleanMemoryText(chatMessage, 2000)
    let board = setTaskBoardStatus(this.ensureTaskBoard(state), 'blocked', { blocker: code, now })
    if (reason) {
      board = addTaskBoardEvidence(board, {
        kind: evidenceKind,
        ref: `${state.goal_id}/${code}`,
        summary: JSON.stringify({
          blocker: code,
          reason: sanitizeDurableModelText(reason, 1200),
          semantics: 'No world mutation was synthesized by the harness.',
        }),
        now,
      })
    }
    state.task_board = board
    state.revision += 1
    state.updated_at = now
    this.planByNpc.set(key, state)
    return state
  }

  pausePlan(key, reason = 'cancelled') {
    const previous = key ? this.planByNpc.get(key) : undefined
    if (!previous || previous.status === 'completed') return previous
    const state = {
      ...previous,
      status: 'paused',
      blocker: '',
      pause_reason: cleanMemoryText(reason, 300),
      persistent_runtime: undefined,
      revision: previous.revision + 1,
      updated_at: Date.now(),
      history: [...previous.history, {
        revision: previous.revision,
        status: previous.status,
        current_step: previous.current_step,
        step: currentPlanStep(previous.plan, previous.current_step),
        chat: previous.last_chat_message,
      }].slice(-PLAN_HISTORY_LIMIT),
    }
    const board = this.ensureTaskBoard(previous)
    state.task_board = setTaskBoardStatus(board, 'paused', { pauseReason: state.pause_reason, now: state.updated_at })
    this.planByNpc.set(key, state)
    return state
  }

  maxTurnId() {
    let max = 0
    for (const bucket of this.byNpc.values()) {
      for (const turn of bucket.recent ?? []) if (Number.isSafeInteger(turn.id)) max = Math.max(max, turn.id)
    }
    return max
  }

  snapshot() {
    return {
      version: STATE_SCHEMA,
      dialogue: [...this.byNpc.entries()].map(([key, bucket]) => ({ key, summary: bucket.summary, recent: bucket.recent })),
      plans: [...this.planByNpc.entries()].map(([key, state]) => ({ key, state })),
    }
  }

  restore(snapshot) {
    if (!snapshot || snapshot.version !== STATE_SCHEMA || !Array.isArray(snapshot.dialogue) || !Array.isArray(snapshot.plans)) {
      throw new AgentLoopError('Invalid persisted NPC state')
    }
    this.byNpc.clear()
    this.planByNpc.clear()

    for (const item of snapshot.dialogue.slice(0, 128)) {
      if (!item || typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 200) continue
      const bucket = this.bucket(item.key)
      bucket.summary = cleanMemoryText(item.summary, this.maxSummaryChars)
      bucket.recent = []
      const recent = Array.isArray(item.recent) ? item.recent.slice(-this.maxRecentTurns * 2) : []
      for (const turn of recent) {
        if (!turn || !Number.isSafeInteger(turn.id) || turn.id < 1) continue
        bucket.recent.push({
          id: turn.id,
          sender: cleanMemoryText(turn.sender, 128),
          user: cleanMemoryText(turn.user, this.maxFieldChars),
          assistant: cleanMemoryText(turn.assistant, this.maxFieldChars),
          actions: cleanMemoryText(turn.actions, this.maxFieldChars),
        })
      }
      this.compact(bucket)
    }

    for (const item of snapshot.plans.slice(0, 128)) {
      if (!item || typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 200) continue
      const value = item.state
      if (!value || typeof value !== 'object' || typeof value.goal_id !== 'string') continue
      if (!['active', 'blocked', 'paused', 'completed'].includes(value.status)) continue
      const state = {
        goal_id: cleanMemoryText(value.goal_id, 100),
        owner: cleanMemoryText(value.owner, 128),
        objective: cleanMemoryText(value.objective, 1000),
        status: value.status,
        admission_status: ['proposed', 'admitting', 'admitted', 'admission_failed', 'action_omission_repair'].includes(value.admission_status) ? value.admission_status : undefined,
        blocker: cleanMemoryText(value.blocker, 500),
        pause_reason: cleanMemoryText(value.pause_reason, 300),
        persistent_runtime: safePersistentRuntime(value.persistent_runtime),
        plan: safePlan(value.plan),
        current_step: Number.isSafeInteger(value.current_step) && value.current_step >= 0 ? value.current_step : 0,
        revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
        last_chat_message: cleanMemoryText(value.last_chat_message, 2000),
        last_operations: (Array.isArray(value.last_operations) ? value.last_operations : []).slice(-16).map(operation => cleanMemoryText(operation, 800)),
        durable_last_operations: (Array.isArray(value.durable_last_operations) ? value.durable_last_operations : []).slice(-16).map(operation => sanitizeDurableModelValue(operation)),
        exact_target_audit: (Array.isArray(value.exact_target_audit) ? value.exact_target_audit : []).slice(-32).flatMap(entry => {
          if (!Number.isSafeInteger(entry?.unit_number)) return []
          return [{
            unit_number: entry.unit_number,
            operation_name: cleanMemoryText(entry.operation_name, 100),
            locator: sanitizeDurableModelValue(entry.locator),
            recorded_at: Number.isFinite(entry.recorded_at) ? entry.recorded_at : undefined,
          }]
        }),
        last_mutation_verified: value.last_mutation_verified === true,
        last_verified_batch_id: Number.isSafeInteger(value.last_verified_batch_id) && value.last_verified_batch_id > 0 ? value.last_verified_batch_id : undefined,
        updated_at: Number.isFinite(value.updated_at) ? value.updated_at : Date.now(),
        history: (Array.isArray(value.history) ? value.history : []).slice(-PLAN_HISTORY_LIMIT).map(entry => ({
          revision: Number.isSafeInteger(entry?.revision) ? entry.revision : 0,
          status: cleanMemoryText(entry?.status, 32),
          current_step: Number.isSafeInteger(entry?.current_step) ? entry.current_step : 0,
          step: cleanMemoryText(entry?.step, 500),
          chat: cleanMemoryText(entry?.chat, 2000),
        })),
      }
      state.task_board = sanitizeTaskBoard(value.task_board, {
        fallbackPlan: state.plan,
        fallbackCurrentStep: state.current_step,
        goalId: state.goal_id,
        now: state.updated_at,
      })
      state.task_board = setTaskBoardStatus(state.task_board, state.status, {
        blocker: state.blocker,
        pauseReason: state.pause_reason,
        now: state.updated_at,
      })
      if (state.status !== 'completed') {
        state.plan = state.task_board.steps.map(step => step.description)
        state.current_step = state.task_board.active_index
      }
      this.planByNpc.set(item.key, state)
    }
  }
}

class BehaviorTraceWriter {
  constructor(filename, log) {
    this.filename = filename
    this.log = log
    this.queue = Promise.resolve()
    this.bytes = null
    this.warned = false
  }

  async initialize() {
    if (this.bytes !== null) return
    await fsp.mkdir(path.dirname(this.filename), { recursive: true })
    try { this.bytes = (await fsp.stat(this.filename)).size }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.bytes = 0
    }
  }

  async rotate(incomingBytes) {
    await this.initialize()
    if (this.bytes + incomingBytes <= TRACE_MAX_BYTES) return
    await fsp.rm(`${this.filename}.${TRACE_FILES - 1}`, { force: true })
    for (let index = TRACE_FILES - 2; index >= 1; index--) {
      try { await fsp.rename(`${this.filename}.${index}`, `${this.filename}.${index + 1}`) }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    try { await fsp.rename(this.filename, `${this.filename}.1`) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    this.bytes = 0
  }

  emit(event) {
    const line = `${JSON.stringify(sanitizeTraceValue(event))}\n`
    const bytes = Buffer.byteLength(line)
    this.queue = this.queue.then(async () => {
      await this.rotate(bytes)
      await fsp.appendFile(this.filename, line, { encoding: 'utf8', mode: 0o600 })
      this.bytes += bytes
    }).catch((error) => {
      if (!this.warned) {
        this.warned = true
        this.log(`Behavior trace write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return this.queue
  }
}

function actorFields(status) {
  if (!status || typeof status !== 'object') return undefined
  return {
    mode: status.mode,
    actor_id: status.actor_id,
    actor_kind: status.actor_kind,
    epoch: status.epoch,
    idle: status.idle,
    connected_players: status.connected_players,
  }
}

function messageChars(message) {
  return String(message?.content ?? '').length + JSON.stringify(message?.tool_calls ?? '').length
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstUsageNumber(...values) {
  for (const value of values) {
    const valid = finiteNonNegative(value)
    if (valid !== undefined) return valid
  }
  return 0
}

function normalizedProviderUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {}
  const cached = firstUsageNumber(
    details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.input_cache_hit_tokens,
    usage.cache_hit_tokens,
  )
  const explicitMiss = firstUsageNumber(
    usage.prompt_cache_miss_tokens,
    usage.input_cache_miss_tokens,
    usage.cache_miss_tokens,
  )
  const input = firstUsageNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    cached + explicitMiss,
  )
  const output = firstUsageNumber(usage.completion_tokens, usage.output_tokens)
  const total = firstUsageNumber(usage.total_tokens, input + output)
  const miss = explicitMiss > 0 ? explicitMiss : Math.max(0, input - cached)
  return {
    input_units: input,
    cached_input_units: cached,
    cache_miss_input_units: miss,
    output_units: output,
    total_units: total,
  }
}

function emptyUsageSummary() {
  return {
    provider_calls: 0,
    input_units: 0,
    cached_input_units: 0,
    cache_miss_input_units: 0,
    output_units: 0,
    total_units: 0,
    tool_calls: 0,
    duplicate_tool_calls: 0,
    tool_result_chars: 0,
    coalesced_runtime_events: 0,
  }
}

function accumulateProviderUsage(summary, usage) {
  if (!summary) return
  summary.provider_calls++
  if (!usage) return
  summary.input_units += usage.input_units
  summary.cached_input_units += usage.cached_input_units
  summary.cache_miss_input_units += usage.cache_miss_input_units
  summary.output_units += usage.output_units
  summary.total_units += usage.total_units
}

function compactProviderMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const structured = metadata.structured_content && typeof metadata.structured_content === 'object'
    ? {
        json_valid: metadata.structured_content.json_valid,
        plan_valid: metadata.structured_content.plan_valid,
        error: cleanMemoryText(metadata.structured_content.error, 800),
      }
    : undefined
  return {
    response_id: metadata.response_id,
    model: metadata.model,
    finish_reason: metadata.finish_reason,
    diagnostic_code: metadata.diagnostic_code,
    response_bytes: finiteNonNegative(metadata.response_bytes),
    content_chars: finiteNonNegative(metadata.content_chars),
    content_utf8_bytes: finiteNonNegative(metadata.content_utf8_bytes),
    content_non_ascii_chars: finiteNonNegative(metadata.content_non_ascii_chars),
    content_replacement_chars: finiteNonNegative(metadata.content_replacement_chars),
    normalized_content_chars: finiteNonNegative(metadata.normalized_content_chars),
    reasoning_content_chars: finiteNonNegative(metadata.reasoning_content_chars),
    reasoning_effort: cleanMemoryText(metadata.reasoning_effort, 32),
    reasoning_policy_reason: cleanMemoryText(metadata.reasoning_policy_reason, 80),
    tool_call_count: finiteNonNegative(metadata.tool_call_count),
    structured_content: structured,
    content_preview: typeof metadata.content_preview === 'string' ? metadata.content_preview.slice(0, 1200) : undefined,
  }
}

function compactPlanFailureState(state) {
  if (!state || typeof state !== 'object') return undefined
  return {
    goal_id: state.goal_id,
    status: state.status,
    blocker: cleanMemoryText(state.blocker, 300),
    revision: state.revision,
    current_step: state.current_step,
    current_step_text: currentPlanStep(state.plan, state.current_step),
  }
}

function compactTaskBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return undefined
  return {
    batch_id: Number.isSafeInteger(batch.batch_id) ? batch.batch_id : undefined,
    task_count: Number.isSafeInteger(batch.task_count) ? batch.task_count : undefined,
    task_types: Array.isArray(batch.task_types) ? batch.task_types.slice(0, 16) : undefined,
    tick: Number.isFinite(batch.tick) ? batch.tick : undefined,
    reason: typeof batch.reason === 'string' ? cleanMemoryText(batch.reason, 800) : undefined,
  }
}

function taskStatusDecisionView(raw) {
  try {
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!status || typeof status !== 'object' || Array.isArray(status)) return { status_error: 'invalid_task_status' }
    return {
      task_state: status.task_state,
      queue_empty: status.queue_empty,
      queue_length: status.queue_length,
      last_completed_batch: compactTaskBatch(status.last_completed_batch),
      last_cancelled_batch: compactTaskBatch(status.last_cancelled_batch),
      basic_operation: status.basic_operation?.last_result
        ? { last_result: status.basic_operation.last_result }
        : undefined,
    }
  }
  catch {
    return { status_error: 'invalid_task_status_json' }
  }
}

const INTERACTION_INTENTS = new Set([
  'continue_current',
  'status_query',
  'amend_current',
  'new_goal',
  'cancel_current',
  'chat_only',
])

const INTERACTION_ROUTER_PROMPT = `Classify one incoming human message relative to the currently active Factorio goal.
You are a side-channel interaction router only. You have no Factorio tools and must never propose or execute world operations.

Intents:
- continue_current: asks to keep/resume the same goal without changing its constraints.
- status_query: asks what is happening, progress, blocker, or why it is stuck.
- amend_current: changes instructions/constraints for the same goal, including "continue but ignore X".
- new_goal: requests a materially different goal.
- cancel_current: asks to stop/cancel the current goal.
- chat_only: social/conversational text that should not alter task state.

Use current_goal and runtime only to classify relationship/lifecycle. Never infer world facts beyond them.
For amend_current, set queue_conflict=true only when the amendment conflicts with work that is already running or queued. Otherwise set it false.
For every non-amend intent, queue_conflict must be false.
Return exactly one JSON object with exactly three fields:
{"intent":"continue_current|status_query|amend_current|new_goal|cancel_current|chat_only","queue_conflict":false,"reply":""}
reply must be empty except for chat_only, where it may contain one brief conversational response. No markdown.`

export function interactionDecisionQuestions() {
  return {
    intent: {
      type: 'choice',
      instructions: 'Classify the incoming human message relative to the current Factorio goal and authoritative runtime state.',
      criteria: {
        continue_current: 'The player asks SGLuna to keep or resume the same goal without changing its constraints.',
        status_query: 'The player asks what is happening, current progress, a blocker, or why the agent is stuck.',
        amend_current: 'The player changes instructions or constraints for the same active goal.',
        new_goal: 'The player requests a materially different world goal.',
        cancel_current: 'The player asks to stop or cancel the current goal.',
        chat_only: 'The message is social or conversational and should not change task state.',
      },
    },
    queue_conflict: {
      type: 'noul',
      instructions: 'Only when the message amends the current goal: would applying that amendment conflict with world work that is already running or queued? For every other intent, answer false.',
      criteria: {
        true: 'The amendment conflicts with work that is already running or queued and should not be deferred.',
        false: 'There is no amendment, or the amendment is compatible with the work already running or queued.',
      },
    },
  }
}

export function parseInteractionDecisionShadow(response) {
  const intentAnswer = response?.answers?.intent
  const conflictAnswer = response?.answers?.queue_conflict
  if (!intentAnswer || !INTERACTION_INTENTS.has(intentAnswer.choice)) throw new AgentLoopError('Decision provider returned invalid interaction intent')
  if (typeof intentAnswer.confidence !== 'number' || !Number.isFinite(intentAnswer.confidence) || intentAnswer.confidence < 0 || intentAnswer.confidence > 1) {
    throw new AgentLoopError('Decision provider returned invalid interaction confidence')
  }
  if (!conflictAnswer || typeof conflictAnswer.noul !== 'number' || !Number.isFinite(conflictAnswer.noul) || conflictAnswer.noul < 0 || conflictAnswer.noul > 1) {
    throw new AgentLoopError('Decision provider returned invalid queue-conflict probability')
  }
  return {
    intent: intentAnswer.choice,
    intent_confidence: intentAnswer.confidence,
    intent_probabilities: intentAnswer.probabilities,
    queue_conflict_probability: conflictAnswer.noul,
    queue_conflict: intentAnswer.choice === 'amend_current' && conflictAnswer.noul >= 0.5,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function parseInteractionRoute(message) {
  if (!message || typeof message !== 'object' || message.tool_calls !== undefined) {
    throw new AgentLoopError('Interaction router returned tools or no message')
  }
  let parsed
  try { parsed = JSON.parse(String(message.content ?? '')) }
  catch { throw new AgentLoopError('Interaction router returned invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentLoopError('Interaction router returned invalid object')
  const keys = Object.keys(parsed).sort()
  if (keys.length !== 3 || keys[0] !== 'intent' || keys[1] !== 'queue_conflict' || keys[2] !== 'reply') throw new AgentLoopError('Interaction router returned unexpected fields')
  if (!INTERACTION_INTENTS.has(parsed.intent)) throw new AgentLoopError('Interaction router returned invalid intent')
  if (typeof parsed.queue_conflict !== 'boolean') throw new AgentLoopError('Interaction router returned invalid queue_conflict')
  if (parsed.intent !== 'amend_current' && parsed.queue_conflict !== false) throw new AgentLoopError('Interaction router queue_conflict is only valid for amendments')
  if (typeof parsed.reply !== 'string' || parsed.reply.length > 500) throw new AgentLoopError('Interaction router returned invalid reply')
  return { intent: parsed.intent, queue_conflict: parsed.intent === 'amend_current' ? parsed.queue_conflict : false, reply: cleanMemoryText(parsed.reply, 500) }
}

function compactInteractionTaskStatus(raw) {
  try {
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!status || typeof status !== 'object' || Array.isArray(status)) return { status_error: 'invalid_task_status' }
    return {
      task_state: typeof status.task_state === 'string' ? status.task_state : undefined,
      queue_empty: status.queue_empty === true,
      queue_length: Number.isSafeInteger(status.queue_length) ? status.queue_length : undefined,
      current_task: status.current_task && typeof status.current_task === 'object' && !Array.isArray(status.current_task)
        ? status.current_task
        : undefined,
      last_completed_batch: compactTaskBatch(status.last_completed_batch),
      last_cancelled_batch: compactTaskBatch(status.last_cancelled_batch),
    }
  }
  catch {
    return { status_error: 'invalid_task_status_json' }
  }
}

export function interactionRuntimeHealthy(status) {
  if (!status || status.status_error) return false
  const taskState = typeof status.task_state === 'string' ? status.task_state.trim().toLowerCase() : ''
  return (taskState !== '' && taskState !== 'idle')
    || (Number.isSafeInteger(status.queue_length) && status.queue_length > 0)
}

function interactionStatusReply(status, plan) {
  if (status?.status_error) return `I could not read authoritative Autorio task state: ${status.status_error}`
  const task = status?.task_state || 'idle'
  const queue = Number.isSafeInteger(status?.queue_length) ? status.queue_length : 0
  const objective = cleanMemoryText(plan?.objective ?? '', 180)
  const step = Number.isSafeInteger(plan?.task_board?.active_index) ? plan.task_board.active_index + 1 : undefined
  const total = Number.isSafeInteger(plan?.task_board?.total_steps) ? plan.task_board.total_steps : undefined
  const progress = step && total ? `, canonical step ${Math.min(step, total)}/${total}` : ''
  return `Autorio is currently ${task} with ${queue} queued task${queue === 1 ? '' : 's'}${progress}.${objective ? ` Current goal: ${objective}` : ''}`
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function taskStatusDelta(previous, current) {
  if (!previous) return { observation_mode: 'full', ...current }
  const delta = {
    observation_mode: 'diff',
    task_state: current.task_state,
    queue_empty: current.queue_empty,
    queue_length: current.queue_length,
  }
  let changed = false
  for (const key of ['last_completed_batch', 'last_cancelled_batch', 'basic_operation', 'status_error']) {
    if (!sameJsonValue(previous[key], current[key])) {
      delta[key] = current[key]
      changed = true
    }
  }
  if (!sameJsonValue(previous.task_state, current.task_state)
    || !sameJsonValue(previous.queue_empty, current.queue_empty)
    || !sameJsonValue(previous.queue_length, current.queue_length)) changed = true
  if (!changed) delta.observation_mode = 'unchanged'
  return delta
}

function runtimeReceiptKey(kind, view, detail = '', epoch) {
  const batch = kind === 'failure'
    ? (view?.last_cancelled_batch ?? view?.last_completed_batch)
    : (view?.last_completed_batch ?? view?.last_cancelled_batch)
  const batchId = Number.isSafeInteger(batch?.batch_id) ? batch.batch_id : undefined
  const prefix = `${epoch ?? 'no-epoch'}:${kind}`
  if (batchId !== undefined) return `${prefix}:batch:${batchId}:${cleanMemoryText(detail, 300)}`
  return `${prefix}:state:${JSON.stringify(view)}:${cleanMemoryText(detail, 300)}`
}

function stateFileFromOptions(options) {
  if (options.stateFile === null) return null
  if (typeof options.stateFile === 'string' && options.stateFile.length > 0) return path.resolve(options.stateFile)
  if (typeof process.env.AIRI_NPC_STATE_FILE === 'string' && process.env.AIRI_NPC_STATE_FILE.trim()) return path.resolve(process.env.AIRI_NPC_STATE_FILE)
  if (process.env.NODE_TEST_CONTEXT) return null
  return path.join(path.resolve(process.env.CONTAINER_ROOT || '/home/container'), '.airi', 'npc-state.json')
}

function planProgress(plan, stateResult) {
  const progress = taskBoardProgress(stateResult?.state?.task_board)
  if (stateResult?.blockedByHarness) {
    return `[Plan paused] ${progress?.step || 'Remaining work'}: no Autorio operation was submitted, so AIRI did not pretend that execution continued.`
  }
  if (stateResult?.persistentRuntimeActive) return plan.chatMessage
  if (plan.operations.length > 0 && progress?.total > 0) {
    return `[Plan ${progress.index}/${progress.total}] ${progress.step}${plan.chatMessage ? ` — ${plan.chatMessage}` : ''}`
  }
  if (stateResult?.state?.status === 'completed') {
    return plan.chatMessage ? `[Plan complete] ${plan.chatMessage}` : '[Plan complete] Goal verified complete.'
  }
  return plan.chatMessage
}

function providerOutputBudgetExhausted(message) {
  return message?._airiProvider?.output_budget_exhausted === true
    || message?._airiProvider?.diagnostic_code === 'provider_output_budget_exhausted'
}

function operationSignature(operation) {
  return cleanMemoryText(`${operation?.name ?? ''} ${JSON.stringify(operation?.args ?? {})}`, 800)
}

function replayedCompletedOperations(plan, guard) {
  if (!guard || !Array.isArray(guard.completed_operations) || guard.completed_operations.length === 0) return []
  const completed = new Set(guard.completed_operations)
  return (plan?.operations ?? []).map(operationSignature).filter(signature => completed.has(signature))
}

function latestDeterministicCompletionEvidence(state) {
  const latest = state?.task_board?.evidence?.at(-1)
  if (latest?.kind !== 'deterministic_verification') return false
  try {
    const summary = JSON.parse(latest.summary)
    return summary?.verdict === 'verified_complete'
  }
  catch {
    return false
  }
}

function outputBudgetRecoveryEvidenceAvailable(state, reason) {
  if (reason === 'failure') return true
  return reason === 'completion' && latestDeterministicCompletionEvidence(state)
}

function protectOutputBudgetRecoveryPlan(plan, state, guard) {
  if (!guard || guard.world_evidence_observed || !state?.task_board || (guard.goal_id && guard.goal_id !== state.goal_id)) return plan
  const canonical = Array.isArray(state.task_board.steps)
    ? state.task_board.steps.map(step => String(step?.description ?? '')).filter(Boolean)
    : []
  if (canonical.length === 0) return plan
  const currentStep = Number.isSafeInteger(state.task_board.active_index)
    ? Math.min(Math.max(state.task_board.active_index, 0), canonical.length - 1)
    : 0
  return {
    ...plan,
    plan: canonical,
    currentStep,
  }
}

function providerBlockerReason(plan) {
  const text = cleanMemoryText(plan?.chatMessage, 2000)
  if (!text.toUpperCase().startsWith(ACTION_OMISSION_BLOCKER_PREFIX)) return ''
  return cleanMemoryText(text.slice(ACTION_OMISSION_BLOCKER_PREFIX.length), 1200)
}

function canonicalWorkRemains(state) {
  const board = state?.task_board
  if (state?.status !== 'active' || board?.kind !== 'task_board_lite' || !Array.isArray(board.steps) || board.steps.length === 0) return false
  return board.status === 'active' && (board.completed_count ?? 0) < board.steps.length
}

function persistentRuntimeHealthy(runtime) {
  return runtime?.active === true && runtime.healthy === true && runtime.controller_live === true
}

function finalStepCanCloseFromFreshObservation(state) {
  const stored = Array.isArray(state?.last_operations) ? state.last_operations.slice(-16) : []
  if (state?.last_mutation_verified === true) return true
  if (stored.length === 0) return false
  return stored.every(value => /^wait(?:\s|$)/i.test(String(value ?? '').trim()))
}

function terminalControlOnlyPlanStep(value) {
  const text = cleanMemoryText(value, 120).toLowerCase().replace(/[.!]+$/g, '').trim()
  return text === 'stop'
    || text === 'done'
    || text === 'finish'
    || text === 'finished'
    || text === 'complete'
    || text === 'completed'
}

function verifiedFinalCompletion(plan, state, triggerSource, { freshObservation = false } = {}) {
  if (triggerSource !== 'completion' || plan?.operations?.length !== 0 || plan?.plan?.length !== 0) return false
  const board = state?.task_board
  if (state?.status !== 'active') return false
  if (!board || board.kind !== 'task_board_lite' || !Array.isArray(board.steps) || board.steps.length === 0) return false
  const activeIndex = Number.isSafeInteger(board.active_index) ? board.active_index : -1
  if (activeIndex < 0 || activeIndex >= board.steps.length) return false
  const trailingSteps = board.steps.slice(activeIndex + 1)
  if (trailingSteps.some(step => !terminalControlOnlyPlanStep(step?.description))) return false
  const ref = Number.isSafeInteger(state.last_verified_batch_id) ? `batch_${state.last_verified_batch_id}` : ''
  const deterministicCurrentStep = [...(board.evidence ?? [])].reverse().some(item => item?.kind === 'deterministic_verification'
    && item?.step_id === board.active_step_id
    && (!ref || item?.ref === ref))
  if (deterministicCurrentStep) return true
  return freshObservation === true && finalStepCanCloseFromFreshObservation(state)
}

function actionOmissionRecoveryCapsule(state, runtimeStatus) {
  const board = state?.task_board
  const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : state?.current_step ?? 0
  const activeStep = Array.isArray(board?.steps) ? board.steps[activeIndex] : undefined
  const capsule = {
    goal_id: sanitizeDurableModelText(state?.goal_id, 100),
    objective: sanitizeDurableModelText(state?.objective, 1000),
    canonical_step: {
      index: activeIndex,
      id: sanitizeDurableModelText(activeStep?.id, 100),
      description: sanitizeDurableModelText(activeStep?.description ?? currentPlanStep(state?.plan, activeIndex), 500),
    },
    remaining_steps: (Array.isArray(board?.steps) ? board.steps : [])
      .slice(activeIndex, activeIndex + 8)
      .map(step => ({
        id: sanitizeDurableModelText(step?.id, 100),
        description: sanitizeDurableModelText(step?.description, 500),
        status: sanitizeDurableModelText(step?.status, 32),
      })),
    progress: {
      completed_count: Number.isSafeInteger(board?.completed_count) ? board.completed_count : 0,
      total_steps: Array.isArray(board?.steps) ? board.steps.length : 0,
    },
    authoritative_evidence: (Array.isArray(board?.evidence) ? board.evidence : []).slice(-4).map(item => sanitizeDurableModelValue(item)),
    runtime: sanitizeDurableModelValue(runtimeStatus ?? state?.persistent_runtime),
    durable_locators: modelFacingEntityReferences(state).slice(-4),
    reason: 'action_omission_recovery',
    contract: {
      normal_path_extra_calls: 0,
      allowed_targeted_observations: 1,
      next_response: 'submit the next executable operation, or start chatMessage with BLOCKED: and name the exact missing fact/truthful blocker',
      exact_identity: 'historical unit_number values are non-executable; bind any exact identity from a live observation in this active request',
    },
  }
  return `[ACTION_OMISSION_RECOVERY] Compact recovery capsule. It intentionally omits unrelated dialogue and historical tool results.\n${JSON.stringify(capsule)}`
}

export class NpcAgentLoop extends BaseNpcAgentLoop {
  constructor(options) {
    const memory = options.memory ?? new NpcDialogueMemory()
    super({
      ...options,
      memory,
      systemPrompt: `${options.systemPrompt}\n\n${DURABLE_PLAN_PROMPT}`,
    })
    this.stateFile = stateFileFromOptions(options)
    this.stateLoaded = false
    this.interactionProvider = typeof options.interactionProvider === 'function' ? options.interactionProvider : null
    this.interactionDecisionProvider = typeof options.interactionDecisionProvider === 'function' ? options.interactionDecisionProvider : null
    this.interactionAbort = null
    this.persistQueue = Promise.resolve()
    this.traceRequest = null
    this.traceRequestSequence = 0
    this.decisionRequestSequence = 0
    this.decisionTraceSequence = 0
    this.planUpdateReason = 'request'
    this.requestLifecycle = 'new_goal'
    this.pendingInteractionAmendment = null
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    this.liveEntityObservations = new Map()
    this.rejectedExactTargets = new Set()
    this.staleExactPreflightRetries = 0
    this.onActivity = typeof options.onActivity === 'function' ? options.onActivity : null
    this.turnSequence = Math.max(this.turnSequence, memory.maxTurnId?.() ?? 0)
    const traceFile = options.traceFile ?? process.env.SGLUNA_BEHAVIOR_TRACE_FILE ?? process.env.AIRI_BEHAVIOR_TRACE_FILE
      ?? (process.env.NODE_TEST_CONTEXT ? null : path.resolve(process.cwd(), 'logs', 'sgluna-behavior.jsonl'))
    this.behaviorTrace = traceFile ? new BehaviorTraceWriter(traceFile, message => this.log(`[trace] ${message}`)) : null
    const decisionTraceFile = Object.prototype.hasOwnProperty.call(options, 'decisionTraceFile')
      ? options.decisionTraceFile
      : (process.env.SGLUNA_DECISION_TRACE_FILE
        ?? (this.interactionDecisionProvider && !process.env.NODE_TEST_CONTEXT
          ? path.resolve(process.cwd(), 'logs', 'sgluna-decision.jsonl')
          : null))
    this.decisionTrace = this.interactionDecisionProvider && decisionTraceFile
      ? new BehaviorTraceWriter(decisionTraceFile, message => this.log(`[decision-trace] ${message}`))
      : null
  }

  async loadPersistentState() {
    if (this.stateLoaded) return
    this.stateLoaded = true
    if (!this.stateFile || typeof this.memory.restore !== 'function') return
    try {
      const parsed = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'))
      this.memory.restore(parsed)
      this.turnSequence = Math.max(this.turnSequence, this.memory.maxTurnId?.() ?? 0)
      this.log(`[memory] restored durable NPC state from ${this.stateFile}`)
    }
    catch (error) {
      if (error?.code === 'ENOENT') return
      this.log(`[memory] ignored unreadable durable NPC state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async persistState() {
    if (!this.stateFile || typeof this.memory.snapshot !== 'function') return
    const filename = this.stateFile
    const snapshot = this.memory.snapshot()
    this.persistQueue = this.persistQueue.then(async () => {
      await fsp.mkdir(path.dirname(filename), { recursive: true })
      const temp = `${filename}.${process.pid}.tmp`
      await fsp.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await fsp.rename(temp, filename)
    }).catch(error => this.log(`[memory] durable NPC state write failed: ${error instanceof Error ? error.message : String(error)}`))
    return this.persistQueue
  }

  activePlanKey() {
    return this.requestInfo?.memoryKey ?? this.lastMemoryKey ?? `npc:${this.npcId}`
  }


  prepareContinuationContext() {
    super.prepareContinuationContext()
    const planContext = this.memory.planContext?.(this.activePlanKey())
    if (planContext) this.messages.push({ role: 'user', content: planContext })
  }

  isObservationToolName(name) {
    return isObservationToolName(name)
  }

  observationToolCommand(name, args) {
    return toolCommand(name, args)
  }

  recordLiveEntityObservation(entity, actorPosition, source, observationMeta = {}) {
    if (!entity || typeof entity !== 'object' || typeof entity.name !== 'string') return
    const unitNumber = Number.isSafeInteger(entity.unit_number) ? entity.unit_number : undefined
    const position = entity.position && Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y)
      ? { x: entity.position.x, y: entity.position.y }
      : undefined
    let distance = Number.isFinite(entity.distance) ? entity.distance : undefined
    if (distance === undefined && position && actorPosition
      && Number.isFinite(actorPosition.x) && Number.isFinite(actorPosition.y)) {
      distance = Math.hypot(position.x - actorPosition.x, position.y - actorPosition.y)
    }
    if (unitNumber !== undefined && position) {
      for (const [existingKey, existing] of this.liveEntityObservations.entries()) {
        if (existing?.unit_number === unitNumber || existing?.name !== entity.name || !existing?.position) continue
        if (existing.position.x === position.x && existing.position.y === position.y) {
          this.liveEntityObservations.delete(existingKey)
        }
      }
    }
    const key = unitNumber !== undefined
      ? `unit:${unitNumber}`
      : `fallback:${entity.name}:${entity.type ?? 'unknown'}:${position?.x ?? '?'}:${position?.y ?? '?'}`
    const surface = [entity.surface_name, entity.surface, observationMeta.surface_name, observationMeta.surface]
      .find(value => typeof value === 'string' && value)
    const surfaceIndex = [entity.surface_index, observationMeta.surface_index]
      .find(value => Number.isSafeInteger(value))
    this.liveEntityObservations.set(key, {
      name: entity.name,
      type: entity.type,
      unit_number: unitNumber,
      position,
      distance,
      surface,
      surface_index: surfaceIndex,
      source,
    })
  }

  recordLiveEntityToolResult(toolName, raw) {
    if (!['getNearbyEntities', 'getEntityStatus', 'findLongRangeEntities'].includes(toolName)) return
    let parsed
    try { parsed = JSON.parse(String(raw ?? '')) }
    catch { return }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const actorPosition = parsed.actor_position
    const observationMeta = {
      surface: parsed.surface,
      surface_name: parsed.surface_name,
      surface_index: parsed.surface_index,
    }
    if (Array.isArray(parsed.entities)) {
      for (const entity of parsed.entities) this.recordLiveEntityObservation(entity, actorPosition, toolName, observationMeta)
    }
    if (parsed.entity && typeof parsed.entity === 'object') {
      this.recordLiveEntityObservation(parsed.entity, actorPosition, toolName, observationMeta)
    }
  }

  liveObservedExactTarget(unitNumber) {
    return Number.isSafeInteger(unitNumber)
      ? this.liveEntityObservations?.get?.(`unit:${unitNumber}`)
      : undefined
  }

  observedMiningTargets(entityName) {
    const byReference = new Map()
    const remember = (entity, actorPosition) => {
      if (!entity || entity.name !== entityName) return
      const reference = Number.isSafeInteger(entity.unit_number)
        ? `entity:${entity.unit_number}`
        : `fallback:${entity.name}:${entity.type ?? 'unknown'}:${entity.position?.x ?? '?'}:${entity.position?.y ?? '?'}`
      let distance = Number.isFinite(entity.distance) ? entity.distance : undefined
      if (distance === undefined && actorPosition && entity.position
        && Number.isFinite(actorPosition.x) && Number.isFinite(actorPosition.y)
        && Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y)) {
        distance = Math.hypot(entity.position.x - actorPosition.x, entity.position.y - actorPosition.y)
      }
      byReference.set(reference, {
        name: entity.name,
        type: entity.type,
        unit_number: Number.isSafeInteger(entity.unit_number) ? entity.unit_number : undefined,
        position: entity.position,
        distance,
      })
    }

    for (const entity of this.liveEntityObservations?.values?.() ?? []) remember(entity, undefined)
    return [...byReference.values()]
  }

  legacyMiningApproachVerified(entityName) {
    const state = this.memory.currentPlan?.(this.activePlanKey())
    if (state?.last_mutation_verified !== true || !Array.isArray(state.last_operations)) return false
    return state.last_operations.some((value) => {
      const separator = typeof value === 'string' ? value.indexOf(' ') : -1
      if (separator < 1 || value.slice(0, separator) !== 'walk_to_entity') return false
      try {
        const args = JSON.parse(value.slice(separator + 1))
        return args?.entity_name === entityName
      }
      catch {
        return false
      }
    })
  }

  failureSnapshot(stage, message) {
    const request = this.traceRequest
    const planState = this.memory.currentPlan?.(this.activePlanKey())
    return {
      stage,
      message: cleanMemoryText(message, 2000),
      request_id: request?.id,
      turn: request ? this.continuations + 1 : undefined,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      provider: request?.last_provider_event,
      recovery: request?.recovery,
      last_tool: request?.last_tool,
      plan: compactPlanFailureState(planState),
      usage: request?.usage,
    }
  }

  async readInteractionTaskStatus() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 16000)
      return compactInteractionTaskStatus(raw)
    }
    catch (error) {
      return { status_error: cleanMemoryText(error instanceof Error ? error.message : String(error), 300) }
    }
  }

  async classifyInteraction(text, sender, taskStatus, planState) {
    const current = await super.captureEpoch()
    await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
    const currentGoal = planState
      ? {
          goal_id: sanitizeDurableModelText(planState.goal_id, 100),
          objective: sanitizeDurableModelText(planState.objective, 500),
          status: planState.status,
          active_step: Number.isSafeInteger(planState.task_board?.active_index)
            ? sanitizeDurableModelText(planState.task_board?.steps?.[planState.task_board.active_index]?.description, 300)
            : undefined,
        }
      : null
    if (!this.interactionProvider) throw new AgentLoopError('Interaction router provider is unavailable')

    const state = {
      message: cleanMemoryText(text, 4000),
      sender: cleanMemoryText(sender, 128),
      current_goal: currentGoal,
      runtime: taskStatus,
    }

    this.interactionAbort?.abort()
    const controller = new AbortController()
    this.interactionAbort = controller

    const decisionQuestions = interactionDecisionQuestions()
    const decisionId = this.interactionDecisionProvider
      ? `decision_${Date.now().toString(36)}_${(++this.decisionRequestSequence).toString(36)}`
      : undefined
    if (decisionId) {
      await this.decisionTraceEvent('decision.request', {
        decision_id: decisionId,
        contract: 'interaction_route',
        mode: 'shadow',
        question_ids: Object.keys(decisionQuestions),
        message_chars: state.message.length,
        has_current_goal: currentGoal !== null,
        runtime_task_state: cleanMemoryText(taskStatus?.task_state, 64),
        runtime_queue_length: Number.isSafeInteger(taskStatus?.queue_length) ? taskStatus.queue_length : 0,
      })
    }

    const decisionStartedAt = Date.now()
    const decisionPromise = this.interactionDecisionProvider
      ? this.interactionDecisionProvider(state, decisionQuestions, {
          epoch: current.epoch,
          actorId: current.actor_id,
          signal: controller.signal,
        }).then(async response => {
          const shadow = parseInteractionDecisionShadow(response)
          const latency_ms = Date.now() - decisionStartedAt
          await this.decisionTraceEvent('decision.response', {
            decision_id: decisionId,
            contract: 'interaction_route',
            mode: 'shadow',
            provider: shadow.provider,
            model: shadow.model,
            intent: shadow.intent,
            confidence: shadow.intent_confidence,
            queue_conflict_probability: shadow.queue_conflict_probability,
            latency_ms,
            input_units: Number.isFinite(shadow.usage?.input_tokens) ? Math.max(0, Math.trunc(shadow.usage.input_tokens)) : 0,
            output_units: Number.isFinite(shadow.usage?.output_tokens) ? Math.max(0, Math.trunc(shadow.usage.output_tokens)) : 0,
            cost_usd: Number.isFinite(shadow.usage?.cost) && shadow.usage.cost >= 0 ? shadow.usage.cost : 0,
          })
          return { shadow, latency_ms }
        }).catch(async error => {
          const latency_ms = Date.now() - decisionStartedAt
          const message = cleanMemoryText(error instanceof Error ? error.message : String(error), 300)
          await this.decisionTraceEvent('decision.fallback', {
            decision_id: decisionId,
            contract: 'interaction_route',
            mode: 'shadow',
            fallback_target: 'interaction_router',
            reason: message,
            latency_ms,
          })
          return { error: message, latency_ms }
        })
      : Promise.resolve(undefined)

    try {
      const message = await this.interactionProvider([
        { role: 'system', content: INTERACTION_ROUTER_PROMPT },
        { role: 'user', content: JSON.stringify(state) },
      ], {
        epoch: current.epoch,
        actorId: current.actor_id,
        round: 0,
        allowTools: false,
        recoveryAttempt: 0,
        triggerSource: 'interaction_router',
        interactionRouter: true,
        signal: controller.signal,
        requestBodyPatch: {
          max_tokens: 180,
          response_format: { type: 'json_object' },
        },
      })
      const route = parseInteractionRoute(message)
      const decision = await decisionPromise
      if (decisionId) {
        await this.decisionTraceEvent('decision.route_applied', {
          decision_id: decisionId,
          contract: 'interaction_route',
          mode: 'shadow',
          active_source: 'interaction_router',
          active_intent: route.intent,
          shadow_intent: decision?.shadow?.intent ?? '',
          agreement: decision?.shadow ? decision.shadow.intent === route.intent : undefined,
          shadow_available: Boolean(decision?.shadow),
        })
      }
      return {
        route,
        epoch: current,
        decision_id: decisionId,
        decision_shadow: decision?.shadow,
        decision_shadow_error: decision?.error,
        decision_shadow_latency_ms: decision?.latency_ms,
      }
    }
    finally {
      controller.abort()
      if (this.interactionAbort === controller) this.interactionAbort = null
    }
  }

  async cancelInteractionWorldWork(epoch) {
    if (!epoch || !Number.isSafeInteger(epoch.epoch)) return
    await executeAuthorizedBatch(
      this.rcon,
      epoch.epoch,
      [`remote.call('autorio_operations','cancel_all_tasks')`],
    )
  }

  async rememberRoutedInteraction(key, sender, text, assistant) {
    if (!this.memory?.remember) return
    this.memory.remember(key, ++this.turnSequence, {
      sender,
      user: text,
      assistant,
      operations: [],
    })
    await this.persistState()
  }

  stageCompatibleAmendment(sender, text) {
    if (!this.active || !this.epoch || !Array.isArray(this.baseMessages)) return false
    const content = `[CHAT] ${cleanMemoryText(sender, 128)}: ${cleanMemoryText(text, 4000)}`
    const alreadyPresent = this.baseMessages.some(message => message?.role === 'user' && message?.content === content)
    if (!alreadyPresent) this.baseMessages.push({ role: 'user', content })
    this.pendingInteractionAmendment = { sender: cleanMemoryText(sender, 128), text: cleanMemoryText(text, 4000) }
    return true
  }

  async request(text, options = {}) {
    await this.loadPersistentState()
    const sender = options.sender ?? 'unknown'
    this.lastMemoryKey = `npc:${this.npcId}`
    const memoryKey = this.activePlanKey()
    const planBefore = this.memory.currentPlan?.(memoryKey)
    const taskStatus = await this.readInteractionTaskStatus()
    const healthyRuntime = interactionRuntimeHealthy(taskStatus)
    let routed
    if (!this.interactionProvider) {
      routed = {
        route: { intent: planBefore ? 'continue_current' : 'new_goal', queue_conflict: false, reply: '' },
        epoch: undefined,
        router_bypassed: true,
        classifier_skipped: 'interaction_router_unavailable',
      }
    }
    else {
      try {
        routed = await this.classifyInteraction(text, sender, taskStatus, planBefore)
      }
      catch (error) {
        const fallbackIntent = healthyRuntime ? 'continue_current' : (planBefore ? 'amend_current' : 'new_goal')
        routed = {
          route: { intent: fallbackIntent, queue_conflict: false, reply: '' },
          epoch: healthyRuntime ? await super.captureEpoch() : undefined,
          router_error: cleanMemoryText(error instanceof Error ? error.message : String(error), 300),
        }
      }
    }

    const intent = routed.route.intent
    await this.traceEvent('interaction.routed', {
      sender,
      text,
      intent,
      queue_conflict: routed.route.queue_conflict,
      runtime_healthy: healthyRuntime,
      task_state: taskStatus.task_state,
      queue_length: taskStatus.queue_length,
      router_error: routed.router_error,
      classifier_skipped: routed.classifier_skipped,
      router_bypassed: routed.router_bypassed === true,
      decision_shadow: routed.decision_shadow,
      decision_shadow_error: routed.decision_shadow_error,
      decision_shadow_latency_ms: routed.decision_shadow_latency_ms,
      decision_shadow_status: routed.classifier_skipped
        ? 'classifier_skipped'
        : routed.decision_shadow
          ? 'called_success'
          : routed.decision_shadow_error
            ? 'call_failed'
            : this.interactionDecisionProvider
              ? 'configured_not_called'
              : 'not_configured',
    })

    if (!routed.router_bypassed && intent === 'continue_current' && healthyRuntime) {
      const reply = `Current Autorio work is still running (${taskStatus.task_state ?? 'active'}, queue ${taskStatus.queue_length ?? 0}); I will let it continue without restarting the planner.`
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'status_query') {
      const reply = interactionStatusReply(taskStatus, planBefore)
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'chat_only') {
      const reply = routed.route.reply || 'I am here.'
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'cancel_current') {
      if (healthyRuntime) await this.cancelInteractionWorldWork(routed.epoch)
      const state = this.memory.pausePlan?.(memoryKey, 'user_cancel')
      await this.persistState()
      super.cancel()
      const reply = state
        ? 'Cancelled the remaining Autorio work and paused the current goal.'
        : 'There is no active goal to cancel.'
      await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
      return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true }
    }

    if (!routed.router_bypassed && intent === 'amend_current' && healthyRuntime && routed.route.queue_conflict !== true) {
      if (this.stageCompatibleAmendment(sender, text)) {
        const reply = `The amendment is compatible with the Autorio work already running (queue ${taskStatus.queue_length ?? 0}), so I will not cancel that batch. I will apply the amendment at the next main-planner boundary.`
        await this.rememberRoutedInteraction(memoryKey, sender, text, reply)
        return { chatMessage: reply, plan: [], currentStep: 0, operations: [], interactionIntent: intent, routedOnly: true, amendmentDeferred: true }
      }
    }

    if (!routed.router_bypassed && intent === 'amend_current' && healthyRuntime) {
      await this.cancelInteractionWorldWork(routed.epoch)
      super.cancel()
    }
    else if (!routed.router_bypassed && intent === 'new_goal') {
      if (healthyRuntime) await this.cancelInteractionWorldWork(routed.epoch)
      super.cancel()
      this.memory.clearTaskContext?.(memoryKey)
      await this.persistState()
    }

    this.liveEntityObservations = new Map()
    this.rejectedExactTargets = new Set()
    this.staleExactPreflightRetries = 0
    this.bootstrapDependencyPreflightRetries = 0
    this.planUpdateReason = intent === 'new_goal'
      ? 'new_goal'
      : intent === 'amend_current'
        ? 'amend_current'
        : 'continue_current'
    this.requestLifecycle = intent
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    const resumeActionOmission = intent === 'continue_current'
      && planBefore?.status === 'active'
      && planBefore?.admission_status === 'action_omission_repair'
      && !healthyRuntime
    this.actionOmissionRepairActive = resumeActionOmission
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    if (resumeActionOmission) {
      this.memory.setNextContextOverride?.(memoryKey, actionOmissionRecoveryCapsule(planBefore, taskStatus))
    }
    if (this.traceRequest) await this.traceEvent('request.superseded', { usage: this.traceRequest.usage })
    this.traceRequest = {
      id: `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`,
      seq: 0,
      usage: emptyUsageSummary(),
    }
    await this.traceEvent('request.received', {
      sender,
      text,
      interaction_intent: intent,
      action_omission_recovery: resumeActionOmission,
    })
    try {
      const result = await super.request(text, options)
      if (this.requestInfo?.memoryKey) this.lastMemoryKey = this.requestInfo.memoryKey
      return { ...result, interactionIntent: intent, routedOnly: false }
    }
    catch (error) {
      if (this.traceRequest) {
        const message = error instanceof Error ? error.message : String(error)
        await this.traceEvent('request.failed', {
          stage: 'bind',
          message,
          usage: this.traceRequest.usage,
          failure_snapshot: this.failureSnapshot('bind', message),
        })
        this.traceRequest = null
      }
      throw error
    }
  }

  async pausePersistentPlan(reason = 'user_stop') {
    await this.loadPersistentState()
    const key = this.activePlanKey()
    const state = this.memory.pausePlan?.(key, reason)
    await this.persistState()
    super.cancel()
    return state
  }

  async finalizeCompletedTaskContext() {
    await this.loadPersistentState()
    const key = this.requestInfo?.memoryKey ?? this.lastMemoryKey ?? `npc:${this.npcId}`
    this.memory.clearTaskContext?.(key)
    await this.persistState()

    // Completion is a hard planner boundary. Do not carry the completed task's
    // provider working set, continuation counters, recovery state, or dialogue
    // context into the next goal.
    super.cancel()
    this.traceRequest = null
    this.planUpdateReason = 'request'
    this.requestLifecycle = 'new_goal'
    this.pendingInteractionAmendment = null
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.clearActionOmissionRecovery()
    this.liveEntityObservations = new Map()
    this.rejectedExactTargets = new Set()
    this.staleExactPreflightRetries = 0
    this.bootstrapDependencyPreflightRetries = 0
    return true
  }

  decisionTraceEvent(event, data = {}) {
    if (!this.decisionTrace) return Promise.resolve()
    const { decision_id, ...details } = data ?? {}
    return this.decisionTrace.emit({
      schema: 1,
      ts: new Date().toISOString(),
      seq: ++this.decisionTraceSequence,
      event,
      decision_id,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      data: details,
    })
  }

  traceEvent(event, data = {}) {
    if (this.onActivity) {
      try { this.onActivity(event, data) }
      catch (error) { this.log(`[trace] activity listener failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (!this.behaviorTrace) return Promise.resolve()
    const request = this.traceRequest
    // interaction.routed is a pre-request side-channel lifecycle signal. Keep it
    // available to the live UI via onActivity above, but do not write it into
    // the main planner behavior trace before a canonical request_id exists.
    if (event === 'interaction.routed' && !request) return Promise.resolve()
    if (['request.received', 'provider.error', 'plan.accepted', 'operations.ack', 'request.completed', 'request.failed'].includes(event)) {
      this.log(`[trace ${request?.id ?? '-'}] ${event}`)
    }
    return this.behaviorTrace.emit({
      schema: 1,
      ts: new Date().toISOString(),
      seq: request ? ++request.seq : 0,
      event,
      request_id: request?.id,
      turn: request ? this.continuations + 1 : undefined,
      actor_id: this.epoch?.actor_id,
      epoch: this.epoch?.epoch,
      data,
    })
  }

  async runGuarded() {
    try {
      return await super.runGuarded()
    }
    catch (error) {
      if (this.traceRequest) {
        const message = error instanceof Error ? error.message : String(error)
        await this.traceEvent('request.failed', {
          stage: 'runtime',
          message,
          usage: this.traceRequest.usage,
          failure_snapshot: this.failureSnapshot('runtime', message),
        })
        this.traceRequest = null
      }
      throw error
    }
  }

  async captureEpoch() {
    const status = await super.captureEpoch()
    await this.traceEvent('actor.bound', actorFields(status))
    return status
  }

  async taskStatusReceipt() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 16000)
      const evidence = receiptEvidence(raw, this.planUpdateReason === 'failure' ? 'failed' : 'completed')
      if (this.memory.recordBoardEvidence?.(this.activePlanKey(), evidence)) await this.persistState()
      const view = taskStatusDecisionView(raw)
      const providerStatus = taskStatusDelta(this.lastTaskStatusView, view)
      this.lastTaskStatusView = view
      // The UI refresh must observe the board after receipt reconciliation. Emitting
      // factorio.status before recordBoardEvidence let the console snapshot the old
      // active_index and leave Plan Tracker one step behind until a later event.
      await this.traceEvent('factorio.status', {
        observation_mode: providerStatus.observation_mode,
        raw_chars: raw.length,
        task_status: providerStatus,
      })
      return { raw, view, providerStatus }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const view = { status_error: message }
      const providerStatus = taskStatusDelta(this.lastTaskStatusView, view)
      this.lastTaskStatusView = view
      await this.traceEvent('factorio.status_error', { message })
      return { raw: JSON.stringify(view), view, providerStatus }
    }
  }

  async persistentRuntimeStatus() {
    try {
      const raw = String(await this.rcon.command(toolCommand('getFollowStatus', {}))).slice(0, 16000)
      const follow = JSON.parse(raw)
      if (!follow || follow.active !== true) return undefined
      const status = safePersistentRuntime({ kind: 'follow', ...follow })
      await this.traceEvent('persistent_runtime.status', { runtime: status })
      return status
    }
    catch (error) {
      await this.traceEvent('persistent_runtime.status_error', { message: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  async continueFromModMessage(modMessage, traceEventName) {
    if (!this.active || !this.epoch) return null
    const currentPlan = this.memory.currentPlan?.(this.activePlanKey())
    const continuationLimit = currentPlan?.status === 'active' ? 64 : this.maxContinuations
    if (this.continuations >= continuationLimit) {
      await this.pausePersistentPlan(`continuation_limit_${continuationLimit}`)
      throw new AgentLoopError(`Continuation limit reached (${continuationLimit}); durable plan paused`)
    }
    await this.assertCurrent()
    this.continuations++
    this.prepareContinuationContext()
    this.toolCache.clear()
    this.duplicateToolRounds = 0
    this.observationRecoveryRounds = 0
    this.observationOnlyRounds = 0
    this.observationDecisionPressure = false
    this.finiteNoOperationPressureUsed = false
    this.toolValidationRetries = 0
    this.planCategoryRetries = 0
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    this.staleExactPreflightRetries = 0
    this.messages.push({ role: 'user', content: cleanMemoryText(modMessage, 18000) })
    await this.traceEvent(traceEventName)
    return this.runGuarded()
  }

  async completed() {
    await this.loadPersistentState()
    if (!this.active) return null
    const pendingAmendment = this.pendingInteractionAmendment
    this.planUpdateReason = pendingAmendment ? 'amend_current' : 'completion'
    if (pendingAmendment) this.requestLifecycle = 'amend_current'
    await this.traceEvent('factorio.completed_signal', pendingAmendment ? { pending_amendment: true } : {})
    const receipt = await this.taskStatusReceipt()
    const receiptKey = runtimeReceiptKey('completion', receipt.view, '', this.epoch?.epoch)
    if (this.lastHandledRuntimeReceipt.completion === receiptKey) {
      if (this.traceRequest?.usage) this.traceRequest.usage.coalesced_runtime_events++
      await this.traceEvent('factorio.event_coalesced', {
        kind: 'completion',
        receipt_key: receiptKey,
        observation_mode: receipt.providerStatus.observation_mode,
      })
      return null
    }
    this.lastHandledRuntimeReceipt.completion = receiptKey
    const result = await this.continueFromModMessage(
      `[MOD] Autorio operation batch completed. Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}`,
      'factorio.completion_continuation',
    )
    if (pendingAmendment) this.pendingInteractionAmendment = null
    return result
  }

  async failed(errorText) {
    await this.loadPersistentState()
    if (!this.active) return null
    this.planUpdateReason = 'failure'
    const cleanError = cleanMemoryText(errorText, 4000)
    const receipt = await this.taskStatusReceipt()
    const receiptKey = runtimeReceiptKey('failure', receipt.view, cleanError, this.epoch?.epoch)
    if (this.lastHandledRuntimeReceipt.failure === receiptKey) {
      if (this.traceRequest?.usage) this.traceRequest.usage.coalesced_runtime_events++
      await this.traceEvent('factorio.event_coalesced', {
        kind: 'failure',
        receipt_key: receiptKey,
        observation_mode: receipt.providerStatus.observation_mode,
      })
      return null
    }
    this.lastHandledRuntimeReceipt.failure = receiptKey
    return this.continueFromModMessage(
      `[MOD] Autorio operation error: ${cleanError}. Dependent queued operations may have been cancelled. Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}`,
      'factorio.error_continuation',
    )
  }

  cancel(reason = 'cancelled') {
    this.interactionAbort?.abort()
    this.interactionAbort = null
    void this.traceEvent('request.cancelled', { reason, usage: this.traceRequest?.usage })
    this.traceRequest = null
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
    return super.cancel()
  }

  async callProvider(current, generation, {
    round,
    allowTools = true,
    recoveryAttempt = 0,
    recoveryKind,
    providerMessagesOverride,
  }) {
    const omissionRepair = this.actionOmissionRepairActive && recoveryKind !== 'output_budget_exhaustion'
    const effectiveAllowTools = omissionRepair && this.actionOmissionForceNoTools ? false : allowTools
    const effectiveRecoveryAttempt = omissionRepair ? Math.max(1, recoveryAttempt) : recoveryAttempt
    const traceRecoveryKind = omissionRepair ? 'action_omission' : recoveryKind
    if (omissionRepair && !effectiveAllowTools && this.actionOmissionObservationUsed) {
    }
    const budgetStartedAt = Date.now()
    let budget
    try {
      budget = await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
      await this.traceEvent('budget.reserved', { latency_ms: Date.now() - budgetStartedAt, usage: budget })
    }
    catch (error) {
      await this.traceEvent('budget.rejected', { latency_ms: Date.now() - budgetStartedAt, message: error instanceof Error ? error.message : String(error) })
      throw error
    }
    if (generation !== this.generation || !this.active || !this.epoch) throw new AgentLoopError('Model turn was cancelled or superseded')
    await this.assertCurrent()

    const controller = new AbortController()
    this.providerAbort = controller
    const providerMessages = providerMessagesOverride ?? this.providerMessages()
    const startedAt = Date.now()
    if (recoveryAttempt > 0 && this.traceRequest) {
      this.traceRequest.recovery = {
        ...(this.traceRequest.recovery ?? {}),
        attempt: recoveryAttempt,
        round,
        ...(traceRecoveryKind ? { kind: traceRecoveryKind } : {}),
      }
    }
    await this.traceEvent('provider.request', {
      round,
      trigger_source: this.planUpdateReason,
      allow_tools: effectiveAllowTools,
      recovery_attempt: effectiveRecoveryAttempt,
      recovery_kind: traceRecoveryKind,
      message_count: providerMessages.length,
      message_chars: providerMessages.reduce((total, message) => total + messageChars(message), 0),
    })
    let message
    try {
      message = await this.provider(providerMessages, {
        epoch: current.epoch,
        actorId: current.actor_id,
        round,
        allowTools: effectiveAllowTools,
        recoveryAttempt: effectiveRecoveryAttempt,
        recoveryKind,
        triggerSource: this.planUpdateReason,
        lifecycle: this.requestLifecycle,
        actionOmissionRepair: omissionRepair,
        requestBodyPatch: omissionRepair ? { max_tokens: ACTION_OMISSION_MAX_TOKENS } : undefined,
        signal: controller.signal,
      })
      const usage = normalizedProviderUsage(message?._airiProvider?.usage)
      accumulateProviderUsage(this.traceRequest?.usage, usage)
      const responseTrace = {
        kind: 'response',
        round,
        trigger_source: this.planUpdateReason,
        recovery_attempt: effectiveRecoveryAttempt,
        recovery_kind: traceRecoveryKind,
        latency_ms: Date.now() - startedAt,
        has_tool_calls: message?.tool_calls !== undefined,
        content_chars: typeof message?.content === 'string' ? message.content.length : 0,
        usage,
        provider: compactProviderMetadata(message?._airiProvider),
      }
      if (this.traceRequest) this.traceRequest.last_provider_event = responseTrace
      await this.traceEvent('provider.response', responseTrace)
    }
    catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      const errorTrace = {
        kind: 'error',
        round,
        trigger_source: this.planUpdateReason,
        recovery_attempt: effectiveRecoveryAttempt,
        recovery_kind: traceRecoveryKind,
        latency_ms: Date.now() - startedAt,
        message: messageText,
        timeout: /timed out/i.test(messageText),
        cancelled: /cancelled/i.test(messageText),
      }
      if (this.traceRequest) this.traceRequest.last_provider_event = errorTrace
      await this.traceEvent('provider.error', errorTrace)
      throw error
    }
    finally {
      if (this.providerAbort === controller) this.providerAbort = null
    }
    if (generation !== this.generation || !this.active) throw new AgentLoopError('Model turn was cancelled or superseded')
    await this.assertCurrent()
    if (!message || typeof message !== 'object') throw new AgentLoopError('Provider returned no message')
    if (omissionRepair && !effectiveAllowTools && message.tool_calls !== undefined) {
      const state = this.memory.currentPlan?.(this.activePlanKey())
      await this.traceEvent('recovery.action_omission_observation_rejected', {
        reason_code: 'observation_budget_exhausted',
        requested_tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
      })
      message = {
        ...message,
        tool_calls: undefined,
        content: JSON.stringify({
          chatMessage: 'Action-omission repair attempted another observation after the bounded observation budget was exhausted.',
          plan: Array.isArray(state?.plan) ? state.plan : [],
          currentStep: Number.isSafeInteger(state?.current_step) ? state.current_step : 0,
          operations: [],
        }),
      }
    }

    if (effectiveAllowTools && !omissionRepair && effectiveRecoveryAttempt === 0 && !this.outputBudgetRecoveryUsed && providerOutputBudgetExhausted(message)) {
      this.outputBudgetRecoveryUsed = true
      const state = this.memory.currentPlan?.(this.activePlanKey())
      this.outputBudgetRecoveryGuard = {
        goal_id: state?.goal_id,
        world_evidence_observed: outputBudgetRecoveryEvidenceAvailable(state, this.planUpdateReason),
        fresh_tool_evidence: false,
        completed_operations: this.planUpdateReason === 'completion' && Array.isArray(state?.last_operations)
          ? state.last_operations.slice(0, 16)
          : [],
      }
      if (this.traceRequest) {
        this.traceRequest.recovery = {
          reason: 'provider_output_budget_exhausted',
          attempt: 1,
          round,
          kind: 'output_budget_exhaustion',
        }
      }
      await this.traceEvent('provider.output_budget_recovery_started', {
        round,
        recovery_attempt: 1,
        recovery_kind: 'output_budget_exhaustion',
        canonical_goal_id: state?.goal_id,
        canonical_step: state?.task_board?.active_index,
        world_evidence_observed: this.outputBudgetRecoveryGuard.world_evidence_observed,
        completed_operation_count: this.outputBudgetRecoveryGuard.completed_operations.length,
      })
      return this.callProvider(current, generation, {
        round,
        allowTools: true,
        recoveryAttempt: 1,
        recoveryKind: 'output_budget_exhaustion',
        providerMessagesOverride: [
          ...providerMessages.map(item => ({ ...item })),
          { role: 'user', content: OUTPUT_BUDGET_RECOVERY_MESSAGE },
        ],
      })
    }
    return message
  }

  parsePlanMessage(message) {
    const plan = super.parsePlanMessage(message)
    for (const operation of plan.operations) {
      if (!EXACT_ENTITY_TARGET_OPERATIONS.has(operation.name)) continue
      const unitNumber = operation.args?.unit_number
      if (this.liveObservedExactTarget(unitNumber)) continue
      const repeated = this.rejectedExactTargets.has(unitNumber)
      this.rejectedExactTargets.add(unitNumber)
      const locator = historicalExactTargetLocator(this.memory.currentPlan?.(this.activePlanKey()), unitNumber)
      const location = locator?.position && Number.isFinite(locator.position.x) && Number.isFinite(locator.position.y)
        ? ` Durable semantic locator: ${locator.name ?? 'entity'} at absolute position (${locator.position.x}, ${locator.position.y})${locator.surface ? ` on surface ${locator.surface}` : ''}.`
        : locator?.name
          ? ` Durable semantic context identifies ${locator.name}, but no executable exact identity is retained.`
          : ''
      const error = new AgentLoopError(
        repeated
          ? `Exact entity target unit ${unitNumber} was already rejected in this active request and still has no live observation binding. Repeating the same historical exact identity cannot make it executable. Do not resubmit it; use durable location/context, obtain a fresh getNearbyEntities/getEntityStatus/findLongRangeEntities observation, and only then use the exact unit_number returned by that observation.${location}`
          : `Exact entity target unit ${unitNumber} is not bound by a live observation in this active request. Historical unit_number values are non-executable even when they appear in old diagnostics. Do not resubmit the rejected id. Use durable location/context to navigate with walk_to_position if needed, obtain a fresh getNearbyEntities/getEntityStatus/findLongRangeEntities observation, and then bind the exact unit_number returned by that current observation.${location}`,
      )
      error.failureClass = 'plan_category'
      error.code = 'exact_entity_requires_live_observation'
      error.details = {
        operation_name: operation.name,
        unit_number: unitNumber,
        durable_locator: locator,
        repeated_stale_exact_target: repeated,
        deterministic_no_retry: repeated,
      }
      throw error
    }
    for (const operation of plan.operations) {
      if (operation.name !== 'mine_entity') continue
      const targets = this.observedMiningTargets(operation.args.entity_name)
      const exact = targets.filter(target => Number.isSafeInteger(target.unit_number))
      if (exact.length > 0) {
        const error = new AgentLoopError(
          `Exact live identity was already observed for ${operation.args.entity_name}; use mine_entity_exact with an observed unit_number instead of falling back to legacy name-based mining. Exact mining owns runtime repositioning when the target is outside mining reach.`,
        )
        error.failureClass = 'plan_category'
        error.code = 'exact_identity_available_for_mining'
        error.details = {
          entity_name: operation.args.entity_name,
          observed_unit_numbers: exact.slice(0, 8).map(target => target.unit_number),
        }
        throw error
      }

      const remote = targets.filter(target => Number.isFinite(target.distance) && target.distance > 5)
      if (remote.length > 0 && !this.legacyMiningApproachVerified(operation.args.entity_name)) {
        const requiredRadius = Math.max(6, Math.min(4096, Math.ceil(Math.max(...remote.map(target => target.distance))) + 2))
        const error = new AgentLoopError(
          `The observed ${operation.args.entity_name} target is outside legacy local mining resolution and has no usable exact identity. Approach it first with walk_to_entity {entity_name:"${operation.args.entity_name}",search_radius:${requiredRadius}}, wait for authoritative navigation completion, then continue the same finite goal into mine_entity. A remote name observation is not proof that local mine_entity can resolve the target.`,
        )
        error.failureClass = 'plan_category'
        error.code = 'remote_name_mining_requires_approach'
        error.details = { entity_name: operation.args.entity_name, search_radius: requiredRadius }
        throw error
      }
    }

    const replayed = replayedCompletedOperations(plan, this.outputBudgetRecoveryGuard)
    if (replayed.length > 0) {
      void this.traceEvent('provider.output_budget_recovery_replay_rejected', {
        replayed_operation_count: replayed.length,
        replayed_operations: replayed,
      })
      throw new AgentLoopError('Output-budget recovery attempted to replay a completed world mutation')
    }
    return plan
  }

  prepareToolBatch(message) {
    try {
      return super.prepareToolBatch(message)
    }
    catch (error) {
      void this.traceEvent('tool.rejected', { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async handleToolBatch(message, prepared = this.prepareToolBatch(message)) {
    if (this.actionOmissionRepairActive && (this.actionOmissionObservationUsed || prepared.length !== 1)) {
      this.actionOmissionForceNoTools = true
      const reason = this.actionOmissionObservationUsed
        ? 'The action-omission repair already consumed its one targeted observation.'
        : `The action-omission repair permits exactly one targeted observation, but the provider requested ${prepared.length}.`
      this.messages.push({
        role: 'user',
        content: `[HARNESS] ${reason} No observation from this batch was executed. ${ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE}`,
      })
      await this.recoveryDiagnostic({
        failure_class: 'action_omission',
        reason_code: 'action_omission_observation_budget',
        reason,
        retry: 1,
        retry_limit: 1,
        tools_enabled: false,
      })
      return
    }

    const cachedBefore = prepared.map(entry => this.toolCache.has(entry.signature))
    const staticCachedBefore = prepared.map(entry => entry.tool.function.name === 'getPrototypeDetails' && this.staticPrototypeCache.has(entry.signature))
    for (let index = 0; index < prepared.length; index++) {
      const entry = prepared[index]
      if (this.traceRequest?.usage) {
        this.traceRequest.usage.tool_calls++
        if (cachedBefore[index]) this.traceRequest.usage.duplicate_tool_calls++
      }
      const toolTrace = {
        phase: 'call',
        tool_call_id: entry.tool.id,
        name: entry.tool.function.name,
        args: entry.args,
        cached: cachedBefore[index],
      }
      if (this.traceRequest) this.traceRequest.last_tool = toolTrace
      await this.traceEvent('tool.call', toolTrace)
    }
    const beforeCount = this.messages.length
    try {
      await super.handleToolBatch(message, prepared)
    }
    catch (error) {
      await this.traceEvent('tool.error', { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const results = this.messages.slice(beforeCount + 1).filter(item => item.role === 'tool')
    const freshResultObserved = results.some((_, index) => cachedBefore[index] !== true && staticCachedBefore[index] !== true)
    if (freshResultObserved) this.freshObservationSinceContinuation = true
    if (this.outputBudgetRecoveryGuard && freshResultObserved) {
      this.outputBudgetRecoveryGuard.world_evidence_observed = true
      this.outputBudgetRecoveryGuard.fresh_tool_evidence = true
    }
    for (let index = 0; index < results.length; index++) {
      const original = String(results[index].content ?? '')
      this.recordLiveEntityToolResult(prepared[index]?.tool?.function?.name, original)
      if (cachedBefore[index]) results[index].content = DUPLICATE_OBSERVATION_MESSAGE
      const output = String(results[index].content ?? '')
      if (this.traceRequest?.usage) this.traceRequest.usage.tool_result_chars += output.length
      const toolTrace = {
        phase: 'result',
        tool_call_id: prepared[index]?.tool.id,
        name: prepared[index]?.tool.function.name,
        cached: cachedBefore[index],
        original_output_chars: original.length,
        output_chars: output.length,
      }
      if (this.traceRequest) this.traceRequest.last_tool = toolTrace
      await this.traceEvent('tool.result', { ...toolTrace, output })
    }
    this.compactWorkingContext()
    if (this.actionOmissionRepairActive) {
      this.actionOmissionObservationUsed = true
      this.actionOmissionForceNoTools = true
      this.messages.push({ role: 'user', content: `[HARNESS] ${ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE}` })
      await this.traceEvent('recovery.action_omission_observation_complete', {
        cached: cachedBefore[0] === true,
        observation: prepared[0]?.tool?.function?.name,
        tools_enabled_next_round: false,
      })
    }
  }

  clearActionOmissionRecovery() {
    this.actionOmissionRepairActive = false
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    this.pendingFiniteNoOperationPlan = null
    this.freshObservationSinceContinuation = false
    this.genericRecoveryDecisionActive = false
  }

  async beginActionOmissionRepair(plan, reasonCode) {
    if (!this.requestInfo) return undefined
    const state = this.memory.beginActionOmissionRecovery?.(this.requestInfo.memoryKey, this.requestInfo, plan)
    if (!state || state.status !== 'active') return state
    this.actionOmissionRepairActive = true
    this.actionOmissionObservationUsed = false
    this.actionOmissionForceNoTools = false
    await this.persistState()
    await this.traceEvent('recovery.action_omission_started', {
      reason_code: reasonCode,
      goal_id: state.goal_id,
      active_step: state.task_board?.active_index,
      completed_count: state.task_board?.completed_count,
      provider_call_budget: '1 act-or-block call; one targeted observation may require one final no-tools decision call',
    })
    return state
  }

  async recoveryDiagnostic(details) {
    if (details?.reason_code === 'finite_goal_continuation_pressure' && this.pendingFiniteNoOperationPlan) {
      const omittedPlan = this.pendingFiniteNoOperationPlan
      this.pendingFiniteNoOperationPlan = null
      const state = await this.beginActionOmissionRepair(omittedPlan, 'finite_goal_continuation_pressure')
      if (state?.status === 'active') {
        this.messages.push({ role: 'assistant', content: JSON.stringify(omittedPlan) })
      }
    }
    if (this.traceRequest) this.traceRequest.recovery = { ...(this.traceRequest.recovery ?? {}), ...details }
    await this.traceEvent('recovery.classified', details)
  }

  finiteNoOperationPressure(plan) {
    if (plan?.operations?.length > 0 || !Array.isArray(plan?.plan) || plan.plan.length === 0) return ''
    if (providerBlockerReason(plan)) return ''
    const state = this.memory.currentPlan?.(this.activePlanKey())
    if (this.planUpdateReason !== 'completion' || state?.status !== 'active' || state?.last_mutation_verified !== true) return ''
    const latestVerification = [...(state?.task_board?.evidence ?? [])].reverse().find(item => item?.kind === 'deterministic_verification')
    if (!latestVerification) return ''
    this.pendingFiniteNoOperationPlan = plan
    return ACTION_OMISSION_REPAIR_MESSAGE
  }

  async preflightOperations(operations) {
    const results = []
    for (let index = 0; index < operations.length; index++) {
      const command = renderOperationPreflight(operations[index])
      if (!command) {
        results.push({ ok: true, operation: operations[index].name, validation: 'not_required' })
        continue
      }
      await this.assertCurrent()
      let result
      try {
        result = JSON.parse(String(await this.rcon.command(command)).trim())
      }
      catch (error) {
        const failure = new AgentLoopError(`Deterministic operation preflight failed to return valid JSON for operation ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
        failure.preflight = { ok: false, code: 'preflight_transport_error', operation_index: index }
        throw failure
      }
      await this.assertCurrent()
      results.push(result)
      if (result?.ok !== true) {
        const failure = new AgentLoopError(`Operation preflight rejected operation ${index + 1} (${operations[index].name}): ${result?.code ?? 'unknown_preflight_failure'}`)
        failure.preflight = { ...result, operation_index: index }
        throw failure
      }
    }
    return results
  }

  async markAdmissionFailure(stateResult, operations, failure, kind = 'admission_failure') {
    if (!this.requestInfo) return stateResult
    const operationIndex = Number.isSafeInteger(failure?.operationIndex)
      ? failure.operationIndex
      : Number.isSafeInteger(failure?.preflight?.operation_index)
        ? failure.preflight.operation_index
        : undefined
    const operation = operationIndex !== undefined ? operations[operationIndex] : undefined
    const factorioError = cleanMemoryText(failure?.factorioError ?? failure?.message ?? String(failure), 1600)
    const evidence = {
      kind,
      ref: `${this.traceRequest?.id ?? 'request'}/admission`,
      summary: JSON.stringify({
        request_id: this.traceRequest?.id,
        operation_index: operationIndex === undefined ? undefined : operationIndex + 1,
        operation_name: operation?.name,
        operation_args: sanitizeTraceValue(operation?.args ?? {}),
        reason_code: failure?.preflight?.code,
        factorio_error: factorioError,
        no_replay: failure?.noReplay === true,
      }),
    }
    const blocker = failure?.preflight?.code
      ? `operation_preflight_failed:${failure.preflight.code}`
      : 'operation_admission_failed'
    const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admission_failed', { blocker, evidence })
    await this.persistState()
    return state ? { ...(stateResult ?? {}), state } : stateResult
  }

  async finishNoOperationBlock(plan, before, blocker, reason, evidenceKind) {
    if (!this.requestInfo) {
      this.active = false
      this.clearActionOmissionRecovery()
      return {
        chatMessage: plan.chatMessage,
        plan: plan.plan,
        currentStep: plan.currentStep,
        operations: [],
        epoch: before.epoch,
        actorId: before.actor_id,
        blocked: true,
        blocker: { class: blocker, reason },
      }
    }

    let state = this.memory.currentPlan?.(this.requestInfo.memoryKey)
    if (!state && Array.isArray(plan.plan) && plan.plan.length > 0) {
      state = this.memory.beginActionOmissionRecovery?.(this.requestInfo.memoryKey, this.requestInfo, plan)
    }
    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
      sender: this.requestInfo.sender,
      user: this.requestInfo.text,
      assistant: plan.chatMessage,
      operations: [],
    })
    state = this.memory.blockRemainingPlan?.(this.requestInfo.memoryKey, {
      blocker,
      reason,
      chatMessage: plan.chatMessage,
      evidenceKind,
    }) ?? state
    await this.persistState()
    await this.traceEvent('plan.persisted', {
      lifecycle: 'blocked',
      blocker,
      goal_id: state?.goal_id,
      task_board: visibleTaskBoard(state?.task_board),
    })
    this.active = false
    await this.traceEvent('request.completed', {
      chat_message: plan.chatMessage,
      outcome: 'blocked_no_operation',
      task_board: visibleTaskBoard(state?.task_board),
      usage: this.traceRequest?.usage,
    })
    this.traceRequest = null
    this.clearActionOmissionRecovery()
    const visibleReason = providerBlockerReason(plan) || cleanMemoryText(reason, 800) || blocker
    return {
      chatMessage: `[Plan blocked] ${visibleReason}`,
      plan: state?.plan ?? plan.plan,
      currentStep: state?.current_step ?? plan.currentStep,
      operations: [],
      epoch: before.epoch,
      actorId: before.actor_id,
      goalId: state?.goal_id,
      goalStatus: state?.status ?? 'blocked',
      taskBoard: visibleTaskBoard(state?.task_board),
      blocker: { class: blocker, reason: cleanMemoryText(reason, 1200) },
    }
  }

  async commitPlan(plan) {
    const commands = plan.operations.map(renderOperation)
    const operations = plan.operations.map((operation, index) => ({
      trace_operation_id: `${this.traceRequest?.id ?? 'request'}/op_${index + 1}`,
      name: operation.name,
      args: operation.args,
    }))
    await this.traceEvent('plan.accepted', {
      trigger_source: this.planUpdateReason,
      chat_message: plan.chatMessage,
      plan: plan.plan,
      current_step: plan.currentStep,
      operations,
    })

    const before = await this.assertCurrent()
    const persistentRuntime = commands.length === 0 && plan.plan.length > 0
      ? await this.persistentRuntimeStatus()
      : undefined
    const previousState = this.requestInfo
      ? this.memory.currentPlan?.(this.requestInfo.memoryKey)
      : undefined
    const runtimeHealthy = persistentRuntimeHealthy(persistentRuntime)
    const finalCompletionVerified = verifiedFinalCompletion(plan, previousState, this.planUpdateReason, {
      freshObservation: this.freshObservationSinceContinuation,
    })
    const remainingCanonicalWork = !finalCompletionVerified && (
      canonicalWorkRemains(previousState)
      || (!previousState && Array.isArray(plan.plan) && plan.plan.length > 0)
    )
    const explicitBlocker = providerBlockerReason(plan)

    if (commands.length === 0 && remainingCanonicalWork && !runtimeHealthy) {
      if (this.genericRecoveryDecisionActive) {
        // Generic strict recovery exists because the provider already failed to
        // produce a valid decision. Tools are intentionally disabled there, so
        // a no-op/"BLOCKED" answer can describe the recovery sandbox rather
        // than a real Factorio blocker. Never persist that as semantic world
        // truth. Let the request fail upward; the supervisor will pause the
        // durable plan when Autorio is authoritatively idle, preserving the
        // verified prefix for a fresh tool-capable Continue turn.
        const attemptedBlocker = explicitBlocker
          ? ` Recovery attempted BLOCKED: ${cleanMemoryText(explicitBlocker, 600)}`
          : ''
        throw new AgentLoopError(
          `Provider strict recovery could not safely resolve remaining canonical work without a fresh normal tool-capable turn.${attemptedBlocker}`,
        )
      }
      if (explicitBlocker) {
        return this.finishNoOperationBlock(plan, before, 'provider_reported_blocker', explicitBlocker, 'provider_blocker')
      }
      if (this.outputBudgetRecoveryGuard && this.outputBudgetRecoveryGuard.world_evidence_observed !== true) {
        // Output-budget recovery is provider orchestration, not Factorio world
        // truth. If the bounded recovery cannot produce grounded evidence or an
        // executable operation, fail the request upward instead of persisting a
        // durable BLOCKED task. The supervisor will pause the durable plan only
        // when Autorio is authoritatively idle, preserving the verified prefix
        // for a fresh normal tool-capable Continue turn.
        throw new AgentLoopError(
          'provider_output_budget_exhausted: bounded output-budget recovery produced no fresh world evidence and no executable operation for remaining canonical work',
        )
      }
      if (this.actionOmissionRepairActive) {
        return this.finishNoOperationBlock(
          plan,
          before,
          'action_omission_after_repair',
          'The bounded act-or-block repair returned no executable operation and no explicit BLOCKED: reason.',
          'action_omission',
        )
      }
      const state = await this.beginActionOmissionRepair(plan, 'no_operation_for_remaining_plan')
      if (state?.status === 'active') {
        this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
        this.messages.push({ role: 'user', content: `[HARNESS] ${ACTION_OMISSION_REPAIR_MESSAGE}` })
        return this.runTurn()
      }
    }

    if (runtimeHealthy) this.clearActionOmissionRecovery()
    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    let stateResult
    let durablePlan = plan
    if (this.requestInfo) {
      this.lastMemoryKey = this.requestInfo.memoryKey
      const previousBoard = previousState?.task_board
      durablePlan = protectOutputBudgetRecoveryPlan(plan, previousState, this.outputBudgetRecoveryGuard)
      if (durablePlan !== plan) {
        await this.traceEvent('provider.output_budget_recovery_plan_guarded', {
          goal_id: previousState?.goal_id,
          canonical_step: durablePlan.currentStep,
          incoming_step: plan.currentStep,
          incoming_plan_length: plan.plan.length,
          canonical_plan_length: durablePlan.plan.length,
        })
      }
      const semanticRole = currentPlanStep(durablePlan.plan, durablePlan.currentStep)
      const durableOperations = plan.operations.slice(0, 16).map(operation => {
        const observation = Number.isSafeInteger(operation.args?.unit_number)
          ? this.liveObservedExactTarget(operation.args.unit_number)
          : undefined
        return durableOperationView(operation, { observation, semanticRole })
      })
      const exactTargetAudit = plan.operations.slice(0, 16).flatMap(operation => {
        const unitNumber = operation.args?.unit_number
        if (!Number.isSafeInteger(unitNumber)) return []
        const observation = this.liveObservedExactTarget(unitNumber)
        if (!observation) return []
        return [{
          unit_number: unitNumber,
          operation_name: cleanMemoryText(operation.name, 100),
          locator: durableEntityLocator(observation, semanticRole),
          recorded_at: Date.now(),
        }]
      })
      this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
        sender: this.requestInfo.sender,
        user: this.requestInfo.text,
        assistant: plan.chatMessage,
        operations: durableOperations,
      })
      stateResult = this.memory.recordPlan?.(this.requestInfo.memoryKey, this.requestInfo, durablePlan, {
        continuation: this.continuations > 0,
        persistentRuntime,
        durableOperations,
        exactTargetAudit,
      })
      stateResult = this.memory.reconcileTaskBoard?.(this.requestInfo.memoryKey, previousBoard, durablePlan, stateResult, {
        allowReplan: this.planUpdateReason === 'failure',
        previousState,
      }) ?? stateResult
      if (commands.length > 0 && stateResult?.state && stateResult?.blockedByHarness !== true) {
        const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admitting')
        if (state) stateResult = { ...stateResult, state }
      }
      await this.persistState()
      await this.traceEvent('plan.persisted', {
        lifecycle: stateResult?.blockedByHarness === true ? 'blocked' : commands.length > 0 ? 'admitting' : 'accepted',
        goal_id: stateResult?.state?.goal_id,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
      })
    }
    this.outputBudgetRecoveryGuard = null
    if (commands.length > 0) this.clearActionOmissionRecovery()

    if (commands.length > 0 && stateResult?.blockedByHarness === true) {
      this.active = false
      await this.traceEvent('operations.skipped', {
        reason: 'unresolved_transfer_step',
        blocker: stateResult?.state?.blocker,
        operations,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
      })
      await this.traceEvent('request.completed', {
        chat_message: plan.chatMessage,
        outcome: 'blocked_no_operation',
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
        usage: this.traceRequest?.usage,
      })
      this.traceRequest = null
      return {
        chatMessage: planProgress(plan, stateResult),
        plan: stateResult?.state?.plan ?? durablePlan.plan,
        currentStep: stateResult?.state?.current_step ?? durablePlan.currentStep,
        operations: [],
        epoch: before.epoch,
        actorId: before.actor_id,
        goalId: stateResult?.state?.goal_id,
        goalStatus: stateResult?.state?.status,
        taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
        blocker: {
          class: 'unverified_transfer_step',
          reason: stateResult?.state?.blocker ?? 'unverified_transfer_step',
        },
      }
    }

    if (commands.length > 0) {
      let preflight
      try {
        preflight = await this.preflightOperations(plan.operations)
        this.staleExactPreflightRetries = 0
        this.bootstrapDependencyPreflightRetries = 0
        await this.traceEvent('operations.preflight_ok', {
          operations: operations.map((operation, index) => ({ ...operation, preflight: preflight[index] })),
        })
      }
      catch (error) {
        if (error?.preflight?.code === 'bootstrap_dependency_unresolved' && this.bootstrapDependencyPreflightRetries < 2) {
          this.bootstrapDependencyPreflightRetries++
          if (this.requestInfo) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
            if (state) stateResult = { ...(stateResult ?? {}), state }
            this.memory.recordBoardEvidence?.(this.requestInfo.memoryKey, {
              kind: 'operation_preflight_rejection',
              ref: `${this.traceRequest?.id ?? 'request'}/bootstrap_dependency_unresolved`,
              summary: JSON.stringify({
                code: 'bootstrap_dependency_unresolved',
                operation_index: error.preflight.operation_index,
                operation: error.preflight.operation,
                item_name: error.preflight.identity,
                requested_count: error.preflight.requested_count,
                craftable_now_count: error.preflight.craftable_now_count,
                first_unresolved: error.preflight.bootstrap?.first_unresolved,
              }),
            })
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: 'bootstrap_dependency_unresolved',
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.bootstrapDependencyPreflightRetries,
          })
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Deterministic craft preflight rejected the requested craft before Autorio admission because it is not currently craftable. Resolve the first unresolved bootstrap dependency before retrying the downstream craft. Reuse held items/buildings marked already_satisfied; bootstrap only missing quantities. A machine dependency with satisfaction_scope=inventory_acquisition means the machine item is already owned, not that a placed live machine instance exists. If processing requires that machine, first use an existing live observed compatible instance or place one from the held item; after placement, re-observe it and bind its real unit_number before any exact supply/configuration operation. Never invent a unit_number. This bootstrap inventory is for construction/startup only and does not remove steady-state recipe flow from a continuous production topology. Preflight: ${JSON.stringify(error.preflight.bootstrap ?? {})}`,
          })
          return this.runTurn()
        }
        if (error?.preflight?.code === 'stale_exact_target' && this.staleExactPreflightRetries < 1) {
          this.staleExactPreflightRetries++
          if (this.requestInfo) {
            const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'preflight_rejected')
            if (state) stateResult = { ...(stateResult ?? {}), state }
            this.memory.recordBoardEvidence?.(this.requestInfo.memoryKey, {
              kind: 'operation_preflight_rejection',
              ref: `${this.traceRequest?.id ?? 'request'}/stale_exact_target`,
              summary: JSON.stringify({
                code: 'stale_exact_target',
                operation_index: error.preflight.operation_index,
                operation: error.preflight.operation,
                identity: error.preflight.identity,
                last_observed: error.preflight.last_observed,
              }),
            })
            await this.persistState()
          }
          await this.traceEvent('operations.preflight_recoverable', {
            failure_class: 'stale_exact_target',
            preflight: error.preflight,
            tools_enabled: true,
            retry: this.staleExactPreflightRetries,
          })
          const previous = error.preflight.last_observed
          const location = previous?.position && Number.isFinite(previous.position.x) && Number.isFinite(previous.position.y)
            ? ` The old identity was last observed at absolute position (${previous.position.x}, ${previous.position.y}) as ${previous.name ?? 'an entity'}.`
            : ''
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Exact target unit ${error.preflight.identity ?? 'unknown'} is stale; deterministic preflight rejected it before Autorio admission, so no mutation from that operation ran.${location} A replacement at the same coordinate is a new identity. If the active task semantically means the entity at that location, use walk_to_position for the known coordinate as needed, then make one targeted live observation near the location and bind the current entity's returned unit_number before issuing any exact mutation. Tools remain enabled; do not silently substitute by name or reuse the stale unit_number.`,
          })
          return this.runTurn()
        }
        stateResult = await this.markAdmissionFailure(stateResult, operations, error, 'operation_preflight_rejection')
        await this.traceEvent('operations.preflight_rejected', {
          failure_class: 'deterministic_preflight',
          reason: error instanceof Error ? error.message : String(error),
          preflight: error?.preflight,
          operations,
          task_board: visibleTaskBoard(stateResult?.state?.task_board),
        })
        this.active = false
        await this.traceEvent('request.completed', {
          chat_message: plan.chatMessage,
          outcome: 'blocked_preflight',
          task_board: visibleTaskBoard(stateResult?.state?.task_board),
          usage: this.traceRequest?.usage,
        })
        this.traceRequest = null
        return {
          chatMessage: planProgress(plan, stateResult),
          plan: stateResult?.state?.plan ?? durablePlan.plan,
          currentStep: stateResult?.state?.current_step ?? durablePlan.currentStep,
          operations: [],
          epoch: before.epoch,
          actorId: before.actor_id,
          goalId: stateResult?.state?.goal_id,
          goalStatus: stateResult?.state?.status,
          taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
          blocker: error?.preflight,
        }
      }

      await this.traceEvent('operations.admit', { operations })
      try {
        const acknowledgement = await executeAuthorizedBatch(this.rcon, before.epoch, commands)
        await this.traceEvent('operations.ack', {
          operations: operations.map((operation, index) => ({ ...operation, admission_result: acknowledgement.results[index] })),
        })
        if (this.requestInfo && stateResult?.state) {
          const state = this.memory.setAdmissionState?.(this.requestInfo.memoryKey, 'admitted')
          if (state) stateResult = { ...stateResult, state }
          await this.persistState()
        }
        await this.assertCurrent()
      }
      catch (error) {
        stateResult = await this.markAdmissionFailure(stateResult, operations, error, 'operation_admission_failure')
        const operationIndex = Number.isSafeInteger(error?.operationIndex) ? error.operationIndex : undefined
        await this.traceEvent('operations.admission_failed', {
          failure_class: 'mutation_admission',
          request_id: this.traceRequest?.id,
          operation_index: operationIndex === undefined ? undefined : operationIndex + 1,
          operation: operationIndex !== undefined ? operations[operationIndex] : undefined,
          factorio_error: error?.factorioError,
          no_replay: true,
          no_replay_reason: 'Earlier operations in the admitted batch may already have produced side effects.',
          task_board: visibleTaskBoard(stateResult?.state?.task_board),
        })
        throw error
      }
    }

    if (commands.length === 0) {
      this.active = false
      const outcome = stateResult?.blockedByHarness
        ? 'blocked_no_operation'
        : stateResult?.persistentRuntimeActive
          ? 'persistent_runtime_active'
          : 'no_operations'
      await this.traceEvent('request.completed', {
        chat_message: plan.chatMessage,
        outcome,
        persistent_runtime: persistentRuntime,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
        usage: this.traceRequest?.usage,
      })
      this.traceRequest = null
    }
    else {
      await this.traceEvent('request.waiting', {
        operation_count: commands.length,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
        usage: this.traceRequest?.usage,
      })
    }

    const canonicalPlan = stateResult?.state?.plan ?? durablePlan.plan
    const canonicalStep = stateResult?.state?.current_step ?? durablePlan.currentStep
    this.planUpdateReason = 'continuation'
    return {
      chatMessage: planProgress(plan, stateResult),
      plan: canonicalPlan,
      currentStep: canonicalStep,
      operations: plan.operations,
      epoch: before.epoch,
      actorId: before.actor_id,
      goalId: stateResult?.state?.goal_id,
      goalStatus: stateResult?.state?.status,
      taskBoard: visibleTaskBoard(stateResult?.state?.task_board),
      persistentRuntime: stateResult?.state?.persistent_runtime,
    }
  }

  async recoverPlan(generation, reason, roundBase) {
    const reasonText = reason instanceof Error ? reason.message : String(reason)
    const recovery = {
      reason: reasonText,
      round_base: roundBase,
      attempt: 0,
    }
    if (this.traceRequest) this.traceRequest.recovery = recovery
    await this.traceEvent('replan.started', recovery)

    const observationDecisionComplete = /single targeted observation allowed by decision pressure is complete/i.test(reasonText)
    const currentState = this.memory.currentPlan?.(this.activePlanKey())
    if (observationDecisionComplete) {
      if (!this.actionOmissionRepairActive) {
        if (canonicalWorkRemains(currentState)) {
          await this.beginActionOmissionRepair({
            chatMessage: '',
            plan: currentState.plan,
            currentStep: currentState.current_step,
            operations: [],
          }, 'observation_decision_pressure_complete')
        }
        else {
          this.actionOmissionRepairActive = true
          await this.traceEvent('recovery.action_omission_started', {
            reason_code: 'observation_decision_pressure_without_plan',
            goal_id: undefined,
            active_step: undefined,
            completed_count: 0,
            provider_call_budget: 'one final no-tools act-or-block call',
          })
        }
      }
      this.actionOmissionObservationUsed = true
      this.actionOmissionForceNoTools = true
      this.messages.push({ role: 'user', content: `[HARNESS] ${ACTION_OMISSION_AFTER_OBSERVATION_MESSAGE}` })
      const current = await this.assertCurrent()
      let message
      try {
        message = await this.callProvider(current, generation, {
          round: roundBase,
          allowTools: false,
          recoveryAttempt: 0,
        })
      }
      catch (error) {
        throw error
      }
      let plan
      try {
        plan = this.parsePlanMessage(message)
      }
      catch (error) {
        const fallbackPlan = currentState?.plan?.length
          ? currentState.plan
          : [cleanMemoryText(this.requestInfo?.text ?? 'Unresolved user goal', 500)]
        const fallback = {
          chatMessage: 'Action-omission repair did not produce a valid executable plan.',
          plan: fallbackPlan,
          currentStep: currentState?.current_step ?? 0,
          operations: [],
        }
        return this.finishNoOperationBlock(
          fallback,
          current,
          'action_omission_after_repair',
          `The bounded act-or-block repair was invalid: ${error instanceof Error ? error.message : String(error)}`,
          'action_omission',
        )
      }
      if (plan.operations.length === 0 && plan.plan.length === 0) {
        plan = {
          ...plan,
          chatMessage: plan.chatMessage || 'Action-omission repair ended without an executable action.',
          plan: [cleanMemoryText(this.requestInfo?.text ?? 'Unresolved user goal', 500)],
          currentStep: 0,
        }
      }
      return this.commitPlan(plan)
    }

    if (this.actionOmissionRepairActive) {
      const current = await this.assertCurrent()
      const fallbackState = this.memory.currentPlan?.(this.activePlanKey())
      const fallback = {
        chatMessage: 'Action-omission repair exhausted without a valid executable action.',
        plan: fallbackState?.plan ?? [],
        currentStep: fallbackState?.current_step ?? 0,
        operations: [],
      }
      return this.finishNoOperationBlock(
        fallback,
        current,
        'action_omission_after_repair',
        `The bounded act-or-block repair could not produce a valid final decision: ${reasonText}`,
        'action_omission',
      )
    }

    this.genericRecoveryDecisionActive = true
    try {
      return await super.recoverPlan(generation, reason, roundBase)
    }
    finally {
      this.genericRecoveryDecisionActive = false
    }
  }
}
