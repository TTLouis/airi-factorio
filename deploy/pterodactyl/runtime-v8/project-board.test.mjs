import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeProjectBoard, updateProjectBoard } from './project-board.mjs'

test('creates a durable project shell without inventing a milestone', () => {
  const board = sanitizeProjectBoard(undefined, {
    goalId: 'goal_automation',
    objective: 'Reach Automation technology',
    status: 'active',
    now: 100,
  })
  assert.equal(board.kind, 'project_board_v1')
  assert.equal(board.project_id, 'goal_automation')
  assert.equal(board.title, 'Reach Automation technology')
  assert.equal(board.status, 'active')
  assert.equal(board.current_milestone, undefined)
  assert.deepEqual(board.next_milestones, [])
  assert.equal(board.development_direction, '')
})

test('keeps one active milestone and at most three tentative future milestones', () => {
  const board = sanitizeProjectBoard({
    current_milestone: { id: 'bootstrap', title: 'Establish burner production', completion_summary: 'Stable early production exists.' },
    next_milestones: [
      { id: 'automation', title: 'Reach Automation' },
      { id: 'power', title: 'Establish electric power' },
      { id: 'science', title: 'Automate early science' },
      { id: 'oil', title: 'Reach oil processing' },
    ],
    development_direction: 'vertical',
  }, { goalId: 'goal_rocket', objective: 'Launch a rocket', now: 100 })
  assert.equal(board.current_milestone.status, 'active')
  assert.equal(board.next_milestones.length, 3)
  assert.deepEqual(board.next_milestones.map(item => item.status), ['tentative', 'tentative', 'tentative'])
  assert.equal(board.development_direction, 'vertical')
})

test('updates hierarchy metadata without changing project identity', () => {
  const initial = sanitizeProjectBoard(undefined, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })
  const updated = updateProjectBoard(initial, {
    current_milestone: { id: 'bootstrap', title: 'Establish burner production' },
    development_direction: 'vertical',
  }, { goalId: 'goal_1', objective: 'Launch a rocket', status: 'active', now: 20 })
  assert.equal(updated.project_id, 'goal_1')
  assert.equal(updated.title, 'Launch a rocket')
  assert.equal(updated.current_milestone.title, 'Establish burner production')
  assert.equal(updated.development_direction, 'vertical')
  assert.equal(updated.revision, 2)
})
