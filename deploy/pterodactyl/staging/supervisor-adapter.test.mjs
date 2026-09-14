import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actorChanged,
  configureNpcSession,
  deploymentStatus,
  executeAuthorizedBatch,
  executeAuthorizedOperation,
  validatedOperationCall,
} from './supervisor-adapter.mjs'

const SESSION = '0123456789abcdef0123456789abcdef'

function readyStatus(overrides = {}) {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: SESSION,
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
    ...overrides,
  }
}

class FakeRcon {
  constructor(responses = []) {
    this.responses = [...responses]
    this.commands = []
  }

  async command(text) {
    this.commands.push(text)
    if (!this.responses.length) throw new Error('unexpected RCON command')
    const next = this.responses.shift()
    return typeof next === 'function' ? next(text) : next
  }
}

test('configure handshake selects npc and verifies the native deployment status', async () => {
  const rcon = new FakeRcon([
    SESSION,
    JSON.stringify(readyStatus()),
  ])
  const status = await configureNpcSession(rcon, SESSION)
  assert.equal(status.actor_id, 18)
  assert.match(rcon.commands[0], /"configure","npc"/)
  assert.match(rcon.commands[1], /"airi_deployment","status"/)
})

test('configure handshake repeats only the idempotent startup command after the first-lua warning', async () => {
  const rcon = new FakeRcon([
    'Lua console commands will disable achievements. Please repeat the command to proceed.',
    SESSION,
    JSON.stringify(readyStatus()),
  ])
  await configureNpcSession(rcon, SESSION)
  assert.equal(rcon.commands[0], rcon.commands[1])
  assert.notEqual(rcon.commands[1], rcon.commands[2])
})

test('deployment status requires native npc identity and interfaces', async () => {
  for (const broken of [
    { revision: 'airi-deploy-v7' },
    { mode: 'player' },
    { allowed: false },
    { actor_kind: 'connected_player' },
    { actor_id: undefined },
    { epoch: 0 },
    { actor_interface: false },
    { operations: false },
    { tools: false },
  ]) {
    const rcon = new FakeRcon([JSON.stringify(readyStatus(broken))])
    await assert.rejects(() => deploymentStatus(rcon))
  }
})

test('authorized operation wraps the mutation with an atomic actor-epoch check', async () => {
  const marker = 'AIRI_RESULT_0123456789abcdef01234567:'
  const rcon = new FakeRcon([
    `tool output\n${marker}${JSON.stringify({ ok: true, result: [true, 'Task started'] })}`,
  ])
  const result = await executeAuthorizedOperation(
    rcon,
    3,
    'remote.call("autorio_operations","wait",60)',
    marker,
  )
  assert.deepEqual(result.result, [true, 'Task started'])
  assert.equal(result.output, 'tool output')
  assert.match(rcon.commands[0], /airi_deployment","authorize",3/)
  assert.match(rcon.commands[0], /autorio_operations","wait",60/)
})

test('authorized dependency batch admits every operation in one RCON/Lua transaction', async () => {
  const marker = 'AIRI_RESULT_0123456789abcdef01234567:'
  const rcon = new FakeRcon([
    `${marker}${JSON.stringify({ ok: true, result: [[true, 'first'], [true, 'second']] })}`,
  ])
  const result = await executeAuthorizedBatch(rcon, 3, [
    'remote.call("autorio_operations","mine_entity","iron-ore",1)',
    'remote.call("autorio_operations","wait",300)',
  ], marker)

  assert.equal(rcon.commands.length, 1)
  assert.equal(result.results.length, 2)
  assert.equal((rcon.commands[0].match(/airi_deployment","authorize",3/g) ?? []).length, 1)
  const first = rcon.commands[0].indexOf('autorio_operations","mine_entity"')
  const second = rcon.commands[0].indexOf('autorio_operations","wait"')
  assert.ok(first >= 0 && second > first)
  assert.match(rcon.commands[0], /local r1=\{remote\.call/)
  assert.match(rcon.commands[0], /local r2=\{remote\.call/)
})

test('mutation rejection, missing acknowledgement, and stale authorization fail closed without retries', async () => {
  const marker = 'AIRI_RESULT_0123456789abcdef01234567:'
  for (const raw of [
    `${marker}${JSON.stringify({ ok: false, result: 'stale npc actor epoch' })}`,
    `${marker}${JSON.stringify({ ok: true, result: false })}`,
    `${marker}${JSON.stringify({ ok: true, result: [false, 'no target'] })}`,
    'no acknowledgement here',
  ]) {
    const rcon = new FakeRcon([raw])
    await assert.rejects(() => executeAuthorizedOperation(rcon, 3, 'remote.call("autorio_operations","wait",60)', marker))
    assert.equal(rcon.commands.length, 1)
  }
})

test('batch rejection or missing acknowledgement fails closed without replaying admissions', async () => {
  const marker = 'AIRI_RESULT_0123456789abcdef01234567:'
  for (const raw of [
    `${marker}${JSON.stringify({ ok: false, result: 'autorio rejected operation 1' })}`,
    'no acknowledgement here',
  ]) {
    const rcon = new FakeRcon([raw])
    await assert.rejects(() => executeAuthorizedBatch(rcon, 3, [
      'remote.call("autorio_operations","wait",60)',
      'remote.call("autorio_operations","wait",60)',
    ], marker))
    assert.equal(rcon.commands.length, 1)
  }
})

test('operation renderer boundary rejects arbitrary Lua and control characters', () => {
  assert.equal(validatedOperationCall('remote.call("autorio_operations","wait",60)'), 'remote.call("autorio_operations","wait",60)')
  assert.throws(() => validatedOperationCall('game.clear()'))
  assert.throws(() => validatedOperationCall('remote.call("autorio_tools","get_inventory_items")'))
  assert.throws(() => validatedOperationCall('remote.call("autorio_operations","wait",60)\n/c game.clear()'))
})

test('actor epoch comparison ignores connected-player count but notices actor/epoch changes', () => {
  const first = readyStatus({ connected_players: 0 })
  assert.equal(actorChanged(first, readyStatus({ connected_players: 4 })), false)
  assert.equal(actorChanged(first, readyStatus({ actor_id: 42 })), true)
  assert.equal(actorChanged(first, readyStatus({ epoch: 4 })), true)
  assert.equal(actorChanged(first, readyStatus({ mode: 'player' })), true)
})
