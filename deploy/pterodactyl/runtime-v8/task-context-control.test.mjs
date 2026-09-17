import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { executeUiControl, parseUiControlLine } from './supervisor.mjs'

function activePlan(goalId, objective) {
  return {
    goal_id: goalId,
    owner: 'TTLouis',
    objective,
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Do the current step'],
    current_step: 0,
    revision: 1,
    last_chat_message: 'Working.',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
  }
}

function seedContext(memory, key, goalId, objective) {
  memory.remember(key, 1, {
    sender: 'TTLouis',
    user: `remember ${objective}`,
    assistant: 'I remember this task.',
    operations: [],
  })
  memory.planByNpc.set(key, activePlan(goalId, objective))
}

function persistentAgent(stateFile, memory = new CanonicalTaskBoardMemory()) {
  return new NpcAgentLoop({
    rcon: { command: async () => '' },
    provider: async () => { throw new Error('provider should not run in context reset test') },
    systemPrompt: 'NPC task context control test',
    stateFile,
    traceFile: null,
    memory,
    npcId: 'airi',
  })
}

function controlSession(agent, order = []) {
  const commands = []
  const chats = []
  const originalCancel = agent.cancel.bind(agent)
  agent.cancel = reason => {
    order.push(`abort:${reason}`)
    return originalCancel(reason)
  }
  const originalPersist = agent.persistState.bind(agent)
  agent.persistState = async () => {
    order.push('persist')
    return originalPersist()
  }
  return {
    npcId: 'airi',
    agent,
    commands,
    chats,
    agentLive: { phase: 'thinking', detail: 'waiting on provider', objective: 'old task', at: Date.now(), activity: [{ kind: 'note', text: 'old live state' }], debug: {} },
    ensureAuthorization: async () => ({ allowed: true }),
    rcon: {
      command: async command => {
        commands.push(command)
        if (command.includes('stop_follow_player')) order.push('world:stop_follow')
        if (command.includes('airi_deployment')) order.push('world:cancel')
        return ''
      },
    },
    clearTaskBoardUi: async () => { order.push('ui:clear'); commands.push('CLEAR_UI'); return true },
    printChat: async text => { chats.push(text) },
  }
}

test('UI control parser accepts server-authoritative new_task and still rejects arbitrary actions', () => {
  const event = parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"new_task","player_index":7,"player_name":"TTLouis","tick":900}')
  assert.deepEqual(event, { version: 1, action: 'new_task', player_index: 7, player_name: 'TTLouis', tick: 900 })
  assert.equal(parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"clear_memory","player_index":7,"player_name":"TTLouis","tick":900}'), undefined)
})

test('terminate aborts request and world work before durable deletion, then persists before clearing UI', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-ui-terminate-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const memory = new CanonicalTaskBoardMemory()
  seedContext(memory, 'npc:airi', 'goal_terminate', 'old terminate task')
  const agent = persistentAgent(stateFile, memory)
  await agent.persistState()

  const order = []
  const originalTerminate = memory.terminatePlan.bind(memory)
  memory.terminatePlan = key => {
    order.push(`memory:terminate:${key}`)
    return originalTerminate(key)
  }
  const session = controlSession(agent, order)

  await executeUiControl(session, { action: 'terminate', player_name: 'TTLouis' })

  assert.deepEqual(order, [
    'abort:ui_terminate',
    'world:stop_follow',
    'world:cancel',
    'memory:terminate:npc:airi',
    'persist',
    'ui:clear',
  ])
  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.match(memory.context('npc:airi'), /remember old terminate task/)
  assert.equal(session.agentLive.phase, 'idle')
  assert.equal(session.agentLive.objective, '')
  assert.deepEqual(session.agentLive.activity, [])

  const restarted = persistentAgent(stateFile)
  await restarted.loadPersistentState()
  assert.equal(restarted.memory.currentPlan('npc:airi'), undefined, 'terminated goal must not recover after server restart')
  assert.match(restarted.memory.context('npc:airi'), /remember old terminate task/, 'terminate preserves bounded dialogue memory')
})

test('new task clears only the target NPC dialogue and durable plan after cancelling active work', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-ui-new-task-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const memory = new CanonicalTaskBoardMemory()
  seedContext(memory, 'npc:airi', 'goal_airi', 'AIRI old context')
  seedContext(memory, 'npc:other', 'goal_other', 'other NPC context')
  const agent = persistentAgent(stateFile, memory)
  await agent.persistState()

  const order = []
  const originalClear = memory.clearTaskContext.bind(memory)
  memory.clearTaskContext = key => {
    order.push(`memory:clear:${key}`)
    return originalClear(key)
  }
  const session = controlSession(agent, order)

  await executeUiControl(session, { action: 'new_task', player_name: 'TTLouis' })

  assert.deepEqual(order, [
    'abort:ui_new_task',
    'world:stop_follow',
    'world:cancel',
    'memory:clear:npc:airi',
    'persist',
    'ui:clear',
  ])
  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.equal(memory.context('npc:airi'), '')
  assert.equal(memory.currentPlan('npc:other')?.goal_id, 'goal_other')
  assert.match(memory.context('npc:other'), /remember other NPC context/)

  const restarted = persistentAgent(stateFile)
  await restarted.loadPersistentState()
  assert.equal(restarted.memory.currentPlan('npc:airi'), undefined)
  assert.equal(restarted.memory.context('npc:airi'), '')
  assert.equal(restarted.memory.currentPlan('npc:other')?.goal_id, 'goal_other')
  assert.match(restarted.memory.context('npc:other'), /remember other NPC context/)
})
