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

export class NpcAgentLoop {
  constructor({ rcon, provider, systemPrompt, reserve = async () => {}, log = () => {}, maxToolRounds = 6, maxContinuations = 10 }) {
    check(rcon && typeof rcon.command === 'function', 'RCON transport required')
    check(typeof provider === 'function', 'Provider adapter required')
    check(typeof systemPrompt === 'string' && systemPrompt.length > 0, 'System prompt required')
    this.rcon = rcon
    this.provider = provider
    this.systemPrompt = systemPrompt
    this.reserve = reserve
    this.log = log
    this.maxToolRounds = maxToolRounds
    this.maxContinuations = maxContinuations
    this.providerAbort = null
    this.reset()
  }

  reset() {
    this.providerAbort?.abort()
    this.providerAbort = null
    this.active = false
    this.messages = []
    this.epoch = null
    this.continuations = 0
    this.generation = (this.generation ?? 0) + 1
  }

  async captureEpoch() {
    const status = await deploymentStatus(this.rcon)
    return status
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

  async request(text) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000, 'Invalid chat request')
    this.reset()
    this.epoch = await this.captureEpoch()
    this.messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: `[CHAT] ${text}` },
    ]
    this.active = true
    return this.runGuarded()
  }

  async completed() {
    check(this.active, 'No active request')
    check(this.continuations < this.maxContinuations, 'Continuation limit reached')
    await this.assertCurrent()
    this.continuations++
    this.messages.push({ role: 'user', content: '[MOD] All operations completed' })
    return this.runGuarded()
  }

  cancel() {
    this.reset()
  }

  async runTurn() {
    const generation = this.generation
    for (let round = 0; round < this.maxToolRounds; round++) {
      const current = await this.assertCurrent()
      await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
      await this.assertCurrent()

      const controller = new AbortController()
      this.providerAbort = controller
      let message
      try {
        message = await this.provider(this.messages.map(item => ({ ...item })), {
          epoch: current.epoch,
          actorId: current.actor_id,
          round,
          signal: controller.signal,
        })
      }
      finally {
        if (this.providerAbort === controller) this.providerAbort = null
      }
      check(generation === this.generation && this.active, 'Model turn was cancelled or superseded')
      await this.assertCurrent()
      check(message && typeof message === 'object', 'Provider returned no message')

      if (message.tool_calls !== undefined) {
        check(Array.isArray(message.tool_calls) && message.tool_calls.length >= 1 && message.tool_calls.length <= 4, 'Invalid tool call batch')
        this.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls })
        for (const tool of message.tool_calls) {
          check(tool && tool.type === 'function' && typeof tool.id === 'string' && tool.id.length >= 1 && tool.id.length <= 200, 'Invalid tool call')
          check(tool.function && typeof tool.function.name === 'string' && typeof tool.function.arguments === 'string', 'Invalid tool function')
          const args = strictJson(tool.function.arguments, 'tool arguments')
          const command = toolCommand(tool.function.name, args)
          await this.assertCurrent()
          const output = await this.rcon.command(command)
          await this.assertCurrent()
          this.messages.push({ role: 'tool', tool_call_id: tool.id, content: String(output).slice(0, 16000) })
        }
        continue
      }

      check(typeof message.content === 'string', 'Provider message has no strict JSON content')
      const plan = parsePlan(strictJson(message.content, 'provider content'))
      // Render and validate every operation before the first world mutation.
      // The full dependency batch is then admitted in one RCON/Lua command so
      // Factorio cannot advance a simulation tick between operation N and N+1.
      const commands = plan.operations.map(renderOperation)
      const before = await this.assertCurrent()
      if (commands.length > 0) {
        await executeAuthorizedBatch(this.rcon, before.epoch, commands)
        // Death/recovery or a mode transition after admission invalidates the
        // continuation, while Autorio's actor-bound task ownership handles the
        // already-admitted batch safely inside the game.
        await this.assertCurrent()
      }

      this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
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

    this.reset()
    throw new AgentLoopError('Tool round limit reached')
  }
}
