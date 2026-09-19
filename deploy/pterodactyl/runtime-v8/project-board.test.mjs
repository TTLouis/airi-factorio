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


test('parses a bounded Main LLM project proposal without allowing project-goal rewrites', async () => {
  const { parseProjectProposal } = await import('./project-board.mjs')
  assert.deepEqual(parseProjectProposal({
    currentMilestone: {
      title: 'Establish burner production',
      completionSummary: 'Stable early iron and copper production is available.',
    },
    nextMilestones: [
      { title: 'Reach Automation' },
      { title: 'Establish electric power' },
    ],
    developmentDirection: 'vertical',
  }), {
    current_milestone: {
      title: 'Establish burner production',
      completion_summary: 'Stable early iron and copper production is available.',
    },
    next_milestones: [
      { title: 'Reach Automation', completion_summary: undefined },
      { title: 'Establish electric power', completion_summary: undefined },
    ],
    development_direction: 'vertical',
  })
  assert.throws(() => parseProjectProposal({
    title: 'Rewrite the user goal',
    currentMilestone: { title: 'Bootstrap' },
  }), /Invalid project proposal field/)
  assert.throws(() => parseProjectProposal({
    currentMilestone: { title: 'Bootstrap' },
    nextMilestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }],
  }), /Invalid nextMilestones/)
})


test('derives stable milestone ids from milestone titles', () => {
  const first = sanitizeProjectBoard({
    current_milestone: { title: 'Establish burner production' },
    next_milestones: [{ title: 'Reach Automation' }],
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })
  const second = sanitizeProjectBoard({
    current_milestone: { title: 'Establish burner production' },
    next_milestones: [{ title: 'Reach Automation' }],
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 20 })
  assert.match(first.current_milestone.id, /^milestone_/)
  assert.equal(first.current_milestone.id, second.current_milestone.id)
  assert.equal(first.next_milestones[0].id, second.next_milestones[0].id)
})


test('verified milestone completion moves current milestone into bounded history', async () => {
  const { completeCurrentMilestone } = await import('./project-board.mjs')
  const current = sanitizeProjectBoard({
    current_milestone: { title: 'Establish burner production' },
    next_milestones: [{ title: 'Reach Automation' }],
    development_direction: 'vertical',
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })

  const rejected = completeCurrentMilestone(current, {
    verified: false,
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 20,
  })
  assert.equal(rejected.changed, false)
  assert.equal(rejected.board.current_milestone.title, 'Establish burner production')

  const completed = completeCurrentMilestone(current, {
    verified: true,
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 30,
  })
  assert.equal(completed.changed, true)
  assert.equal(completed.board.current_milestone, undefined)
  assert.equal(completed.board.completed_milestones.at(-1).title, 'Establish burner production')
  assert.equal(completed.board.transition_state, 'awaiting_next_milestone')
})

test('next tentative milestone only activates from an awaiting transition', async () => {
  const { activateNextMilestone, completeCurrentMilestone } = await import('./project-board.mjs')
  const current = sanitizeProjectBoard({
    current_milestone: { title: 'Establish burner production' },
    next_milestones: [{ title: 'Reach Automation' }, { title: 'Establish electric power' }],
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })
  const completed = completeCurrentMilestone(current, {
    verified: true,
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 20,
  }).board
  const advanced = activateNextMilestone(completed, {
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 30,
  })
  assert.equal(advanced.changed, true)
  assert.equal(advanced.board.current_milestone.title, 'Reach Automation')
  assert.deepEqual(advanced.board.next_milestones.map(item => item.title), ['Establish electric power'])
  assert.equal(advanced.board.transition_state, 'awaiting_milestone_plan')
  assert.equal(advanced.board.transition_state, '')
})
