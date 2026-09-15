import test from 'node:test'
import assert from 'node:assert/strict'

import { liveTaskBoardSnapshot, navigationObstaclePolicy } from './npc-agent-loop.mjs'

test('swarm live task board is a bounded projection of the accepted plan', () => {
  const snapshot = liveTaskBoardSnapshot('Build power', {
    plan: ['Mine stone', 'Craft boiler', 'Build steam power'],
    currentStep: 1,
  })
  assert.deepEqual(snapshot, {
    goal_id: 'live_plan',
    objective: 'Build power',
    status: 'active',
    blocker: '',
    pause_reason: '',
    completed_count: 1,
    total_steps: 3,
    active_index: 1,
    steps: [
      { id: 'step_1', description: 'Mine stone', status: 'completed' },
      { id: 'step_2', description: 'Craft boiler', status: 'active' },
      { id: 'step_3', description: 'Build steam power', status: 'pending' },
    ],
  })
})

test('completed live plans project every step as completed', () => {
  const snapshot = liveTaskBoardSnapshot('Done', { plan: ['One', 'Two'], currentStep: 1 }, { completed: true })
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.completed_count, 2)
  assert.deepEqual(snapshot.steps.map(step => step.status), ['completed', 'completed'])
})

test('explicit preserve-tree requests disable natural obstacle clearing and continue preserves policy', () => {
  assert.deepEqual(navigationObstaclePolicy('去矿区，但是不要砍树'), { shouldUpdate: true, clearObstacles: false })
  assert.deepEqual(navigationObstaclePolicy("Follow me but don't mine rocks"), { shouldUpdate: true, clearObstacles: false })
  assert.equal(navigationObstaclePolicy('继续').shouldUpdate, false)
  assert.deepEqual(navigationObstaclePolicy('go to the iron patch'), { shouldUpdate: true, clearObstacles: true })
})
