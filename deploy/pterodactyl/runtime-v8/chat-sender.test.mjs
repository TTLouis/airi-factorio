import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from './supervisor.mjs'

test('chat sender identity is passed into the NPC request context', async () => {
  const session = new Session({
    root: '/tmp/airi-test',
    app: '/tmp/app',
    game: '/tmp/game',
    config: { chatPlayers: { mode: 'all', names: [] } },
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
    log: () => {},
  })
  let request
  session.ready = true
  session.rcon = { command: async () => 'ok' }
  session.ensureAuthorization = async () => ({ actor_id: 18, epoch: 3 })
  session.agent = {
    active: false,
    request: async (text, options) => {
      request = { text, options }
      return { chatMessage: '' }
    },
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('2026-09-15 00:00:00 [CHAT] TTLouis: !airi follow me')
  await session.eventQueue

  assert.deepEqual(request, {
    text: 'follow me',
    options: { sender: 'TTLouis' },
  })
})
