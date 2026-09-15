import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'

function deployment(actorId = 18, epoch = 3) {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: actorId,
    actor_kind: 'standalone_character',
    connected_players: 1,
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
    this.mutations = []
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18, kind: 'standalone_character' } })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'IDLE',
        queue_length: 0,
        basic_operation: { last_result: { operation_id: 9, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      const admissions = [...text.matchAll(/local r\d+=remote\.call/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function toolMessage() {
  return {
    content: null,
    tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'getActorStatus', arguments: '{}' } }],
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

test('behavior trace correlates request through verification and redacts secrets', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-behavior-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const traceFile = path.join(dir, 'airi-behavior.jsonl')
  const replies = [
    toolMessage(),
    planMessage([{ name: 'wait', args: { ticks: 1 } }]),
    planMessage([], 'Verified complete.'),
  ]
  let budgetCount = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => replies.shift(),
    reserve: async () => ({ count: ++budgetCount, token: 'budget-secret-token' }),
    systemPrompt: 'NPC test prompt',
    traceFile,
  })

  await agent.request('inspect Bearer abcdefghijklmnop then wait', { sender: 'TTLouis' })
  await agent.completed()

  const raw = await fsp.readFile(traceFile, 'utf8')
  const rows = raw.trim().split('\n').map(JSON.parse)
  const events = rows.map(row => row.event)
  for (const event of [
    'request.received',
    'actor.bound',
    'budget.reserved',
    'provider.request',
    'provider.response',
    'tool.call',
    'tool.result',
    'plan.accepted',
    'operations.ack',
    'factorio.completed_signal',
    'factorio.status',
    'request.completed',
  ]) assert.ok(events.includes(event), `missing ${event}`)

  assert.equal(new Set(rows.map(row => row.request_id)).size, 1)
  assert.doesNotMatch(raw, /budget-secret-token/)
  assert.doesNotMatch(raw, /Bearer abcdefghijklmnop/)
  assert.match(raw, /\[REDACTED\]/)
  assert.match(raw, /operation_id\\?":9/)
})

test('provider response metadata is available to tracing without changing assistant JSON', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    id: 'resp_123',
    model: 'test-model-v2',
    usage: { prompt_tokens: 12, completion_tokens: 4 },
    choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const message = await providerRequest({
    base: 'https://api.example.test/v1',
    key: 'test-key-1234',
    model: 'test-model',
  }, [{ role: 'user', content: 'hello' }], { fetchImpl, allowTools: false })

  assert.deepEqual(message._airiProvider, {
    response_id: 'resp_123',
    model: 'test-model-v2',
    finish_reason: 'stop',
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  })
  assert.equal(Object.keys(message).includes('_airiProvider'), false)
  assert.equal(JSON.stringify(message), '{"content":"{}"}')
})
