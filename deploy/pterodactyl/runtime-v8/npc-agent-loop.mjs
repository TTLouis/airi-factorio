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
import { renderOperation, toolCommand } from './structured-policy.mjs'

export { AgentLoopError }

const TRACE_MAX_BYTES = 5 * 1024 * 1024
const TRACE_FILES = 5
const SENSITIVE_TRACE_KEY = /(?:authorization|api.?key|token|password|secret|cookie|session)/i
const STATE_SCHEMA = 1
const PLAN_HISTORY_LIMIT = 24

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
        blocker: '',
        pause_reason: '',
        persistent_runtime: previous?.persistent_runtime,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: (previous?.revision ?? 0) + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: plan.operations.slice(0, 16).map(operation => cleanMemoryText(`${operation.name} ${JSON.stringify(operation.args ?? {})}`, 800)),
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
      const state = {
        ...previous,
        status: 'blocked',
        blocker: 'no_autorio_operation_for_remaining_plan',
        pause_reason: '',
        persistent_runtime: runtime,
        plan: incomingPlan,
        current_step: incomingStep,
        revision: previous.revision + 1,
        last_chat_message: cleanMemoryText(plan.chatMessage, 2000),
        last_operations: [],
        updated_at: now,
        history,
      }
      this.planByNpc.set(key, state)
      return { state, blockedByHarness: true, changed: true }
    }

    const state = {
      ...previous,
      status: 'completed',
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
        blocker: cleanMemoryText(value.blocker, 500),
        pause_reason: cleanMemoryText(value.pause_reason, 300),
        persistent_runtime: safePersistentRuntime(value.persistent_runtime),
        plan: safePlan(value.plan),
        current_step: Number.isSafeInteger(value.current_step) && value.current_step >= 0 ? value.current_step : 0,
        revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
        last_chat_message: cleanMemoryText(value.last_chat_message, 2000),
        last_operations: (Array.isArray(value.last_operations) ? value.last_operations : []).slice(-16).map(operation => cleanMemoryText(operation, 800)),
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

  async request(text, options = {}) {
    await this.loadPersistentState()
    this.lastMemoryKey = `npc:${this.npcId}`
    this.planUpdateReason = 'request'
    if (this.traceRequest) await this.traceEvent('request.superseded')
    this.traceRequest = {
      id: `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`,
      seq: 0,
    }
    await this.traceEvent('request.received', { sender: options.sender ?? 'unknown', text })
    try {
      const result = await super.request(text, options)
      if (this.requestInfo?.memoryKey) this.lastMemoryKey = this.requestInfo.memoryKey
      return result
    }
    catch (error) {
      if (this.traceRequest) {
        await this.traceEvent('request.failed', { stage: 'bind', message: error instanceof Error ? error.message : String(error) })
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
        await this.traceEvent('request.failed', { stage: 'runtime', message: error instanceof Error ? error.message : String(error) })
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
      const taskStatus = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 16000)
      await this.traceEvent('factorio.status', { task_status: taskStatus })
      const evidence = receiptEvidence(taskStatus, this.planUpdateReason === 'failure' ? 'failed' : 'completed')
      if (this.memory.recordBoardEvidence?.(this.activePlanKey(), evidence)) await this.persistState()
      return taskStatus
    }
    catch (error) {
      await this.traceEvent('factorio.status_error', { message: error instanceof Error ? error.message : String(error) })
      return JSON.stringify({ status_error: error instanceof Error ? error.message : String(error) })
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
    this.messages.push({ role: 'user', content: cleanMemoryText(modMessage, 18000) })
    await this.traceEvent(traceEventName)
    return this.runGuarded()
  }

  async completed() {
    await this.loadPersistentState()
    this.planUpdateReason = 'completion'
    await this.traceEvent('factorio.completed_signal')
    const taskStatus = await this.taskStatusReceipt()
    return this.continueFromModMessage(
      `[MOD] Autorio operation batch completed. Detailed task receipt: ${taskStatus}`,
      'factorio.completion_continuation',
    )
  }

  async failed(errorText) {
    await this.loadPersistentState()
    if (!this.active) return null
    this.planUpdateReason = 'failure'
    const taskStatus = await this.taskStatusReceipt()
    return this.continueFromModMessage(
      `[MOD] Autorio operation error: ${cleanMemoryText(errorText, 4000)}. Dependent queued operations may have been cancelled. Detailed task receipt: ${taskStatus}`,
      'factorio.error_continuation',
    )
  }

  cancel(reason = 'cancelled') {
    void this.traceEvent('request.cancelled', { reason })
    this.traceRequest = null
    return super.cancel()
  }

  async callProvider(current, generation, { round, allowTools = true, recoveryAttempt = 0 }) {
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
    const providerMessages = this.providerMessages()
    const startedAt = Date.now()
    await this.traceEvent('provider.request', {
      round,
      allow_tools: allowTools,
      recovery_attempt: recoveryAttempt,
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
        signal: controller.signal,
      })
      await this.traceEvent('provider.response', {
        round,
        latency_ms: Date.now() - startedAt,
        has_tool_calls: message?.tool_calls !== undefined,
        content_chars: typeof message?.content === 'string' ? message.content.length : 0,
        provider: message?._airiProvider,
      })
    }
    catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      await this.traceEvent('provider.error', {
        round,
        latency_ms: Date.now() - startedAt,
        message: messageText,
        timeout: /timed out/i.test(messageText),
        cancelled: /cancelled/i.test(messageText),
      })
      throw error
    }
    finally {
      if (this.providerAbort === controller) this.providerAbort = null
    }
    if (generation !== this.generation || !this.active) throw new AgentLoopError('Model turn was cancelled or superseded')
    await this.assertCurrent()
    if (!message || typeof message !== 'object') throw new AgentLoopError('Provider returned no message')
    return message
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
    for (const entry of prepared) {
      await this.traceEvent('tool.call', {
        tool_call_id: entry.tool.id,
        name: entry.tool.function.name,
        args: entry.args,
        cached: this.toolCache.has(entry.signature),
      })
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
    for (let index = 0; index < results.length; index++) {
      await this.traceEvent('tool.result', {
        tool_call_id: prepared[index]?.tool.id,
        name: prepared[index]?.tool.function.name,
        output: results[index].content,
      })
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
      chat_message: plan.chatMessage,
      plan: plan.plan,
      current_step: plan.currentStep,
      operations,
    })

    const before = await this.assertCurrent()
    if (commands.length > 0) {
      await this.traceEvent('operations.admit', { operations })
      const acknowledgement = await executeAuthorizedBatch(this.rcon, before.epoch, commands)
      await this.traceEvent('operations.ack', {
        operations: operations.map((operation, index) => ({ ...operation, admission_result: acknowledgement.results[index] })),
      })
      await this.assertCurrent()
    }

    const persistentRuntime = commands.length === 0 && plan.plan.length > 0
      ? await this.persistentRuntimeStatus()
      : undefined

    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    let stateResult
    if (this.requestInfo) {
      this.lastMemoryKey = this.requestInfo.memoryKey
      const previousState = this.memory.currentPlan?.(this.requestInfo.memoryKey)
      const previousBoard = previousState?.task_board
      this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
        sender: this.requestInfo.sender,
        user: this.requestInfo.text,
        assistant: plan.chatMessage,
        operations: plan.operations,
      })
      stateResult = this.memory.recordPlan?.(this.requestInfo.memoryKey, this.requestInfo, plan, {
        continuation: this.continuations > 0,
        persistentRuntime,
      })
      stateResult = this.memory.reconcileTaskBoard?.(this.requestInfo.memoryKey, previousBoard, plan, stateResult, {
        allowReplan: this.planUpdateReason === 'failure',
      }) ?? stateResult
      await this.persistState()
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
      })
      this.traceRequest = null
    }
    else {
      await this.traceEvent('request.waiting', {
        operation_count: commands.length,
        task_board: visibleTaskBoard(stateResult?.state?.task_board),
      })
    }

    const canonicalPlan = stateResult?.state?.plan ?? plan.plan
    const canonicalStep = stateResult?.state?.current_step ?? plan.currentStep
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
    await this.traceEvent('replan.started', {
      reason: reason instanceof Error ? reason.message : String(reason),
      round_base: roundBase,
    })
    return super.recoverPlan(generation, reason, roundBase)
  }
}
