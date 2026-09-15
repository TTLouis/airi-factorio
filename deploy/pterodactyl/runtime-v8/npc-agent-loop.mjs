import fsp from 'node:fs/promises'
import path from 'node:path'

import { AgentLoopError, NpcAgentLoop as BaseNpcAgentLoop, NpcDialogueMemory } from '../staging/npc-agent-loop.mjs'
import { executeAuthorizedBatch } from './supervisor-adapter.mjs'
import { renderOperation, toolCommand } from './structured-policy.mjs'

export { AgentLoopError, NpcDialogueMemory }

const TRACE_MAX_BYTES = 5 * 1024 * 1024
const TRACE_FILES = 5
const SENSITIVE_TRACE_KEY = /(?:authorization|api.?key|token|password|secret|cookie|session)/i

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

export class NpcAgentLoop extends BaseNpcAgentLoop {
  constructor(options) {
    super(options)
    const traceFile = options.traceFile ?? process.env.AIRI_BEHAVIOR_TRACE_FILE
      ?? (process.env.NODE_TEST_CONTEXT ? null : path.resolve(process.cwd(), 'logs', 'airi-behavior.jsonl'))
    this.behaviorTrace = traceFile ? new BehaviorTraceWriter(traceFile, message => this.log(`[trace] ${message}`)) : null
    this.traceRequest = null
    this.traceRequestSequence = 0
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

  async request(text, options = {}) {
    if (this.traceRequest) await this.traceEvent('request.superseded')
    this.traceRequest = {
      id: `req_${Date.now().toString(36)}_${(++this.traceRequestSequence).toString(36)}`,
      seq: 0,
    }
    await this.traceEvent('request.received', { sender: options.sender ?? 'unknown', text })
    try {
      return await super.request(text, options)
    }
    catch (error) {
      if (this.traceRequest) {
        await this.traceEvent('request.failed', { stage: 'bind', message: error instanceof Error ? error.message : String(error) })
        this.traceRequest = null
      }
      throw error
    }
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

  async completed() {
    await this.traceEvent('factorio.completed_signal')
    try {
      const taskStatus = String(await this.rcon.command(toolCommand('getTaskStatus', {}))).slice(0, 16000)
      await this.traceEvent('factorio.status', { task_status: taskStatus })
    }
    catch (error) {
      await this.traceEvent('factorio.status_error', { message: error instanceof Error ? error.message : String(error) })
    }
    return super.completed()
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

    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    if (this.requestInfo) {
      this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
        sender: this.requestInfo.sender,
        user: this.requestInfo.text,
        assistant: plan.chatMessage,
        operations: plan.operations,
      })
    }
    if (commands.length === 0) {
      this.active = false
      await this.traceEvent('request.completed', { chat_message: plan.chatMessage, outcome: 'no_operations' })
      this.traceRequest = null
    }
    else {
      await this.traceEvent('request.waiting', { operation_count: commands.length })
    }
    return {
      chatMessage: plan.chatMessage,
      plan: plan.plan,
      currentStep: plan.currentStep,
      operations: plan.operations,
      epoch: before.epoch,
      actorId: before.actor_id,
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
