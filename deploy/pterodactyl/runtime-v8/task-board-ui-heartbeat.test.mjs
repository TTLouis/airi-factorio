import test from 'node:test'
import assert from 'node:assert/strict'

import { Session } from './supervisor.mjs'

function heartbeatSession() {
  const syncs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    rcon: {},
    ready: true,
    stopping: false,
    uiSyncDirty: false,
    uiSyncRunning: null,
    syncTaskBoardUi: async () => { syncs.push('sync'); return true },
  })
  return { session, syncs }
}

test('runtime heartbeat refreshes Task Board UI without waiting for an in-game poll', async () => {
  const { session, syncs } = heartbeatSession()

  assert.equal(session.taskBoardUiHeartbeat(), true)
  await session.uiSyncRunning

  assert.equal(syncs.length, 1)
})

test('runtime heartbeat stays quiet when the session is unavailable or stopping', () => {
  const { session, syncs } = heartbeatSession()

  session.ready = false
  assert.equal(session.taskBoardUiHeartbeat(), false)
  session.ready = true
  session.rcon = null
  assert.equal(session.taskBoardUiHeartbeat(), false)
  session.rcon = {}
  session.stopping = true
  assert.equal(session.taskBoardUiHeartbeat(), false)

  assert.equal(syncs.length, 0)
})
