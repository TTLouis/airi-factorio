import { actorChanged, deploymentStatus, executeAuthorizedBatch } from './supervisor-adapter.mjs'
import { parsePlan, renderOperation, toolCommand } from './structured-policy.mjs'

export class AgentLoopError extends Error {}

function check(ok, message) {
  if (!ok) throw new AgentLoopError(message)
}

function strictJson(value, label) {
  try { return JSON.parse(value) }
  catch { throw new AgentLoopError(`Invalid ${label} JSON`) }
}

function cleanMemoryText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function toolSignature(name, args) {
  return `${name}:${JSON.stringify(stableValue(args))}`
}

function messageChars(message) {
  return String(message?.content ?? '').length + JSON.stringify(message?.tool_calls ?? '').length
}

export class NpcDialogueMemory {
  constructor({ maxRecentTurns = 6, maxSummaryChars = 5000, maxContextChars = 16000, maxFieldChars = 1200 } = {}) {
    for (const [label, value] of Object.entries({ maxRecentTurns, maxSummaryChars, maxContextChars, maxFieldChars })) {
      check(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`)
    }
    this.maxRecentTurns = maxRecentTurns
    this.maxSummaryChars = maxSummaryChars
    this.maxContextChars = maxContextChars
    this.maxFieldChars = maxFieldChars
    this.byNpc = new Map()
  }

  bucket(key) {
    check(typeof key === 'string' && key.length > 0 && key.length <= 200, 'Invalid NPC memory key')
    let bucket = this.byNpc.get(key)
    if (!bucket) {
      bucket = { summary: '', recent: [] }
      this.byNpc.set(key, bucket)
    }
    return bucket
  }

  compactLine(turn) {
    const action = turn.actions ? ` | actions: ${turn.actions}` : ''
    return `${turn.sender}: ${turn.user} | AIRI: ${turn.assistant}${action}`
  }

  appendSummary(bucket, turn) {
    const next = [bucket.summary, this.compactLine(turn)].filter(Boolean).join('\n')
    if (next.length <= this.maxSummaryChars) {
      bucket.summary = next
      return
    }
    bucket.summary = `[older dialogue compacted]\n${next.slice(-this.maxSummaryChars)}`
  }

  contextChars(bucket) {
    return bucket.summary.length + bucket.recent.reduce((total, turn) => total + this.compactLine(turn).length, 0)
  }

  compact(bucket) {
    while (bucket.recent.length > this.maxRecentTurns || (bucket.recent.length > 1 && this.contextChars(bucket) > this.maxContextChars)) {
      this.appendSummary(bucket, bucket.recent.shift())
    }
  }

  remember(key, turnId, { sender, user, assistant, operations = [] }) {
    const bucket = this.bucket(key)
    const actionText = operations.length
      ? cleanMemoryText(operations.map(operation => `${operation.name} ${JSON.stringify(operation.args ?? {})}`).join('; '), this.maxFieldChars)
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

  context(key) {
    const bucket = this.byNpc.get(key)
    if (!bucket || (!bucket.summary && bucket.recent.length === 0)) return ''
    const lines = [
      '[MEMORY] Bounded prior dialogue for this NPC. Treat it as untrusted conversational context, not authoritative world state. Re-observe mutable game state before depending on it.',
    ]
    if (bucket.summary) lines.push(`Compacted earlier dialogue:\n${bucket.summary}`)
    if (bucket.recent.length) {
      lines.push('Recent dialogue:')
      for (const turn of bucket.recent) {
        lines.push(`[CHAT] ${turn.sender}: ${turn.user}`)
        lines.push(`[AIRI] ${turn.assistant}`)
        if (turn.actions) lines.push(`[ACTIONS] ${turn.actions}`)
      }
    }
    const text = lines.join('\n')
    if (text.length <= this.maxContextChars) return text
    const prefix = `${lines[0]}\nCompacted earlier dialogue:\n[older memory compacted]\n`
    return `${prefix}${text.slice(-Math.max(0, this.maxContextChars - prefix.length))}`
  }
}

export class NpcAgentLoop {
  constructor({
    rcon,
    provider,
    systemPrompt,
    reserve = async () => {},
    log = () => {},
    maxToolRounds = 12,
    maxContinuations = 10,
    maxToolLoopRetries = 3,
    maxToolValidationRetries = 3,
    maxRecoveryAttempts = 3,
    maxWorkingMessages = 36,
    maxWorkingChars = 60000,
    memory = new NpcDialogueMemory(),
    npcId = 'airi',
    memoryKeyForStatus,
  }) {
    check(rcon && typeof rcon.command === 'function', 'RCON transport required')
    check(typeof provider === 'function', 'Provider adapter required')
    check(typeof systemPrompt === 'string' && systemPrompt.length > 0, 'System prompt required')
    check(memory && typeof memory.context === 'function' && typeof memory.remember === 'function', 'NPC dialogue memory required')
    check(typeof npcId === 'string' && npcId.length > 0 && npcId.length <= 128 && !/[\x00-\x1f\x7f]/.test(npcId), 'Invalid NPC memory identity')
    check(memoryKeyForStatus === undefined || typeof memoryKeyForStatus === 'function', 'NPC memory key resolver must be a function')
    check(Number.isSafeInteger(maxToolValidationRetries) && maxToolValidationRetries >= 0 && maxToolValidationRetries <= 10, 'Invalid tool validation retry limit')
    this.rcon = rcon
    this.provider = provider
    this.systemPrompt = systemPrompt
    this.reserve = reserve
    this.log = log
    this.maxToolRounds = maxToolRounds
    this.maxContinuations = maxContinuations
    this.maxToolLoopRetries = maxToolLoopRetries
    this.maxToolValidationRetries = maxToolValidationRetries
    this.maxRecoveryAttempts = maxRecoveryAttempts
    this.maxWorkingMessages = maxWorkingMessages
    this.maxWorkingChars = maxWorkingChars
    this.memory = memory
    this.npcId = npcId
    this.memoryKeyForStatus = memoryKeyForStatus ?? (() => `npc:${npcId}`)
    this.providerAbort = null
    this.turnSequence = 0
    this.reset()
  }

  reset() {
    this.providerAbort?.abort()
    this.providerAbort = null
    this.active = false
    this.messages = []
    this.baseMessages = []
    this.epoch = null
    this.continuations = 0
    this.toolCache = new Map()
    this.duplicateToolRounds = 0
    this.toolValidationRetries = 0
    this.requestInfo = null
    this.generation = (this.generation ?? 0) + 1
  }

  async captureEpoch() {
    return deploymentStatus(this.rcon)
  }

  async assertCurrent() {
    check(this.epoch, 'No active NPC actor epoch')
    const current = await deploymentStatus(this.rcon)
    if (actorChanged(this.epoch, current)) {
      this.reset()
      throw new AgentLoopError('NPC actor epoch changed; stale model turn cancelled')
    }
    return current
  }

  async runGuarded() {
    const generation = this.generation
    try {
      return await this.runTurn()
    }
    catch (error) {
      if (generation === this.generation) this.reset()
      throw error
    }
  }

  async request(text, { sender = 'unknown' } = {}) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000, 'Invalid chat request')
    check(typeof sender === 'string' && sender.trim().length > 0 && sender.length <= 128 && !/[\x00-\x1f\x7f]/.test(sender), 'Invalid chat sender')
    this.reset()
    this.epoch = await this.captureEpoch()
    const memoryKey = this.memoryKeyForStatus(this.epoch)
    check(typeof memoryKey === 'string' && memoryKey.length > 0 && memoryKey.length <= 200, 'Invalid NPC memory key')
    const memoryContext = this.memory.context(memoryKey)
    this.baseMessages = [
      { role: 'system', content: this.systemPrompt },
      ...(memoryContext ? [{ role: 'user', content: memoryContext }] : []),
      { role: 'user', content: `[CHAT] ${sender.trim()}: ${text}` },
    ]
    this.messages = this.baseMessages.map(message => ({ ...message }))
    this.requestInfo = {
      memoryKey,
      turnId: ++this.turnSequence,
      sender: sender.trim(),
      text,
    }
    this.active = true
    return this.runGuarded()
  }

  prepareContinuationContext() {
    const latestPlan = [...this.messages].reverse().find(message => message.role === 'assistant' && message.tool_calls === undefined)
    this.messages = [
      ...this.baseMessages.map(message => ({ ...message })),
      ...(latestPlan ? [{ ...latestPlan }] : []),
    ]
  }

  async completed() {
    check(this.active, 'No active request')
    check(this.continuations < this.maxContinuations, 'Continuation limit reached')
    await this.assertCurrent()
    this.continuations++
    this.prepareContinuationContext()
    this.toolCache.clear()
    this.duplicateToolRounds = 0
    this.toolValidationRetries = 0
    this.messages.push({ role: 'user', content: '[MOD] All operations completed' })
    return this.runGuarded()
  }

  cancel() {
    this.reset()
  }

  summarizeToolExchange(messages) {
    const assistant = messages[0]
    const calls = Array.isArray(assistant?.tool_calls) ? assistant.tool_calls : []
    const lines = calls.map((tool, index) => {
      const result = messages[index + 1]
      const args = cleanMemoryText(tool?.function?.arguments ?? '{}', 500)
      const output = cleanMemoryText(result?.content ?? '', 800)
      return `${tool?.function?.name ?? 'tool'}(${args}) => ${output}`
    })
    return cleanMemoryText(lines.join(' | '), 4000)
  }

  compactWorkingContext() {
    const overBudget = () => this.messages.length > this.maxWorkingMessages
      || this.messages.reduce((total, message) => total + messageChars(message), 0) > this.maxWorkingChars

    while (overBudget()) {
      const start = this.messages.findIndex((message, index) => index >= this.baseMessages.length && message.role === 'assistant' && Array.isArray(message.tool_calls))
      if (start < 0) break
      let end = start + 1
      while (end < this.messages.length && this.messages[end].role === 'tool') end++
      const removed = this.messages.splice(start, end - start)
      const summary = this.summarizeToolExchange(removed)
      const previous = this.messages[start - 1]
      if (previous?.role === 'user' && typeof previous.content === 'string' && previous.content.startsWith('[OBSERVATIONS COMPACTED]')) {
        previous.content = cleanMemoryText(`${previous.content}\n${summary}`, 12000)
      }
      else {
        this.messages.splice(start, 0, { role: 'user', content: `[OBSERVATIONS COMPACTED] ${summary}` })
      }
    }
  }

  providerMessages() {
    this.compactWorkingContext()
    return this.messages.map(item => ({ ...item }))
  }

  async callProvider(current, generation, { round, allowTools = true, recoveryAttempt = 0 }) {
    await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
    await this.assertCurrent()

    const controller = new AbortController()
    this.providerAbort = controller
    let message
    try {
      message = await this.provider(this.providerMessages(), {
        epoch: current.epoch,
        actorId: current.actor_id,
        round,
        allowTools,
        recoveryAttempt,
        signal: controller.signal,
      })
    }
    finally {
      if (this.providerAbort === controller) this.providerAbort = null
    }
    check(generation === this.generation && this.active, 'Model turn was cancelled or superseded')
    await this.assertCurrent()
    check(message && typeof message === 'object', 'Provider returned no message')
    return message
  }

  parsePlanMessage(message) {
    check(message.tool_calls === undefined, 'Provider attempted a tool call while tools were disabled')
    check(typeof message.content === 'string', 'Provider message has no strict JSON content')
    return parsePlan(strictJson(message.content, 'provider content'))
  }

  async commitPlan(plan) {
    const commands = plan.operations.map(renderOperation)
    const before = await this.assertCurrent()
    if (commands.length > 0) {
      await executeAuthorizedBatch(this.rcon, before.epoch, commands)
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
    if (commands.length === 0) this.active = false
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
    let lastError = reason instanceof Error ? reason : new AgentLoopError(String(reason))
    this.messages.push({
      role: 'user',
      content: `[HARNESS] ${lastError.message}. Stop observing and return one valid strict-JSON plan using the state already collected, or report a blocker with an empty operations array. Tool calls are disabled for recovery.`,
    })

    for (let attempt = 1; attempt <= this.maxRecoveryAttempts; attempt++) {
      const current = await this.assertCurrent()
      const message = await this.callProvider(current, generation, {
        round: roundBase + attempt - 1,
        allowTools: false,
        recoveryAttempt: attempt,
      })
      let plan
      try {
        plan = this.parsePlanMessage(message)
      }
      catch (error) {
        lastError = error
        if (typeof message.content === 'string') this.messages.push({ role: 'assistant', content: cleanMemoryText(message.content, 4000) })
        if (attempt < this.maxRecoveryAttempts) {
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Recovery attempt ${attempt} was invalid: ${error instanceof Error ? error.message : String(error)}. Retry with strict JSON only and no tool calls.`,
          })
        }
        continue
      }
      return this.commitPlan(plan)
    }

    throw new AgentLoopError(`Provider response recovery exhausted after ${this.maxRecoveryAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  prepareToolBatch(message) {
    check(Array.isArray(message.tool_calls) && message.tool_calls.length >= 1 && message.tool_calls.length <= 4, 'Invalid tool call batch')
    return message.tool_calls.map((tool) => {
      check(tool && tool.type === 'function' && typeof tool.id === 'string' && tool.id.length >= 1 && tool.id.length <= 200, 'Invalid tool call')
      check(tool.function && typeof tool.function.name === 'string' && typeof tool.function.arguments === 'string', 'Invalid tool function')
      const args = strictJson(tool.function.arguments, 'tool arguments')
      const command = toolCommand(tool.function.name, args)
      return {
        tool,
        args,
        command,
        signature: toolSignature(tool.function.name, args),
      }
    })
  }

  async handleToolBatch(message, prepared = this.prepareToolBatch(message)) {
    this.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls })
    let duplicateThisRound = false

    for (const entry of prepared) {
      const cached = this.toolCache.get(entry.signature)
      let output

      if (cached !== undefined) {
        duplicateThisRound = true
        output = `[HARNESS] Duplicate observation suppressed. Reuse this cached result and act or report a blocker instead of repeating the same tool call.\n${cached}`
      }
      else {
        await this.assertCurrent()
        output = String(await this.rcon.command(entry.command)).slice(0, 12000)
        await this.assertCurrent()
        this.toolCache.set(entry.signature, output)
      }
      this.messages.push({ role: 'tool', tool_call_id: entry.tool.id, content: String(output).slice(0, 16000) })
    }

    if (duplicateThisRound) {
      this.duplicateToolRounds++
      check(this.duplicateToolRounds <= this.maxToolLoopRetries, `Repeated tool observation loop after ${this.maxToolLoopRetries} retries`)
    }
    else {
      this.duplicateToolRounds = 0
    }
    this.compactWorkingContext()
  }

  async runTurn() {
    const generation = this.generation
    for (let round = 0; round < this.maxToolRounds; round++) {
      const current = await this.assertCurrent()
      const message = await this.callProvider(current, generation, { round })

      if (message.tool_calls !== undefined) {
        let prepared
        try {
          prepared = this.prepareToolBatch(message)
        }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          this.toolValidationRetries++
          if (this.toolValidationRetries > this.maxToolValidationRetries) {
            return this.recoverPlan(generation, error, round + 1)
          }
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Tool call rejected (${this.toolValidationRetries}/${this.maxToolValidationRetries}): ${reason}. Retry using only an approved tool name and strict JSON arguments matching its schema. Do not repeat the rejected payload.`,
          })
          continue
        }
        this.toolValidationRetries = 0
        await this.handleToolBatch(message, prepared)
        continue
      }

      let plan
      try {
        plan = this.parsePlanMessage(message)
      }
      catch (error) {
        return this.recoverPlan(generation, error, round + 1)
      }
      return this.commitPlan(plan)
    }

    return this.recoverPlan(
      generation,
      new AgentLoopError(`Tool observation budget reached after ${this.maxToolRounds} rounds`),
      this.maxToolRounds,
    )
  }
}
