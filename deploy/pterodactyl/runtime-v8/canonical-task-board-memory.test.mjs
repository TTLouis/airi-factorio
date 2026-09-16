import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalContinuationPlan, CanonicalTaskBoardMemory, verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'

function board() {
  return {
    kind: 'task_board_lite',
    goal_id: 'goal_1',
    status: 'active',
    blocker: '',
    pause_reason: '',
    revision: 3,
    event_sequence: 0,
    evidence_sequence: 0,
    active_index: 2,
    active_step_id: 'step_3',
    completed_count: 2,
    total_steps: 5,
    steps: [
      { id: 'step_1', description: 'Find stone', status: 'completed' },
      { id: 'step_2', description: 'Mine stone', status: 'completed' },
      { id: 'step_3', description: 'Craft furnace', status: 'active' },
      { id: 'step_4', description: 'Build power', status: 'pending' },
      { id: 'step_5', description: 'Start research', status: 'pending' },
    ],
    evidence: [],
    events: [],
    created_at: 1,
    updated_at: 1,
  }
}

function planState(overrides = {}) {
  const taskBoard = overrides.task_board ?? board()
  return {
    goal_id: 'goal_1',
    owner: 'Louis',
    objective: 'Build early automation',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: taskBoard.steps.map(step => step.description),
    current_step: taskBoard.active_index,
    revision: 3,
    last_chat_message: 'Working',
    last_operations: ['craft_item {"item_name":"stone-furnace","count":1}'],
    updated_at: 1,
    history: [],
    task_board: taskBoard,
    ...overrides,
  }
}

function completedReceipt({ batchId = 7, taskTypes = ['crafting'], taskCount = taskTypes.length } = {}) {
  return {
    kind: 'operation_receipt',
    ref: `batch_${batchId}`,
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: batchId,
      task_count: taskCount,
      task_types: taskTypes,
      tick: 200,
    }),
  }
}

test('ordinary continuation cannot shrink a canonical five-step board to three steps', () => {
  const guarded = canonicalContinuationPlan(board(), {
    chatMessage: 'Still on the furnace step',
    plan: ['Find stone', 'Mine stone', 'Craft furnace'],
    currentStep: 2,
    operations: [{ name: 'wait', args: { ticks: 60 } }],
  })

  assert.equal(guarded.plan.length, 5)
  assert.equal(guarded.currentStep, 2)
  assert.deepEqual(guarded.plan, board().steps.map(step => step.description))
})

test('ordinary continuation may advance only to a step already on the canonical board', () => {
  const guarded = canonicalContinuationPlan(board(), {
    plan: ['Mine stone', 'Build power'],
    currentStep: 1,
  })
  assert.equal(guarded.plan.length, 5)
  assert.equal(guarded.currentStep, 3)
})

test('explicit failure replan is still allowed to replace the remaining suffix', () => {
  const proposal = {
    plan: ['Find stone', 'Mine stone', 'Recover alternate route', 'Build power'],
    currentStep: 2,
  }
  assert.equal(canonicalContinuationPlan(board(), proposal, { allowReplan: true }), proposal)
})

test('strict completed operation receipts are eligible for deterministic verification', () => {
  const verified = verifyDeterministicReceipt(planState(), completedReceipt())
  assert.deepEqual(verified, {
    verified: true,
    batchId: 7,
    taskTypes: ['crafting'],
    operationNames: ['craft_item'],
  })
})

test('partial-capable transfers, research and wait require additional verification', () => {
  for (const [operation, taskType] of [
    ['move_items_exact {"item_name":"coal","unit_number":99,"max_count":10,"to_entity":true}', 'moving_items'],
    ['research_technology {"technology_name":"automation"}', 'researching'],
    ['wait {"ticks":120}', 'waiting'],
  ]) {
    const state = planState({ last_operations: [operation] })
    const result = verifyDeterministicReceipt(state, completedReceipt({ taskTypes: [taskType] }))
    assert.equal(result.verified, false)
    assert.match(result.reason, /^operation_requires_additional_verification:/)
  }
})

test('receipt task types must match the submitted strict operations exactly', () => {
  const result = verifyDeterministicReceipt(planState(), completedReceipt({ taskTypes: ['mining'] }))
  assert.deepEqual(result, { verified: false, reason: 'receipt_operation_mismatch' })
})

