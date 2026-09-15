import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { NpcAgentLoop } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  constructor() {
    this.status = deployment()
    this.mutations = []
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: 7, task_count: 1, task_types: ['mining'] },
        basic_operation: { last_result: { operation_id: 9, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      const admissions = [...text.matchAll(/local r\d+=remote\.call/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planMessage({ chatMessage = 'Working.', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

test('durable plan survives a new agent instance and empty actions cannot pretend execution continued', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-durable-plan-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const firstReplies = [
    planMessage({
      chatMessage: 'I will mine fuel first.',
      plan: ['Mine fuel', 'Load the furnace'],
      currentStep: 0,
      operations: [{ name: 'mine_entity', args: { entity_name: 'coal', count: 5 } }],
    }),
    planMessage({
      chatMessage: 'I am going to load the furnace now.',
      plan: ['Mine fuel', 'Load the furnace'],
      currentStep: 1,
      operations: [],
    }),
  ]
  const first = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => firstReplies.shift(),
    systemPrompt: 'NPC test prompt',
    stateFile,
    traceFile: null,
  })

  const started = await first.request('prepare the furnace', { sender: 'TTLouis' })
  assert.match(started.chatMessage, /^\[Plan 1\/2\] Mine fuel/)
  assert.equal(first.active, true)

  const stopped = await first.completed()
  assert.match(stopped.chatMessage, /^\[Plan paused\] Load the furnace/)
  assert.equal(stopped.goalStatus, 'blocked')
  assert.equal(first.active, false)

  const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  assert.equal(saved.plans[0].state.status, 'blocked')
  assert.equal(saved.plans[0].state.current_step, 1)

  let observed
  const second = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async messages => {
      observed = messages
      return planMessage({ chatMessage: 'The saved plan is still available.', plan: [], operations: [] })
    },
    systemPrompt: 'NPC test prompt',
    stateFile,
    traceFile: null,
  })
  await second.request('what were you doing?', { sender: 'TTLouis' })

  const context = observed.map(message => message.content ?? '').join('\n')
  assert.match(context, /\[PLAN_STATE\]/)
  assert.match(context, /prepare the furnace/)
  assert.match(context, /no_autorio_operation_for_remaining_plan/)
  assert.match(context, /Load the furnace/)
})

test('Autorio errors feed the detailed task receipt back into the active goal for replanning', async () => {
  const replies = [
    planMessage({
      chatMessage: 'Mining iron.',
      plan: ['Mine iron', 'Return to furnace'],
      currentStep: 0,
      operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 5 } }],
    }),
    planMessage({
      chatMessage: 'The patch failed, I will search again.',
      plan: ['Find another iron patch', 'Mine iron', 'Return to furnace'],
      currentStep: 0,
      operations: [{ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 256 } }],
    }),
  ]
  const observed = []
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async messages => {
      observed.push(messages)
      return replies.shift()
    },
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
  })

  await agent.request('get some iron', { sender: 'TTLouis' })
  const replanned = await agent.failed('mining failed: no_target; dependent operations cancelled')

  assert.equal(replanned.operations[0].name, 'walk_to_entity')
  assert.equal(agent.active, true)
  const continuation = observed[1].map(message => message.content ?? '').join('\n')
  assert.match(continuation, /\[MOD\] Autorio operation error:/)
  assert.match(continuation, /no_target/)
  assert.match(continuation, /last_completed_batch/)
})
