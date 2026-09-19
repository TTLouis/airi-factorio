import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activateNextStrategicMilestone,
  completeCurrentStrategicMilestone,
  parseStrategicProjectProposal,
  sanitizeStrategicProjectBoard,
  updateStrategicProjectBoard,
} from './strategic-project-board.mjs'

test('strategic board is a goal-level layer and does not reuse swarm Project identity', () => {
  const board = sanitizeStrategicProjectBoard(undefined, {
    goalId: 'goal_automation',
    objective: 'Reach Automation technology',
    status: 'active',
    now: 100,
  })

  assert.equal(board.kind, 'strategic_project_board_v1')
  assert.equal(board.goal_id, 'goal_automation')
  assert.equal(board.title, 'Reach Automation technology')
  assert.equal(board.current_milestone, undefined)
  assert.deepEqual(board.next_milestones, [])

  for (const forbidden of ['project_id', 'mission_id', 'objective_id', 'work', 'claims', 'actors']) {
    assert.equal(Object.hasOwn(board, forbidden), false)
  }
})

test('keeps one active strategic milestone and at most three tentative milestones', () => {
  const board = sanitizeStrategicProjectBoard({
    current_milestone: { id: 'bootstrap', title: 'Establish burner production' },
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

test('updates hierarchy metadata without changing the user-goal identity', () => {
  const initial = sanitizeStrategicProjectBoard(undefined, {
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 10,
  })
  const updated = updateStrategicProjectBoard(initial, {
    current_milestone: { id: 'bootstrap', title: 'Establish burner production' },
    development_direction: 'vertical',
  }, {
    goalId: 'different_goal_should_not_replace_existing',
    objective: 'Different title should not replace existing',
    status: 'active',
    now: 20,
  })

  assert.equal(updated.goal_id, 'goal_1')
  assert.equal(updated.title, 'Launch a rocket')
  assert.equal(updated.current_milestone.title, 'Establish burner production')
  assert.equal(updated.revision, 2)
})

test('bounded proposals cannot rewrite goal identity or touch swarm coordination records', () => {
  assert.deepEqual(parseStrategicProjectProposal({
    currentMilestone: {
      title: 'Establish burner production',
      completionSummary: 'Stable early production exists.',
    },
    nextMilestones: [{ title: 'Reach Automation' }],
    developmentDirection: 'vertical',
  }), {
    current_milestone: {
      title: 'Establish burner production',
      completion_summary: 'Stable early production exists.',
    },
    next_milestones: [
      { title: 'Reach Automation', completion_summary: undefined },
    ],
    development_direction: 'vertical',
  })

  for (const field of ['title', 'goalId', 'missionId', 'projectId', 'work', 'claims']) {
    assert.throws(() => parseStrategicProjectProposal({
      currentMilestone: { title: 'Bootstrap' },
      [field]: 'forbidden',
    }), /Invalid strategic project proposal field/)
  }
})

test('derives stable strategic milestone ids from titles', () => {
  const first = sanitizeStrategicProjectBoard({
    current_milestone: { title: 'Establish burner production' },
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })
  const second = sanitizeStrategicProjectBoard({
    current_milestone: { title: 'Establish burner production' },
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 20 })

  assert.match(first.current_milestone.id, /^milestone_/)
  assert.equal(first.current_milestone.id, second.current_milestone.id)
})

test('milestone completion requires authoritative verification', () => {
  const current = sanitizeStrategicProjectBoard({
    current_milestone: { title: 'Establish burner production' },
    next_milestones: [{ title: 'Reach Automation' }],
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })

  const rejected = completeCurrentStrategicMilestone(current, {
    verified: false,
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 20,
  })
  assert.equal(rejected.changed, false)
  assert.equal(rejected.reason, 'completion_not_verified')
  assert.equal(rejected.board.current_milestone.title, 'Establish burner production')

  const completed = completeCurrentStrategicMilestone(current, {
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

test('next milestone cannot activate merely because current milestone is absent', () => {
  const untransitioned = sanitizeStrategicProjectBoard({
    next_milestones: [{ title: 'Reach Automation' }],
  }, { goalId: 'goal_1', objective: 'Launch a rocket', now: 10 })

  const rejected = activateNextStrategicMilestone(untransitioned, {
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 20,
  })
  assert.equal(rejected.changed, false)
  assert.equal(rejected.reason, 'not_awaiting_next_milestone')

  const awaiting = updateStrategicProjectBoard(untransitioned, {
    transition_state: 'awaiting_next_milestone',
  }, {
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 30,
  })
  const advanced = activateNextStrategicMilestone(awaiting, {
    goalId: 'goal_1',
    objective: 'Launch a rocket',
    now: 40,
  })
  assert.equal(advanced.changed, true)
  assert.equal(advanced.board.current_milestone.title, 'Reach Automation')
  assert.equal(advanced.board.transition_state, '')
})