test('verified intermediate step advances canonical board before the model continuation', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())

  const nextBoard = memory.recordBoardEvidence('npc:airi', completedReceipt())
  const state = memory.currentPlan('npc:airi')

  assert.equal(nextBoard.active_index, 3)
  assert.equal(nextBoard.active_step_id, 'step_4')
  assert.equal(nextBoard.completed_count, 3)
  assert.equal(state.current_step, 3)
  assert.equal(state.plan.length, 5)
  assert.equal(state.status, 'active')
  const proof = nextBoard.evidence.find(item => item.kind === 'deterministic_verification')
  assert.equal(proof.ref, 'batch_7')
  assert.equal(proof.step_id, 'step_3')
})

test('duplicate completed receipt cannot advance a second canonical step', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState())

  memory.recordBoardEvidence('npc:airi', completedReceipt())
  memory.recordBoardEvidence('npc:airi', completedReceipt())

  const state = memory.currentPlan('npc:airi')
  assert.equal(state.task_board.active_index, 3)
  assert.equal(state.current_step, 3)
  assert.equal(state.task_board.evidence.filter(item => item.kind === 'deterministic_verification' && item.ref === 'batch_7').length, 1)
})

test('verified final step records proof but leaves whole-goal closure to the existing completion continuation', () => {
  const finalBoard = board()
  finalBoard.active_index = 4
  finalBoard.active_step_id = 'step_5'
  finalBoard.completed_count = 4
  finalBoard.steps = finalBoard.steps.map((step, index) => ({ ...step, status: index < 4 ? 'completed' : 'active' }))
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState({
    task_board: finalBoard,
    current_step: 4,
    last_operations: ['clear_enemy_area {"search_radius":96}'],
  }))

  const nextBoard = memory.recordBoardEvidence('npc:airi', completedReceipt({ taskTypes: ['attacking'] }))
  const state = memory.currentPlan('npc:airi')

  assert.equal(nextBoard.active_index, 4)
  assert.equal(nextBoard.status, 'active')
  assert.equal(state.status, 'active')
  assert.equal(nextBoard.evidence.some(item => item.kind === 'deterministic_verification' && item.ref === 'batch_7'), true)
})

test('completed durable goals are retired from the current task slot', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', planState({
    status: 'completed',
    plan: [],
    current_step: 0,
    task_board: { ...board(), status: 'completed' },
  }))

  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.equal(memory.planByNpc.has('npc:airi'), false)
  assert.match(memory.planContext('npc:airi'), /No active durable goal/)
})

test('whole-goal completion returns the final completed receipt but retires it before the next UI sync', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState())
  const completion = {
    chatMessage: 'The requested goal is verified complete.',
    plan: [],
    currentStep: 0,
    operations: [],
  }

  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Build early automation' }, completion, { continuation: true })
  const reconciled = memory.reconcileTaskBoard(key, board(), completion, recorded)

  assert.equal(reconciled.state.status, 'completed')
  assert.equal(reconciled.state.task_board.status, 'completed')
  assert.equal(memory.currentPlan(key), undefined)
  assert.equal(memory.planByNpc.has(key), false)
})

test('a new actionable request after an old completed goal gets a fresh goal identity and objective', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({
    goal_id: 'goal_old',
    objective: 'Smelt ten iron plates',
    status: 'completed',
    plan: [],
    current_step: 0,
    task_board: { ...board(), goal_id: 'goal_old', status: 'completed' },
  }))

  const next = memory.recordPlan(key, { sender: 'Louis', text: 'Build a sustained iron plate line' }, {
    chatMessage: 'Starting a new production goal.',
    plan: ['Inspect resources', 'Build sustained production'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  assert.equal(next.state.status, 'active')
  assert.notEqual(next.state.goal_id, 'goal_old')
  assert.equal(next.state.objective, 'Build a sustained iron plate line')
})

test('an unfinished durable goal still keeps its identity when a new prompt steers it', () => {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:airi'
  memory.planByNpc.set(key, planState({ goal_id: 'goal_active', objective: 'Build early automation' }))

  const steered = memory.recordPlan(key, { sender: 'Louis', text: 'Move the furnace east instead' }, {
    chatMessage: 'Adjusting the active plan.',
    plan: ['Find stone', 'Mine stone', 'Craft furnace', 'Build power', 'Start research'],
    currentStep: 2,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  assert.equal(steered.state.goal_id, 'goal_active')
  assert.equal(steered.state.objective, 'Build early automation')
})

test('terminatePlan removes one durable goal without implying completion', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', {
    goal_id: 'goal_1',
    status: 'active',
    plan: ['Build boiler'],
    current_step: 0,
    revision: 1,
    history: [],
  })
  const previous = memory.terminatePlan('npc:airi')
  assert.equal(previous.goal_id, 'goal_1')
  assert.equal(memory.planByNpc.has('npc:airi'), false)
  assert.equal(memory.currentPlan('npc:airi'), undefined)
})
