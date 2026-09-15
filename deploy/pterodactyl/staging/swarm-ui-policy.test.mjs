import test from 'node:test'
import assert from 'node:assert/strict'

import { navigationObstaclePolicy } from './npc-agent-loop.mjs'

test('explicit preserve-tree requests disable natural obstacle clearing and continue preserves policy', () => {
  assert.deepEqual(navigationObstaclePolicy('去矿区，但是不要砍树'), { shouldUpdate: true, clearObstacles: false })
  assert.deepEqual(navigationObstaclePolicy("Follow me but don't mine rocks"), { shouldUpdate: true, clearObstacles: false })
  assert.equal(navigationObstaclePolicy('继续').shouldUpdate, false)
  assert.deepEqual(navigationObstaclePolicy('go to the iron patch'), { shouldUpdate: true, clearObstacles: true })
})

test('task board behavior is owned by canonical memory and supervisor tests, not the legacy live projection helper', () => {
  assert.equal(typeof navigationObstaclePolicy, 'function')
})
