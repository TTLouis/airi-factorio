import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop } from './npc-agent-loop.mjs'

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

function entityStatus(unitNumber, inventoryCount) {
  return {
    found: true,
    actor_position: { x: 0, y: 0 },
    radius: 8,
    entity: {
      name: 'assembling-machine-1',
      type: 'assembling-machine',
      position: { x: 4.5, y: 2.5 },
      force: 'player',
      unit_number: unitNumber,
      direction: 4,
      supports_direction: true,
      rotatable: true,
      recipe: 'electronic-circuit',
      inventories: [{ index: 1, items: [{ name: 'iron-plate', quality: 'normal', count: inventoryCount }] }],
      inventories_truncated: false,
      inventory_items_truncated: false,
    },
  }
}

class FakeRcon {
  constructor(statuses) {
    this.statuses = statuses
    this.entityReads = 0
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_entity_status"')) {
      const status = this.statuses[Math.min(this.entityReads, this.statuses.length - 1)]
      this.entityReads++
      return JSON.stringify(status)
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'IDLE',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: 7, task_count: 1, task_types: ['waiting'], tick: 100 },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return '{}'
  }
}

function entityTool(id) {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: 'getEntityStatus', arguments: '{"name":"assembling-machine-1","radius":8}' },
    }],
  }
}

function planMessage(operations, chatMessage = '') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: operations.length ? ['Observe machine state'] : [],
      currentStep: 0,
      operations,
    }),
  }
}

function toolResult(messages, id) {
  return messages.find(message => message.role === 'tool' && message.tool_call_id === id)
}

async function runTwoObservations(statuses) {
  const rcon = new FakeRcon(statuses)
  const providerInputs = []
  const replies = [
    entityTool('entity-first'),
    planMessage([{ name: 'wait', args: { ticks: 1 } }], 'Wait once.'),
    entityTool('entity-second'),
    planMessage([], 'Done.'),
  ]
  const agent = new NpcAgentLoop({
    rcon,
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
    provider: async messages => {
      providerInputs.push(messages.map(message => ({ ...message })))
      return replies.shift()
    },
  })

  await agent.request('observe the assembler twice', { sender: 'TTLouis' })
  assert.equal(rcon.entityReads, 1)
  const final = await agent.completed()
  assert.equal(final.chatMessage, 'Done.')
  assert.equal(rcon.entityReads, 2)
  return { providerInputs, rcon }
}

test('getEntityStatus keeps a bounded continuation baseline and returns a live diff for the same unit_number', async () => {
  const { providerInputs } = await runTwoObservations([
    entityStatus(101, 10),
    entityStatus(101, 12),
  ])

  const first = JSON.parse(toolResult(providerInputs[1], 'entity-first').content)
  assert.equal(first.observation_mode, 'full')
  assert.equal(first.reference, 'entity:101')
  assert.equal(first.entity.inventories[0].items[0].count, 10)

  const continuation = providerInputs[2].map(message => String(message.content ?? '')).join('\n')
  assert.match(continuation, /\[ENTITY_STATUS_BASELINE\]/)
  assert.match(continuation, /entity:101/)
  assert.match(continuation, /"count":10/)
  assert.match(continuation, /may now be stale/)

  const second = JSON.parse(toolResult(providerInputs[3], 'entity-second').content)
  assert.equal(second.observation_mode, 'diff')
  assert.equal(second.reference, 'entity:101')
  assert.equal(second.changes.entity.inventories[0].items[0].count, 12)
  assert.equal(second.entity, undefined)
})

test('getEntityStatus returns unchanged only after a second live read confirms the same snapshot', async () => {
  const { providerInputs, rcon } = await runTwoObservations([
    entityStatus(101, 10),
    entityStatus(101, 10),
  ])

  assert.equal(rcon.entityReads, 2)
  const second = JSON.parse(toolResult(providerInputs[3], 'entity-second').content)
  assert.deepEqual(second, {
    observation_mode: 'unchanged',
    source: 'live_factorio_entity_status',
    reference: 'entity:101',
    query: { name: 'assembling-machine-1', radius: 8 },
  })
})

test('getEntityStatus emits a new full snapshot instead of diffing different nearest entities', async () => {
  const { providerInputs } = await runTwoObservations([
    entityStatus(101, 10),
    entityStatus(202, 3),
  ])

  const second = JSON.parse(toolResult(providerInputs[3], 'entity-second').content)
  assert.equal(second.observation_mode, 'full')
  assert.equal(second.identity_changed, true)
  assert.equal(second.reference, 'entity:202')
  assert.equal(second.entity.unit_number, 202)
  assert.equal(second.entity.inventories[0].items[0].count, 3)
})
