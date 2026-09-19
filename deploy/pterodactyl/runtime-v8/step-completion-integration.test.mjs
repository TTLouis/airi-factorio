import assert from 'node:assert/strict'
import test from 'node:test'

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
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function activeState() {
  return {
    goal_id: 'goal_completion',
    owner: 'tester',
    objective: 'prepare materials and craft the requested machine',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Prepare enough processed material', 'Craft requested machine'],
    current_step: 0,
    revision: 2,
    last_chat_message: '',
    last_operations: ['wait {"ticks":60}'],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: true,
    last_verified_batch_id: 7,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_completion',
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 2,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 1,
      proposed_focus_step_id: 'step_2',
      steps: [
        { id: 'step_1', description: 'Prepare enough processed material', status: 'active' },
        { id: 'step_2', description: 'Craft requested machine', status: 'pending' },
      ],
      evidence: [{
        id: 'evidence_1',
        kind: 'deterministic_verification',
        ref: 'batch_7',
        summary: JSON.stringify({
          verdict: 'verified_complete',
          operations: ['wait'],
          task_types: ['waiting'],
        }),
        step_id: 'step_1',
        at: Date.now(),
      }],
      events: [],
    },
  }
}

class Rcon {
  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false, healthy: false, controller_live: false })
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify({ task_state: 'idle', queue_length: 0, queue_empty: true })
    return '{}'
  }
}

function completionDecision(choice, confidence = 0.95) {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      contract: {
        type: 'choice',
        choice,
        confidence,
        probabilities: {
          semantic_unknown: choice === 'semantic_unknown' ? 0.95 : 0.05,
          candidate_1: choice === 'candidate_1' ? 0.95 : 0.05,
        },
      },
      compound_step: { type: 'noul', noul: choice === 'semantic_unknown' ? 0.9 : 0.1 },
    },
    usage: { input_tokens: 60, output_tokens: 6, cost: 0.000002 },
  }
}

function agentWithDecision(decisionProvider) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', activeState())
  const agent = new NpcAgentLoop({
    rcon: new Rcon(),
    memory,
    npcId: 'airi',
    systemPrompt: 'completion gate integration',
    provider: async () => { throw new Error('main planner not expected') },
    interactionDecisionProvider: decisionProvider,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:airi'
  agent.requestInfo = { memoryKey: 'npc:airi', turnId: 1, sender: 'tester', text: 'continue' }
  return { agent, memory }
}

test('compound semantic step stays active when Jev says strict receipt is insufficient', async () => {
  const { agent, memory } = agentWithDecision(async () => completionDecision('semantic_unknown'))
  const result = await agent.routeStepCompletionDecision({
    view: { last_completed_batch: { batch_id: 7 } },
  })

  assert.equal(result.verified, false)
  const state = memory.planByNpc.get('npc:airi')
  assert.equal(state.task_board.completed_count, 0)
  assert.equal(state.task_board.active_index, 0)
  assert.equal(state.task_board.steps[0].status, 'active')
  assert.ok(state.task_board.evidence.some(item => item.kind === 'step_completion_contract'))
})

test('Jev contract selection cannot complete a step without matching grounded receipt evidence', async () => {
  const { agent, memory } = agentWithDecision(async () => completionDecision('candidate_1'))
  memory.planByNpc.get('npc:airi').task_board.evidence = []

  const result = await agent.routeStepCompletionDecision({
    view: { last_completed_batch: { batch_id: 7 } },
  })

  assert.equal(result.verified, false)
  assert.equal(result.reason, 'no_authoritative_operation_receipt')
  assert.equal(memory.planByNpc.get('npc:airi').task_board.completed_count, 0)
})

test('Jev-selected receipt contract advances exactly one step only after runtime verifies receipt', async () => {
  const { agent, memory } = agentWithDecision(async () => completionDecision('candidate_1'))
  const result = await agent.routeStepCompletionDecision({
    view: { last_completed_batch: { batch_id: 7 } },
  })

  assert.equal(result.verified, true)
  assert.equal(result.state.status, 'active')
  assert.equal(result.state.task_board.completed_count, 1)
  assert.equal(result.state.task_board.active_index, 1)
  assert.equal(result.state.task_board.steps[0].status, 'completed')
  assert.equal(result.state.task_board.steps[1].status, 'active')

  const duplicate = await agent.routeStepCompletionDecision({
    view: { last_completed_batch: { batch_id: 7 } },
  })
  assert.equal(duplicate.verified, false)
  assert.equal(memory.planByNpc.get('npc:airi').task_board.completed_count, 1)
})

test('low-confidence completion normalization fails closed', async () => {
  const { agent, memory } = agentWithDecision(async () => completionDecision('candidate_1', 0.4))
  const result = await agent.routeStepCompletionDecision({
    view: { last_completed_batch: { batch_id: 7 } },
  })
  assert.equal(result.verified, false)
  assert.equal(memory.planByNpc.get('npc:airi').task_board.completed_count, 0)
})
