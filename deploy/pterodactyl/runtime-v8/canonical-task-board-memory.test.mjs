import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalContinuationPlan } from './canonical-task-board-memory.mjs'

function board() {
  return {
    kind: 'task_board_lite',
    active_index: 2,
    completed_count: 2,
    total_steps: 5,
    steps: [
      { id: 'step_1', description: 'Find stone', status: 'completed' },
      { id: 'step_2', description: 'Mine stone', status: 'completed' },
      { id: 'step_3', description: 'Craft furnace', status: 'active' },
      { id: 'step_4', description: 'Build power', status: 'pending' },
      { id: 'step_5', description: 'Start research', status: 'pending' },
    ],
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
