import test from 'node:test'
import assert from 'node:assert/strict'

import { SwarmStrategicProjectStore } from './swarm-strategic-project-store.mjs'

test('global strategic store owns one goal identity independent of NPC sessions', () => {
  let clock = 100
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    now: () => clock,
  })

  const board = store.current()
  assert.equal(board.goal_id, 'goal-rocket')
  assert.equal(board.title, 'Launch a rocket')
  assert.equal(Object.hasOwn(board, 'npc_id'), false)
  assert.equal(Object.hasOwn(board, 'agent_id'), false)
  assert.equal(Object.hasOwn(board, 'actor_id'), false)
})

test('active global goal identity cannot be silently replaced', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  store.current()

  assert.throws(
    () => store.bindGoal({
      goalId: 'goal-oil',
      objective: 'Automate oil',
    }),
    /cannot silently replace active goal identity/,
  )
  assert.equal(store.current().goal_id, 'goal-rocket')
})

test('project updates and milestone transitions remain revisioned inside the global store', () => {
  let clock = 100
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    now: () => clock,
  })

  const initial = store.current()
  clock = 110
  const planned = store.update({
    current_milestone: { title: 'Automate red science' },
    next_milestones: [{ title: 'Automate green science' }],
    development_direction: 'vertical',
  })
  assert.equal(planned.revision, initial.revision + 1)
  assert.equal(planned.current_milestone.title, 'Automate red science')

  clock = 120
  const rejected = store.completeCurrentMilestone({ verified: false })
  assert.equal(rejected.changed, false)
  assert.equal(store.current().current_milestone.title, 'Automate red science')

  clock = 130
  const completed = store.completeCurrentMilestone({ verified: true })
  assert.equal(completed.changed, true)
  assert.equal(completed.board.transition_state, 'awaiting_next_milestone')

  clock = 140
  const advanced = store.activateNextMilestone()
  assert.equal(advanced.changed, true)
  assert.equal(advanced.board.current_milestone.title, 'Automate green science')
})

test('snapshot and restore preserve the single global strategic board', () => {
  let clock = 10
  const source = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    now: () => clock,
  })
  source.update({
    current_milestone: { title: 'Establish power' },
    next_milestones: [{ title: 'Automate science' }],
    development_direction: 'vertical',
  })

  const snapshot = source.snapshot()
  const restored = new SwarmStrategicProjectStore({
    now: () => 999,
  })
  restored.restore(snapshot)

  assert.deepEqual(restored.current(), source.current())
})

test('restored board is sanitized instead of trusted as arbitrary durable data', () => {
  const store = new SwarmStrategicProjectStore()
  const board = store.restore({
    schema: 1,
    kind: 'swarm_strategic_project_store',
    board: {
      goal_id: 'goal-1',
      title: 'Launch a rocket',
      status: 'active',
      current_milestone: { title: 'Bootstrap' },
      next_milestones: [
        { title: 'One' },
        { title: 'Two' },
        { title: 'Three' },
        { title: 'Four must be bounded away' },
      ],
      development_direction: 'not-valid',
      revision: 7,
      updated_at: 50,
    },
  })

  assert.equal(board.next_milestones.length, 3)
  assert.equal(board.development_direction, '')
  assert.equal(board.revision, 7)
})
