import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop, interactionRuntimeHealthy, parseInteractionRoute } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function activePlan() {
  return {
    goal_id: 'goal_existing',
    owner: 'tester',
    objective: 'build a continuous early iron production line',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['clear the area', 'place production'],
    current_step: 1,
    revision: 1,
    last_chat_message: 'Building.',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_existing',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 1,
      total_steps: 2,
      active_index: 1,
      active_step_id: 'step_2',
      steps: [
        { id: 'step_1', description: 'clear the area', status: 'completed' },
        { id: 'step_2', description: 'place production', status: 'active' },
      ],
      evidence: [],
    },
  }
}

class RouterRcon {
  constructor({ running = true } = {}) {
    this.running = running
    this.commands = []
    this.cancelCount = 0
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify(this.running
        ? { task_state: 'placing', queue_empty: false, queue_length: 4, current_task: { type: 'placing', entity_name: 'machine-x' } }
        : { task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('cancel_all_tasks')) {
      this.cancelCount++
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true]] })}`
    }
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return '{}'
  }
}

function agentFor(intent, { running = true, withPlan = true, queueConflict = intent === 'amend_current' } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  if (withPlan) memory.planByNpc.set('npc:airi', activePlan())
  const rcon = new RouterRcon({ running })
  const calls = []
  const mockProvider = async (_messages, context) => {
    calls.push(context)
    if (context.interactionRouter) {
      assert.equal(context.allowTools, false)
      assert.equal(context.triggerSource, 'interaction_router')
      return { content: JSON.stringify({ intent, queue_conflict: intent === 'amend_current' ? queueConflict : false, reply: intent === 'chat_only' ? 'Hello from the side router.' : '' }) }
    }
    return {
      content: JSON.stringify({
        chatMessage: 'Replanned current work.',
        plan: ['continue the updated production goal'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      }),
    }
  }
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'main planner',
    npcId: 'airi',
    provider: mockProvider,
    interactionProvider: mockProvider,
  })
  if (running && withPlan) {
    agent.active = true
    agent.epoch = deployment()
    agent.lastMemoryKey = 'npc:airi'
    agent.baseMessages = [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: memory.planContext('npc:airi') },
      { role: 'user', content: '[CHAT] tester: build a continuous early iron production line' },
    ]
    agent.messages = agent.baseMessages.map(message => ({ ...message }))
    agent.requestInfo = { memoryKey: 'npc:airi', turnId: 1, sender: 'tester', text: 'build a continuous early iron production line' }
  }
  return { agent, memory, rcon, calls }
}

test('interaction route parser is strict and runtime health uses authoritative task state', () => {
  assert.deepEqual(parseInteractionRoute({ content: '{"intent":"status_query","queue_conflict":false,"reply":""}' }), { intent: 'status_query', queue_conflict: false, reply: '' })
  assert.throws(() => parseInteractionRoute({ content: '{"intent":"status_query","queue_conflict":false,"reply":"","operations":[]}' }))
  assert.throws(() => parseInteractionRoute({ content: '{"intent":"bogus","queue_conflict":false,"reply":""}' }))
  assert.throws(() => parseInteractionRoute({ content: '{"intent":"status_query","queue_conflict":true,"reply":""}' }))
  assert.equal(interactionRuntimeHealthy({ task_state: 'placing', queue_length: 0 }), true)
  assert.equal(interactionRuntimeHealthy({ task_state: 'idle', queue_length: 0 }), false)
  assert.equal(interactionRuntimeHealthy({ task_state: 'IDLE', queue_length: 0 }), false)
  assert.equal(interactionRuntimeHealthy({ task_state: '  Idle  ', queue_length: 0 }), false)
})

test('constructor initializes routed lifecycle without requiring an intent variable in scope', () => {
  const memory = new CanonicalTaskBoardMemory()
  const mockProvider = async () => ({ content: '{"chatMessage":"","plan":[],"currentStep":0,"operations":[]}' })
  const agent = new NpcAgentLoop({
    rcon: new RouterRcon({ running: false }),
    memory,
    systemPrompt: 'constructor regression',
    npcId: 'airi',
    provider: mockProvider,
    interactionProvider: mockProvider,
    traceFile: null,
    stateFile: null,
  })

  assert.equal(agent.requestLifecycle, 'new_goal')
  assert.equal(agent.pendingInteractionAmendment, null)
})

test('continue_current while Autorio is healthy does not restart the main planner or cancel world work', async () => {
  const { agent, rcon, calls, memory } = agentFor('continue_current')
  const result = await agent.request('你直接继续吧', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'continue_current')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')
})

test('status_query answers from authoritative task state without a planning cycle', async () => {
  const { agent, rcon, calls } = agentFor('status_query')
  const result = await agent.request('给我汇报一下你那里卡住了', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'status_query')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.match(result.chatMessage, /placing/)
  assert.match(result.chatMessage, /4 queued tasks/)
})

test('chat_only does not alter current task state and uses only the side-router reply', async () => {
  const { agent, rcon, calls, memory } = agentFor('chat_only')
  const result = await agent.request('辛苦了', { sender: 'tester' })

  assert.equal(result.routedOnly, true)
  assert.equal(result.chatMessage, 'Hello from the side router.')
  assert.equal(calls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(memory.currentPlan('npc:airi')?.status, 'active')
})

test('amend_current cancels remaining Autorio work once, preserves the canonical goal, then replans', async () => {
  const { agent, rcon, calls, memory } = agentFor('amend_current')
  const result = await agent.request('你直接继续吧，不要管周围了', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'amend_current')
  assert.equal(result.routedOnly, false)
  assert.equal(rcon.cancelCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].triggerSource, 'amend_current')
  assert.equal(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')
})

test('compatible same-goal amendment does not cancel an active queue and is deferred to the next main-planner boundary', async () => {
  const { agent, rcon, calls, memory } = agentFor('amend_current', { queueConflict: false })
  const result = await agent.request('继续当前目标，但之后优先把炉子排紧一点', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'amend_current')
  assert.equal(result.routedOnly, true)
  assert.equal(result.amendmentDeferred, true)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(calls.length, 1)
  assert.equal(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')

  const completion = await agent.completed()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].triggerSource, 'amend_current')
  assert.equal(completion.interactionIntent, undefined)
})

test('cancel_current uses authoritative cancellation without launching the main planner', async () => {
  const { agent, rcon, calls, memory } = agentFor('cancel_current')
  const result = await agent.request('停下这个任务', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'cancel_current')
  assert.equal(result.routedOnly, true)
  assert.equal(rcon.cancelCount, 1)
  assert.equal(calls.length, 1)
  assert.equal(memory.currentPlan('npc:airi')?.status, 'paused')
})

test('true new_goal clears the previous canonical task context and starts main planning with new_goal routing', async () => {
  const { agent, rcon, calls, memory } = agentFor('new_goal')
  const result = await agent.request('改做一条铜板生产线', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'new_goal')
  assert.equal(result.routedOnly, false)
  assert.equal(rcon.cancelCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].triggerSource, 'new_goal')
  assert.notEqual(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')
})


test('interaction router does not receive historical exact ids from durable goal fields', async () => {
  const memory = new CanonicalTaskBoardMemory()
  const state = activePlan()
  state.objective = 'return to unit 331 and finish the furnace'
  state.task_board.steps[1].description = 'load unit_number=331 at the remembered furnace'
  memory.planByNpc.set('npc:airi', state)

  let routedMessages
  const interactionProvider = async (messages, context) => {
    assert.equal(context.interactionRouter, true)
    routedMessages = messages
    return { content: JSON.stringify({ intent: 'status_query', queue_conflict: false, reply: '' }) }
  }
  const agent = new NpcAgentLoop({
    rcon: new RouterRcon({ running: true }),
    memory,
    systemPrompt: 'interaction durable identity boundary test',
    npcId: 'airi',
    provider: async () => {
      throw new Error('main planner should not run for status_query')
    },
    interactionProvider,
    traceFile: null,
    stateFile: null,
  })

  const result = await agent.request('status?', { sender: 'tester' })
  assert.equal(result.routedOnly, true)
  const contextText = routedMessages.map(message => String(message.content ?? '')).join('\n')
  assert.doesNotMatch(contextText, /331/)
  assert.match(contextText, /historical exact identity \[omitted\]|historical-id-omitted/)
})
