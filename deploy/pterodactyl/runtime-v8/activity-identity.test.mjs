import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from './supervisor.mjs'

test('repeated identical live activities keep distinct stable identities', () => {
  const session = new Session({
    root: '/tmp/airi-test',
    app: '/tmp/airi-test/app',
    game: '/tmp/airi-test/game',
    config: {},
    save: '/tmp/airi-test/save.zip',
    settingsFile: '/tmp/airi-test/server-settings.json',
    modDir: '/tmp/airi-test/mods',
    ini: '/tmp/airi-test/config.ini',
    log: () => {},
  })
  session.requestTaskBoardUiSync = () => undefined

  session.onAgentActivity('tool.call', { name: 'getActorStatus' })
  session.onAgentActivity('tool.call', { name: 'getActorStatus' })

  assert.deepEqual(
    session.agentLive.activity.map(entry => ({ id: entry.id, text: entry.text })),
    [
      { id: 'live_1', text: 'Tool getActorStatus' },
      { id: 'live_2', text: 'Tool getActorStatus' },
    ],
  )
})
