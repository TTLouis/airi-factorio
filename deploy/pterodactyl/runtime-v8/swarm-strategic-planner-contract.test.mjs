import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStrategicPlannerProposal,
  evaluateStrategicPlannerProposal,
} from './swarm-strategic-planner-contract.mjs'
import { SwarmStrategicProjectStore } from './swarm-strategic-project-store.mjs'

function proposal(current, next = [], direction = 'vertical') {
  return {
    currentMilestone: { title: current },
    nextMilestones: next.map(title => ({ title })),
    developmentDirection: direction,
  }
}

test('planner may initialize the first strategic milestone on an empty active board', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })

  const result = applyStrategicPlannerProposal(store, proposal(
    'Automate red science',
    ['Automate green science', 'Establish oil processing'],
    'vertical',
  ))

  assert.equal(result.accepted, true)
  assert.equal(result.changed, true)
  assert.equal(result.reason, 'initialize_strategic_milestone')
  assert.equal(store.current().current_milestone.title, 'Automate red science')
  assert.deepEqual(
    store.current().next_milestones.map(item => item.title),
    ['Automate green science', 'Establish oil processing'],
  )
})

test('planner cannot silently replace an active strategic milestone', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  store.update({
    current_milestone: { title: 'Automate red science' },
    next_milestones: [{ title: 'Automate green science' }],
    development_direction: 'vertical',
  })
  const before = store.current()

  const result = applyStrategicPlannerProposal(store, proposal(
    'Skip ahead to oil processing',
    ['Build blue science'],
    'horizontal',
  ))

  assert.equal(result.accepted, false)
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'active_milestone_replacement_requires_runtime_transition')
  assert.deepEqual(store.current(), before)
})

test('planner can refresh tentative horizon while preserving current milestone identity', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  store.update({
    current_milestone: { title: 'Automate red science' },
    next_milestones: [{ title: 'Old tentative step' }],
    development_direction: 'vertical',
  })
  const currentId = store.current().current_milestone.id

  const result = applyStrategicPlannerProposal(store, proposal(
    'Automate red science',
    ['Automate green science', 'Scale iron throughput'],
    'horizontal',
  ))

  assert.equal(result.accepted, true)
  assert.equal(result.reason, 'refresh_existing_milestone_horizon')
  assert.equal(store.current().current_milestone.id, currentId)
  assert.equal(store.current().current_milestone.title, 'Automate red science')
  assert.deepEqual(
    store.current().next_milestones.map(item => item.title),
    ['Automate green science', 'Scale iron throughput'],
  )
  assert.equal(store.current().development_direction, 'horizontal')
})

test('planner cannot bypass awaiting-next-milestone transition by inventing a new current milestone', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  store.update({
    current_milestone: { title: 'Bootstrap power' },
    next_milestones: [{ title: 'Automate science' }],
  })
  const completed = store.completeCurrentMilestone({ verified: true })
  assert.equal(completed.changed, true)
  assert.equal(store.current().transition_state, 'awaiting_next_milestone')

  const before = store.current()
  const result = applyStrategicPlannerProposal(store, proposal(
    'Invented replacement milestone',
    ['Another future step'],
    'recover',
  ))

  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'awaiting_runtime_milestone_activation')
  assert.deepEqual(store.current(), before)
})

test('runtime activation remains the only path from awaiting transition to the next current milestone', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  store.update({
    current_milestone: { title: 'Bootstrap power' },
    next_milestones: [{ title: 'Automate science' }],
  })
  store.completeCurrentMilestone({ verified: true })

  const advanced = store.activateNextMilestone()
  assert.equal(advanced.changed, true)
  assert.equal(store.current().current_milestone.title, 'Automate science')
  assert.equal(store.current().transition_state, '')
})

test('invalid planner fields fail at the proposal parser before touching durable state', () => {
  const store = new SwarmStrategicProjectStore({
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  const before = store.current()

  assert.throws(
    () => evaluateStrategicPlannerProposal(store, {
      currentMilestone: { title: 'Bootstrap' },
      nextMilestones: [],
      developmentDirection: 'vertical',
      missionId: 'mission-must-not-be-writable',
    }),
    /Invalid strategic project proposal field/,
  )
  assert.deepEqual(store.current(), before)
})
