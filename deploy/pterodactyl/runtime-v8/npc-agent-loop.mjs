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
import { renderOperation, renderOperationPreflight, toolCommand } from './structured-policy.mjs'

export { AgentLoopError }

const TRACE_MAX_BYTES = 5 * 1024 * 1024
const TRACE_FILES = 5
const SENSITIVE_TRACE_KEY = /(?:authorization|api.?key|token|password|secret|cookie|session)/i
const STATE_SCHEMA = 1
const PLAN_HISTORY_LIMIT = 24
const DUPLICATE_OBSERVATION_MESSAGE = '[HARNESS] Duplicate observation suppressed. The result is unchanged from the earlier identical tool call already present in this decision context; reuse it and act or report a blocker.'
const OUTPUT_BUDGET_RECOVERY_MESSAGE = '[HARNESS] The immediately preceding provider response exhausted its output budget before emitting content or tool calls. Continue the same logical request and goal from this unchanged harness context. Tools remain available. Do not treat the empty response as an action, plan update, completion, or evidence. Do not replay any world mutation already proven complete by the supplied receipts or canonical Task Board. Return the next necessary tool call(s) or one valid strict-JSON plan.'

const DURABLE_PLAN_PROMPT = `
## Durable goal and plan state

The Pterodactyl harness may provide a [PLAN_STATE] message. It is harness-owned durable goal/plan context for this logical NPC and survives ordinary model turns and server restarts. Use it to resume a prior task, answer what you were doing, or continue after a pause. It is not authoritative live Factorio state: re-observe mutable game state before depending on it.

The task_board field is the canonical single-NPC Task Board Lite. Its stable step ids, statuses, completed count, evidence, and revision are harness-owned. Your plan/currentStep fields are proposals used to advance or intentionally replan the remaining work; do not assume that changing the length of your plan array resets completed progress.

For a multi-step request, keep the plan stable enough that the harness can track progress across Autorio batches. currentStep must identify the step you are actually executing or verifying now. If you replan, preserve already-completed intent instead of silently replacing the whole task with a vague new one.

An empty operations array normally means no new Autorio world action will happen after your reply. Never claim that a finite action is continuing when neither a new operation nor a live persistent runtime mode exists. Persistent controllers such as follow are different: if a read-only status tool proves the controller is active, healthy, and live, operations: [] may accurately describe that background mode without submitting a duplicate operation. When the whole requested goal is actually verified complete, return plan: [], currentStep: 0, operations: [], and say it is complete.

Before a non-empty operation batch, chatMessage should tell the human what concrete current plan step AIRI is about to attempt. [MOD] completion/error messages may include a detailed getTaskStatus snapshot. Use that receipt plus any needed read-only verification to advance, replan, complete, or report a blocker.
`.trim()

