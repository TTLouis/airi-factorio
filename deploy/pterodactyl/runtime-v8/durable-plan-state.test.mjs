import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
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
    this.batchId = 6
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: this.batchId, task_count: 1, task_types: ['mining'], tick: 400 + this.batchId },
        basic_operation: { last_result: { operation_id: 9, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      this.batchId++
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planMessage({ chatMessage = 'Working.', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

class RejectingTransferRcon extends FakeRcon {
  constructor() {
    super()
    this.transferAdmissionAttempts = 0
  }

  async command(text) {
    if (text.includes('local ok,result=pcall') && text.includes("remote.call('autorio_operations','move_items_exact'")) {
      this.transferAdmissionAttempts++
      if (this.transferAdmissionAttempts === 1) {
        const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
        assert.ok(marker)
        return `${marker}${JSON.stringify({ ok: false, result: 'autorio rejected operation 1: [false,"transfer target rejected"]' })}`
      }
    }
    return super.command(text)
  }
}

test('rejected transfer cannot advance or complete the canonical plan step', async () => {
  const plan = ['Load furnace with ore and fuel', 'Retrieve 20 iron plates']
  let reply = 0
  const agent = new NpcAgentLoop({
    rcon: new RejectingTransferRcon(),
    provider: async () => {
      reply++
      if (reply === 1) {
        return planMessage({
          chatMessage: 'Loading the observed furnace.',
          plan,
          currentStep: 0,
          operations: [{
            name: 'move_items_exact',
            args: { item_name: 'iron-ore', unit_number: 582, max_count: 20, to_entity: true },
          }],
        })
      }
      return planMessage({
        chatMessage: 'Trying to retrieve plates despite the rejected supply.',
        plan,
        currentStep: 1,
        operations: [{
          name: 'move_items_exact',
          args: { item_name: 'iron-plate', unit_number: 582, max_count: 20, to_entity: false },
        }],
      })
    },
    systemPrompt: 'NPC transfer truth test prompt',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  await assert.rejects(
    agent.request('produce 20 iron plates', { sender: 'TTLouis' }),
    /operation batch was not replayed|operation batch|rejected operation/i,
  )
  const rejectedState = agent.memory.currentPlan('npc:airi')
  assert.equal(rejectedState.status, 'blocked')
  assert.equal(rejectedState.task_board.active_index, 0)
  assert.equal(rejectedState.task_board.completed_count, 0)
  assert.equal(rejectedState.task_board.steps[0].status, 'blocked')
  assert.equal(rejectedState.task_board.blocker, 'operation_admission_failed')

  const attemptedSkip = await agent.request('continue', { sender: 'TTLouis' })
  assert.equal(attemptedSkip.goalStatus, 'blocked')
  assert.equal(attemptedSkip.taskBoard.active_index, 0)
  assert.equal(attemptedSkip.taskBoard.completed_count, 0)
  assert.equal(attemptedSkip.taskBoard.steps[0].status, 'blocked')
  assert.equal(attemptedSkip.taskBoard.blocker, 'operation_admission_failed')
  assert.equal(attemptedSkip.operations.length, 0)
  assert.equal(agent.rcon.transferAdmissionAttempts, 1)
  assert.equal(agent.memory.currentPlan('npc:airi').current_step, 0)
})

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
  assert.equal(started.taskBoard.active_step_id, 'step_1')
  assert.equal(first.active, true)

  const stopped = await first.completed()
  assert.match(stopped.chatMessage, /^\[Plan paused\] Load the furnace/)
  assert.equal(stopped.goalStatus, 'blocked')
  assert.equal(stopped.taskBoard.active_step_id, 'step_2')
  assert.equal(stopped.taskBoard.completed_count, 1)
  assert.equal(first.active, false)

  const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  assert.equal(saved.plans[0].state.status, 'blocked')
  assert.equal(saved.plans[0].state.current_step, 1)
  assert.equal(saved.plans[0].state.task_board.total_steps, 2)
  assert.equal(saved.plans[0].state.task_board.evidence.at(-1).ref, 'batch_7')

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
  assert.match(context, /task_board/)
  assert.match(context, /prepare the furnace/)
  assert.match(context, /no_autorio_operation_for_remaining_plan/)
  assert.match(context, /Load the furnace/)
})

test('canonical task board prevents model plan-length drift from resetting visible progress', async () => {
  const canonical = ['Observe area', 'Mine ore', 'Place machine', 'Load machine', 'Verify output']
  const replies = [
    planMessage({
      chatMessage: 'Starting.',
      plan: canonical,
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    }),
    planMessage({
      chatMessage: 'Continuing the same step.',
      plan: ['Observe area', 'Extra thought', 'Mine ore', 'Place machine', 'Load machine', 'Verify output', 'Another thought'],
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    }),
    planMessage({
      chatMessage: 'Advancing to construction.',
      plan: canonical,
      currentStep: 2,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    }),
  ]
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => replies.shift(),
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
  })

  const first = await agent.request('build a small line', { sender: 'TTLouis' })
  assert.match(first.chatMessage, /^\[Plan 1\/5\] Observe area/)
  assert.equal(first.taskBoard.total_steps, 5)

  const second = await agent.completed()
  assert.match(second.chatMessage, /^\[Plan 1\/5\] Observe area/)
  assert.equal(second.plan.length, 5)
  assert.equal(second.taskBoard.total_steps, 5)
  assert.equal(second.taskBoard.revision >= first.taskBoard.revision, true)

  const third = await agent.completed()
  assert.match(third.chatMessage, /^\[Plan 3\/5\] Place machine/)
  assert.equal(third.taskBoard.completed_count, 2)
  assert.equal(third.taskBoard.active_step_id, 'step_3')
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
  assert.equal(replanned.taskBoard.steps[0].description, 'Find another iron patch')
  assert.equal(replanned.taskBoard.evidence.at(-1).kind, 'operation_error_receipt')
  assert.equal(agent.active, true)
  const continuation = observed[1].map(message => message.content ?? '').join('\n')
  assert.match(continuation, /\[MOD\] Autorio operation error:/)
  assert.match(continuation, /no_target/)
  assert.match(continuation, /last_completed_batch/)
})
