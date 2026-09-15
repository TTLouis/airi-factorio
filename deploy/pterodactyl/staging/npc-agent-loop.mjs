import { actorChanged, deploymentStatus, executeAuthorizedBatch } from './supervisor-adapter.mjs'
import { luaString, parsePlan, renderOperation, toolCommand } from './structured-policy.mjs'

export class AgentLoopError extends Error {}

function check(ok, message) {
  if (!ok) throw new AgentLoopError(message)
}

function strictJson(value, label) {
  try { return JSON.parse(value) }
  catch { throw new AgentLoopError(`Invalid ${label} JSON`) }
}

export function navigationObstaclePolicy(text) {
  const normalized = String(text ?? '').trim().toLocaleLowerCase()
  const denyPhrases = [
    '不要自动清障', '不要清障', '别清障', '不要砍树', '别砍树', '不要自动砍树', '不要挖树',
    '不要挖石头', '别挖石头', '不要挖岩石', '不要破坏树', '不要破坏树木',
    "don't clear obstacles", 'do not clear obstacles', 'no automatic obstacle clearing',
    "don't cut trees", 'do not cut trees', "don't mine rocks", 'do not mine rocks',
    'preserve trees', 'leave the trees alone',
  ]
  if (denyPhrases.some(phrase => normalized.includes(phrase))) {
    return { shouldUpdate: true, clearObstacles: false }
  }
  const continuation = ['continue', 'resume', '继续', '继续吧', '继续做', '接着', '接着做']
    .some(prefix => normalized === prefix || normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}，`) || normalized.startsWith(`${prefix},`))
  if (continuation) return { shouldUpdate: false, clearObstacles: true }
  return { shouldUpdate: true, clearObstacles: true }
}

export function liveTaskBoardSnapshot(objective, plan, { completed = false } = {}) {
  const descriptions = Array.isArray(plan?.plan) ? plan.plan.map(value => String(value)).filter(Boolean).slice(0, 30) : []
  const current = descriptions.length === 0
    ? 0
    : Math.min(Math.max(Number.isSafeInteger(plan?.currentStep) ? plan.currentStep : 0, 0), descriptions.length - 1)
  const steps = descriptions.map((description, index) => ({
    id: `step_${index + 1}`,
    description,
    status: completed || index < current ? 'completed' : index === current ? 'active' : 'pending',
  }))
  return {
    goal_id: 'live_plan',
    objective: String(objective ?? '').slice(0, 500),
    status: completed ? 'completed' : 'active',
    blocker: '',
    pause_reason: '',
    completed_count: completed ? steps.length : current,
    total_steps: steps.length,
    active_index: current,
    steps,
  }
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
    this.clearObstacles = true
    this.objective = ''
    this.reset()
  }

  reset() {
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

  async clearTaskBoardUi() {
    try {
      await this.rcon.command('/silent-command remote.call("autorio_task_board","clear")')
    }
    catch (error) {
      this.log(`Task Board UI clear failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  async syncTaskBoardUi(snapshot) {
    try {
      const json = JSON.stringify(snapshot)
      await this.rcon.command(`/silent-command remote.call("autorio_task_board","set_snapshot",helpers.json_to_table(${luaString(json)}))`)
      return true
    }
    catch (error) {
      this.log(`Task Board UI sync failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  async applyNavigationObstaclePolicy(text) {
    const policy = navigationObstaclePolicy(text)
    if (!policy.shouldUpdate) return this.clearObstacles
    this.clearObstacles = policy.clearObstacles
    try {
      await this.rcon.command(`/silent-command remote.call("autorio_navigation","set_clear_obstacles",${this.clearObstacles ? 'true' : 'false'})`)
    }
    catch (error) {
      this.log(`Navigation obstacle policy update failed: ${error instanceof Error ? error.message : error}`)
    }
    return this.clearObstacles
  }

  async assertCurrent() {
    check(this.epoch, 'No active NPC actor epoch')
    const current = await deploymentStatus(this.rcon)
    if (actorChanged(this.epoch, current)) {
      await this.clearTaskBoardUi()
      this.reset()
      throw new AgentLoopError('NPC actor epoch changed; stale model turn cancelled')
    }
    return current
  }

  async request(text) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000, 'Invalid chat request')
    this.reset()
    this.objective = text.trim()
    this.epoch = await this.captureEpoch()
    await this.clearTaskBoardUi()
    await this.applyNavigationObstaclePolicy(text)
    this.messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: `[CHAT] ${text}` },
    ]
    this.active = true
    return this.runTurn()
  }

  async completed() {
    check(this.active, 'No active request')
    check(this.continuations < this.maxContinuations, 'Continuation limit reached')
    await this.assertCurrent()
    this.continuations++
    this.messages.push({ role: 'user', content: '[MOD] All operations completed' })
    return this.runTurn()
  }

  cancel() {
    this.clearTaskBoardUi().catch(() => {})
    this.reset()
  }

  async runTurn() {
    const generation = this.generation
    for (let round = 0; round < this.maxToolRounds; round++) {
      const current = await this.assertCurrent()
      await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
      await this.assertCurrent()

      const message = await this.provider(this.messages.map(item => ({ ...item })), {
        epoch: current.epoch,
        actorId: current.actor_id,
        round,
      })
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
      const commands = plan.operations.map(renderOperation)
      const before = await this.assertCurrent()
      if (commands.length > 0) {
        await executeAuthorizedBatch(this.rcon, before.epoch, commands)
        await this.assertCurrent()
      }

      this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
      const completed = commands.length === 0
      await this.syncTaskBoardUi(liveTaskBoardSnapshot(this.objective, plan, { completed }))
      if (completed) this.active = false
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
