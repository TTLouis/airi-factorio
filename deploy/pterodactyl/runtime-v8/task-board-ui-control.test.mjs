import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveActivity,
  deriveWantedItems,
  executeUiControl,
  parseUiControlLine,
  Session,
  taskBoardUiSnapshot,
} from './supervisor.mjs'

test('UI control parser accepts fixed mod events and rejects chat spoofing or arbitrary actions', () => {
  const event = parseUiControlLine('12.3 Script @__autorio__: [AIRI_UI_CONTROL] {"version":1,"action":"follow","player_index":7,"player_name":"TTLouis","tick":900}')
  assert.deepEqual(event, { version: 1, action: 'follow', player_index: 7, player_name: 'TTLouis', tick: 900 })
  assert.equal(parseUiControlLine('2026-09-15 [CHAT] Eve: [AIRI_UI_CONTROL] {"version":1,"action":"terminate","player_index":7,"player_name":"TTLouis","tick":900}'), undefined)
  assert.equal(parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"rcon","player_index":7,"player_name":"TTLouis","tick":900}'), undefined)
  assert.equal(parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"pause","player_index":7,"player_name":"TTLouis","tick":900,"command":"/quit"}'), undefined)
})

test('UI controls reuse the AIRI chat allowlist before queueing runtime work', () => {
  const queued = []
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    ready: true,
    stopping: false,
    agent: { active: false, cancel: () => {} },
    config: { chatPlayers: { mode: 'allowlist', names: ['TTLouis'] } },
    queueEvent: fn => { queued.push(fn) },
    log: message => logs.push(message),
  })
  session.onGameLine('[AIRI_UI_CONTROL] {"version":1,"action":"pause","player_index":2,"player_name":"Eve","tick":20}')
  assert.equal(queued.length, 0)
  assert.match(logs[0], /unauthorized/i)
  session.onGameLine('[AIRI_UI_CONTROL] {"version":1,"action":"pause","player_index":1,"player_name":"TTLouis","tick":21}')
  assert.equal(queued.length, 1)
})

test('wanted items are derived only from concrete approved operations', () => {
  assert.deepEqual(deriveWantedItems({
    last_operations: [
      'place_entity {"entity_name":"assembling-machine-1","x":10,"y":20}',
      'craft_item {"item_name":"boiler","count":2}',
      'move_items {"item_name":"iron-plate","entity_name":"iron-chest","max_count":50,"to_entity":false}',
      'move_items_with_player {"item_name":"copper-plate","player_name":"TTLouis","max_count":20,"to_player":false}',
      'mine_entity {"entity_name":"iron-ore","count":100}',
      'research_technology {"technology_name":"automation"}',
    ],
  }), [
    { name: 'assembling-machine-1', count: 1, reason: 'planned placement' },
    { name: 'boiler', count: 2, reason: 'planned craft' },
    { name: 'iron-plate', count: 50, reason: 'planned pickup' },
    { name: 'copper-plate', count: 20, reason: 'requested from player' },
  ])
})

test('activity is an auditable summary rather than hidden model reasoning', () => {
  assert.deepEqual(deriveActivity({
    last_chat_message: 'I will build the power block next.',
    last_operations: ['place_entity {"entity_name":"boiler"}'],
    blocker: '', pause_reason: '',
    task_board: { evidence: [{ kind: 'operation_receipt', summary: 'Previous mining batch completed.' }] },
  }), [
    { kind: 'result', text: 'Previous mining batch completed.' },
    { kind: 'decision', text: 'I will build the power block next.' },
    { kind: 'action', text: 'place_entity {"entity_name":"boiler"}' },
  ])
})

test('task board projection carries canonical steps plus activity and wanted items', () => {
  const snapshot = taskBoardUiSnapshot({
    goal_id: 'goal_1', objective: 'Build power', blocker: '', pause_reason: '',
    last_chat_message: 'Building a boiler.', last_operations: ['craft_item {"item_name":"boiler","count":1}'],
    task_board: {
      kind: 'task_board_lite', goal_id: 'goal_1', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Build boiler', status: 'active' }], evidence: [],
    },
  })
  assert.equal(snapshot.activity.at(-1).kind, 'action')
  assert.deepEqual(snapshot.wanted_items, [{ name: 'boiler', count: 1, reason: 'planned craft' }])
})

function sessionFixture({ state = { status: 'active' } } = {}) {
  const commands = []
  const chats = []
  const syncs = []
  const agent = {
    active: true,
    memory: { terminatePlan: () => state },
    activePlanKey: () => 'npc:airi',
    loadPersistentState: async () => {},
    persistState: async () => {},
    cancel: reason => { agent.cancelReason = reason },
    pausePersistentPlan: async reason => ({ ...state, status: 'paused', pause_reason: reason }),
  }
  return {
    npcId: 'airi', agent, commands, chats, syncs,
    rcon: { command: async command => { commands.push(command); return '' } },
    ensureAuthorization: async () => ({ allowed: true }),
    currentPlanState: () => state,
    syncTaskBoardUi: async next => { syncs.push(next); return true },
    clearTaskBoardUi: async () => { commands.push('CLEAR_UI'); return true },
    printChat: async text => { chats.push(text) },
  }
}

test('pause preserves plan and stops autorio work plus follow mode', async () => {
  const session = sessionFixture()
  await executeUiControl(session, { action: 'pause', player_name: 'TTLouis' })
  assert.equal(session.syncs[0].status, 'paused')
  assert.ok(session.commands.some(command => command.includes('airi_deployment')))
  assert.ok(session.commands.some(command => command.includes('stop_follow_player')))
})

test('terminate discards durable state, stops work, and clears the task board', async () => {
  const session = sessionFixture()
  let terminated = false
  session.agent.memory.terminatePlan = () => { terminated = true; return { status: 'active' } }
  await executeUiControl(session, { action: 'terminate', player_name: 'TTLouis' })
  assert.equal(terminated, true)
  assert.equal(session.agent.cancelReason, 'ui_terminate')
  assert.ok(session.commands.includes('CLEAR_UI'))
})

test('follow pauses the active plan, cancels old work, and directly enables follow', async () => {
  const session = sessionFixture()
  await executeUiControl(session, { action: 'follow', player_name: 'TTLouis' })
  assert.equal(session.syncs[0].status, 'paused')
  const followIndex = session.commands.findIndex(command => command.includes('"follow_player",'))
  const cancelIndex = session.commands.findIndex(command => command.includes('airi_deployment'))
  assert.ok(cancelIndex >= 0 && followIndex > cancelIndex)
  assert.ok(session.commands[followIndex].includes('TTLouis'))
})

test('stop follow leaves the durable plan paused', async () => {
  const session = sessionFixture({ state: { status: 'paused' } })
  let paused = false
  session.agent.pausePersistentPlan = async () => { paused = true }
  await executeUiControl(session, { action: 'stop_follow', player_name: 'TTLouis' })
  assert.equal(paused, false)
  assert.equal(session.syncs.length, 0)
})
