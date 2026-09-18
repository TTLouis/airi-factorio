import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function planMessage(operations, {
  chatMessage = '',
  plan = ['Do the current step'],
  currentStep = 0,
} = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

class ExactTargetRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.nearby = { actor_position: { x: 0, y: 0 }, entities: [] }
    this.preflightByUnit = new Map()
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
    }
  }

  completedStatus(batchId, taskTypes) {
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_completed_batch: {
        batch_id: batchId,
        task_count: taskTypes.length,
        task_types: taskTypes,
        tick: 200 + batchId,
      },
    }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify(this.operationStatus)
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      const match = text.match(/unit_number[^0-9]*(\d+)/)
      const unitNumber = match ? Number(match[1]) : undefined
      if (unitNumber !== undefined && this.preflightByUnit.has(unitNumber)) {
        return JSON.stringify(this.preflightByUnit.get(unitNumber))
      }
      return JSON.stringify({ ok: true })
    }
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

test('same-goal live observed exact id is executable', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 289, position: { x: 8, y: 1 }, distance: 8.1 }],
  }
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'same goal exact identity test',
    provider: async (_messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
    },
  })

  const result = await agent.request('act on the furnace I just observed', { sender: 'tester' })
  assert.equal(result.operations[0].name, 'mine_entity_exact')
  assert.equal(result.operations[0].args.unit_number, 289)
  assert.equal(rcon.mutations.length, 1)
})

test('old task unit id cannot leak into a new human request', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 289, position: { x: 8, y: 1 }, distance: 8.1 }],
  }
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'request scoped exact identity test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('observe-first', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      if (calls === 2) return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
      if (calls === 3) return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
      if (calls === 4) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /not bound by a live observation in this active request/i)
        return { content: null, tool_calls: [toolCall('observe-again', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
    },
  })

  const first = await agent.request('act on the observed furnace', { sender: 'tester' })
  assert.equal(first.operations[0].args.unit_number, 289)
  assert.equal(rcon.mutations.length, 1)

  const second = await agent.request('new task involving that furnace', { sender: 'tester' })
  assert.equal(second.operations[0].args.unit_number, 289)
  assert.equal(calls, 5)
  assert.equal(rcon.mutations.length, 2)
})

test('stale exact id is rejected before admission and replacement is rebound after coordinate return', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 60, position: { x: 10, y: 4 }, distance: 10.8 }],
  }
  rcon.preflightByUnit.set(60, {
    ok: false,
    code: 'stale_exact_target',
    operation: 'mine_entity_exact',
    field: 'unit_number',
    identity: 60,
    last_observed: {
      unit_number: 60,
      name: 'stone-furnace',
      surface_index: 1,
      force_index: 1,
      position: { x: 10, y: 4 },
      observed_tick: 100,
    },
  })

  let calls = 0
  const canonicalPlan = ['Return to known location', 'Bind and act on current entity']
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'stale exact identity recovery test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('old-furnace', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      if (calls === 2) {
        return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 60 } }], {
          plan: canonicalPlan,
          currentStep: 0,
        })
      }
      if (calls === 3) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /deterministic preflight rejected it before Autorio admission/i)
        assert.match(text, /\(10, 4\)/)
        return planMessage([{ name: 'walk_to_position', args: { x: 10, y: 4, reach_distance: 2 } }], {
          plan: canonicalPlan,
          currentStep: 0,
        })
      }
      if (calls === 4) {
        return { content: null, tool_calls: [toolCall('replacement-furnace', 'getNearbyEntities', { radius: 16, name: 'stone-furnace', limit: 4 })] }
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }], {
        plan: canonicalPlan,
        currentStep: 1,
      })
    },
  })

  const approach = await agent.request('return to that furnace location and act on the current furnace there', { sender: 'tester' })
  assert.equal(approach.operations[0].name, 'walk_to_position')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /mine_entity_exact',60/)

  rcon.nearby = {
    actor_position: { x: 9, y: 4 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 289, position: { x: 10, y: 4 }, distance: 1 }],
  }
  rcon.preflightByUnit.set(289, {
    ok: true,
    operation: 'mine_entity_exact',
    field: 'unit_number',
    identity: 289,
  })
  rcon.completedStatus(1, ['walking_direct'])
  const rebound = await agent.completed()

  assert.equal(rebound.operations[0].name, 'mine_entity_exact')
  assert.equal(rebound.operations[0].args.unit_number, 289)
  assert.equal(rcon.mutations.length, 2)
  assert.match(rcon.mutations[1], /mine_entity_exact',289/)
  assert.doesNotMatch(rcon.mutations[1], /mine_entity_exact',60/)
})