function cleanMemoryText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
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

  planContext(key) {
    const state = this.planByNpc.get(key)
    if (!state) return ''
    const taskBoard = this.ensureTaskBoard(state)
    const visible = {
      goal_id: state.goal_id,
      owner: state.owner,
      objective: state.objective,
      status: state.status,
      admission_status: state.admission_status,
      blocker: state.blocker,
      pause_reason: state.pause_reason,
      persistent_runtime: state.persistent_runtime,
      task_board: visibleTaskBoard(taskBoard),
      plan: state.plan,
      current_step: state.current_step,
      current_step_text: currentPlanStep(state.plan, state.current_step),
      revision: state.revision,
      last_chat_message: state.last_chat_message,
      last_operations: state.last_operations,
      history: state.history.slice(-8),
    }
    return `[PLAN_STATE] Harness-owned durable goal/plan state. Continue from this state when the human asks to continue/resume, but re-observe mutable Factorio state before acting.\n${JSON.stringify(visible)}`
  }

  context(key) {
    return [super.context(key), this.planContext(key)].filter(Boolean).join('\n')
  }

  currentPlan(key) {
    const state = key ? this.planByNpc.get(key) : undefined
    this.ensureTaskBoard(state)
    return state
  }

  recordPlan(key, requestInfo, plan, { continuation = false, persistentRuntime } = {}) {
    const previous = this.planByNpc.get(key)
    const hasOperations = plan.operations.length > 0
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
        admission_status: ['proposed', 'admitting', 'admitted', 'admission_failed'].includes(value.admission_status) ? value.admission_status : undefined,
        blocker: cleanMemoryText(value.blocker, 500),
        pause_reason: cleanMemoryText(value.pause_reason, 300),
        persistent_runtime: safePersistentRuntime(value.persistent_runtime),
        plan: safePlan(value.plan),
        current_step: Number.isSafeInteger(value.current_step) && value.current_step >= 0 ? value.current_step : 0,
        revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
        last_chat_message: cleanMemoryText(value.last_chat_message, 2000),
        last_operations: (Array.isArray(value.last_operations) ? value.last_operations : []).slice(-16).map(operation => cleanMemoryText(operation, 800)),
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
    this.persistQueue = Promise.resolve()
    this.traceRequest = null
    this.traceRequestSequence = 0
    this.planUpdateReason = 'request'
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.onActivity = typeof options.onActivity === 'function' ? options.onActivity : null
    this.turnSequence = Math.max(this.turnSequence, memory.maxTurnId?.() ?? 0)
    const traceFile = options.traceFile ?? process.env.AIRI_BEHAVIOR_TRACE_FILE
      ?? (process.env.NODE_TEST_CONTEXT ? null : path.resolve(process.cwd(), 'logs', 'airi-behavior.jsonl'))
    this.behaviorTrace = traceFile ? new BehaviorTraceWriter(traceFile, message => this.log(`[trace] ${message}`)) : null
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

  async request(text, options = {}) {
    await this.loadPersistentState()
    this.lastMemoryKey = `npc:${this.npcId}`
    this.planUpdateReason = 'request'
    this.lastTaskStatusView = null
    this.lastHandledRuntimeReceipt = { completion: null, failure: null }
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    if (this.traceRequest) await this.traceEvent('request.superseded', { usage: this.traceRequest.usage })
    this.traceRequest = {
      id: `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`,
      seq: 0,
      usage: emptyUsageSummary(),
    }
    await this.traceEvent('request.received', { sender: options.sender ?? 'unknown', text })
    try {
      const result = await super.request(text, options)
      if (this.requestInfo?.memoryKey) this.lastMemoryKey = this.requestInfo.memoryKey
      return result
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

  traceEvent(event, data = {}) {
    if (this.onActivity) {
      try { this.onActivity(event, data) }
      catch (error) { this.log(`[trace] activity listener failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (!this.behaviorTrace) return Promise.resolve()
    const request = this.traceRequest
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
    this.toolValidationRetries = 0
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    this.messages.push({ role: 'user', content: cleanMemoryText(modMessage, 18000) })
    await this.traceEvent(traceEventName)
    return this.runGuarded()
  }

  async completed() {
    await this.loadPersistentState()
    if (!this.active) return null
    this.planUpdateReason = 'completion'
    await this.traceEvent('factorio.completed_signal')
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
    return this.continueFromModMessage(
      `[MOD] Autorio operation batch completed. Detailed task receipt: ${JSON.stringify(receipt.providerStatus)}`,
      'factorio.completion_continuation',
    )
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
    void this.traceEvent('request.cancelled', { reason, usage: this.traceRequest?.usage })
    this.traceRequest = null
    this.outputBudgetRecoveryUsed = false
    this.outputBudgetRecoveryGuard = null
    return super.cancel()
  }

  async callProvider(current, generation, {
    round,
    allowTools = true,
    recoveryAttempt = 0,
    recoveryKind,
    providerMessagesOverride,
  }) {
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
        ...(recoveryKind ? { kind: recoveryKind } : {}),
      }
    }
    await this.traceEvent('provider.request', {
      round,
      trigger_source: this.planUpdateReason,
      allow_tools: allowTools,
      recovery_attempt: recoveryAttempt,
      recovery_kind: recoveryKind,
      message_count: providerMessages.length,
      message_chars: providerMessages.reduce((total, message) => total + messageChars(message), 0),
    })
    let message
    try {
      message = await this.provider(providerMessages, {
        epoch: current.epoch,
        actorId: current.actor_id,
        round,
        allowTools,
        recoveryAttempt,
        recoveryKind,
        triggerSource: this.planUpdateReason,
        signal: controller.signal,
      })
      const usage = normalizedProviderUsage(message?._airiProvider?.usage)
      accumulateProviderUsage(this.traceRequest?.usage, usage)
      const responseTrace = {
        kind: 'response',
        round,
        trigger_source: this.planUpdateReason,
        recovery_attempt: recoveryAttempt,
        recovery_kind: recoveryKind,
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
        recovery_attempt: recoveryAttempt,
        recovery_kind: recoveryKind,
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

    if (allowTools && recoveryAttempt === 0 && !this.outputBudgetRecoveryUsed && providerOutputBudgetExhausted(message)) {
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
    if (this.outputBudgetRecoveryGuard && freshResultObserved) {
      this.outputBudgetRecoveryGuard.world_evidence_observed = true
      this.outputBudgetRecoveryGuard.fresh_tool_evidence = true
    }
    for (let index = 0; index < results.length; index++) {
      const original = String(results[index].content ?? '')
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
  }

  async recoveryDiagnostic(details) {
    if (this.traceRequest) this.traceRequest.recovery = { ...(this.traceRequest.recovery ?? {}), ...details }
    await this.traceEvent('recovery.classified', details)
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

    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    let stateResult
    let durablePlan = plan
    if (this.requestInfo) {
      this.lastMemoryKey = this.requestInfo.memoryKey
      const previousState = this.memory.currentPlan?.(this.requestInfo.memoryKey)
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
      this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
        sender: this.requestInfo.sender,
        user: this.requestInfo.text,
        assistant: plan.chatMessage,
        operations: plan.operations,
      })
      stateResult = this.memory.recordPlan?.(this.requestInfo.memoryKey, this.requestInfo, durablePlan, {
        continuation: this.continuations > 0,
        persistentRuntime,
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
        await this.traceEvent('operations.preflight_ok', {
          operations: operations.map((operation, index) => ({ ...operation, preflight: preflight[index] })),
        })
      }
      catch (error) {
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
    const recovery = {
      reason: reason instanceof Error ? reason.message : String(reason),
      round_base: roundBase,
      attempt: 0,
    }
    if (this.traceRequest) this.traceRequest.recovery = recovery
    await this.traceEvent('replan.started', recovery)
    return super.recoverPlan(generation, reason, roundBase)
  }
}
