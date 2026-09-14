import test from 'node:test'
import assert from 'node:assert/strict'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

function deployment(actorId = 18, epoch = 3) {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: actorId,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  constructor() {
    this.status = deployment()
    this.commands = []
    this.mutations = []
    this.onCommand = null
  }

  async command(text) {
    this.commands.push(text)
    if (this.onCommand) await this.onCommand(text, this)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_actor","status")')) {
      return JSON.stringify({
        mode: 'npc',
        connected_players: this.status.connected_players,
        actor: { actor_id: this.status.actor_id, kind: 'standalone_character', valid: true, has_character: true },
        load_reconciliation: { pending: false, last_actor_id: this.status.actor_id },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      return `${marker}${JSON.stringify({ ok: true, result: [true, 'Task started'] })}`
    }
    return 'tool-output'
  }
}

function toolMessage(id, name, args = {}) {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function planMessage(operations, chatMessage = 'Working.') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: operations.length ? ['Perform bounded step'] : ['Done'],
      currentStep: 0,
      operations,
    }),
  }
}

test('scripted provider can observe actor then submit an epoch-authorized structured operation', async () => {
  const rcon = new FakeRcon()
  const providerMessages = [
    toolMessage('tool-1', 'getActorStatus'),
    planMessage([{ name: 'wait', args: { ticks: 60 } }]),
  ]
  const provider = async () => providerMessages.shift()
  const reservations = []
  const agent = new NpcAgentLoop({
    rcon,
    provider,
    systemPrompt: 'NPC test prompt',
    reserve: async value => reservations.push(value),
  })

  const result = await agent.request('wait briefly')

  assert.equal(result.actorId, 18)
  assert.equal(result.epoch, 3)
  assert.equal(result.operations[0].name, 'wait')
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /airi_deployment","authorize",3/)
  assert.match(rcon.mutations[0], /autorio_operations','wait',60/)
  assert.equal(reservations.length, 2)
  assert.ok(agent.messages.some(message => message.role === 'tool'))
})

test('actor replacement during tool observation cancels the stale model turn before mutation', async () => {
  const rcon = new FakeRcon()
  rcon.onCommand = async (text, transport) => {
    if (text.includes('remote.call("autorio_actor","status")')) {
      transport.status = deployment(42, 4)
    }
  }
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => toolMessage('tool-1', 'getActorStatus'),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(() => agent.request('inspect actor'), /epoch changed/)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(agent.active, false)
})

test('entire structured operation batch is validated before the first world mutation', async () => {
  const rcon = new FakeRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => planMessage([
      { name: 'wait', args: { ticks: 60 } },
      { name: 'game.clear', args: {} },
    ]),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(() => agent.request('bad batch'), /Unapproved operation/)
  assert.equal(rcon.mutations.length, 0)
})

test('actor replacement caused by an earlier operation prevents later operations inheriting the new body', async () => {
  const rcon = new FakeRcon()
  rcon.onCommand = async (text, transport) => {
    if (text.includes('local ok,result=pcall') && transport.mutations.length === 0) {
      // The operation acknowledgement still belongs to actor 18, but subsequent
      // status observation sees recovery actor 42 / epoch 4.
      queueMicrotask(() => { transport.status = deployment(42, 4) })
    }
  }
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => planMessage([
      { name: 'wait', args: { ticks: 60 } },
      { name: 'wait', args: { ticks: 60 } },
    ]),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(() => agent.request('two steps'), /epoch changed/)
  assert.equal(rcon.mutations.length, 1)
})

test('completion continuation stays on the captured actor and is bounded', async () => {
  const rcon = new FakeRcon()
  const messages = [
    planMessage([{ name: 'wait', args: { ticks: 1 } }]),
    planMessage([], 'Verified complete.'),
  ]
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => messages.shift(),
    systemPrompt: 'NPC test prompt',
  })

  await agent.request('do a tiny task')
  assert.equal(agent.active, true)
  const final = await agent.completed()
  assert.equal(final.chatMessage, 'Verified complete.')
  assert.equal(agent.active, false)
  assert.ok(agent.messages.some(message => message.role === 'user' && message.content === '[MOD] All operations completed'))
})

test('malformed tool arguments and arbitrary tool names fail before RCON tool execution', async () => {
  for (const message of [
    toolMessage('tool-1', 'shell', {}),
    { content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'getRecipe', arguments: '{bad' } }] },
  ]) {
    const rcon = new FakeRcon()
    const baseline = rcon.commands.length
    const agent = new NpcAgentLoop({ rcon, provider: async () => message, systemPrompt: 'NPC test prompt' })
    await assert.rejects(() => agent.request('bad tool'))
    assert.equal(rcon.mutations.length, 0)
    assert.ok(rcon.commands.length > baseline) // status checks are allowed
    assert.equal(rcon.commands.some(command => command.includes('autorio_tools')), false)
  }
})
