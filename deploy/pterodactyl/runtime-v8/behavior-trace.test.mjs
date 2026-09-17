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
    this.batchId = 1
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18, kind: 'standalone_character' } })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'IDLE',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: {
          batch_id: this.batchId,
          task_count: 1,
          task_types: ['waiting'],
          tick: 100 + this.batchId,
        },
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

function withProviderUsage(message, usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 80 },
}) {
  Object.defineProperty(message, '_airiProvider', {
    configurable: true,
    enumerable: false,
    value: {
      response_id: 'resp-test',
      model: 'test-model',
      finish_reason: 'stop',
      usage,
    },
  })
  return message
}

test('behavior trace correlates request through verification, records usage, and redacts secrets', async t => {
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
    provider: async () => withProviderUsage(replies.shift()),
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

  const responses = rows.filter(row => row.event === 'provider.response')
  assert.equal(responses.length, 3)
  assert.deepEqual(responses[0].data.usage, {
    input_units: 100,
    cached_input_units: 80,
    cache_miss_input_units: 20,
    output_units: 20,
    total_units: 120,
  })
  const toolResultChars = rows
    .filter(row => row.event === 'tool.result')
    .reduce((total, row) => total + row.data.output_chars, 0)
  const completed = rows.find(row => row.event === 'request.completed')
  assert.deepEqual(completed.data.usage, {
    provider_calls: 3,
    input_units: 300,
    cached_input_units: 240,
    cache_miss_input_units: 60,
    output_units: 60,
    total_units: 360,
    tool_calls: 1,
    duplicate_tool_calls: 0,
    tool_result_chars: toolResultChars,
    coalesced_runtime_events: 0,
  })
})

test('duplicate completion receipts do not spend another provider call, while a new batch still does', async () => {
  const rcon = new FakeRcon()
  const replies = [
    planMessage([{ name: 'wait', args: { ticks: 1 } }]),
    planMessage([{ name: 'wait', args: { ticks: 1 } }], 'Continue.'),
    planMessage([], 'Verified complete.'),
  ]
  let providerCalls = 0
  const activity = []
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => {
      providerCalls++
      return replies.shift()
    },
    systemPrompt: 'NPC test prompt',
    traceFile: null,
    onActivity: (event, data) => activity.push({ event, data }),
  })

  await agent.request('wait twice', { sender: 'TTLouis' })
  assert.equal(providerCalls, 1)

  await agent.completed()
  assert.equal(providerCalls, 2)
  assert.equal(agent.active, true)

  const duplicate = await agent.completed()
  assert.equal(duplicate, null)
  assert.equal(providerCalls, 2)
  assert.ok(activity.some(entry => entry.event === 'factorio.event_coalesced' && entry.data.kind === 'completion'))

  rcon.batchId = 2
  await agent.completed()
  assert.equal(providerCalls, 3)
  assert.equal(agent.active, false)
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

  assert.equal(message._airiProvider.response_id, 'resp_123')
  assert.equal(message._airiProvider.model, 'test-model-v2')
  assert.equal(message._airiProvider.finish_reason, 'stop')
  assert.deepEqual(message._airiProvider.usage, { prompt_tokens: 12, completion_tokens: 4 })
  assert.equal(message._airiProvider.diagnostic_code, 'ok')
  assert.equal(message._airiProvider.content_chars, 2)
  assert.equal(message._airiProvider.content_utf8_bytes, 2)
  assert.equal(message._airiProvider.reasoning_content_chars, 0)
  assert.equal(message._airiProvider.tool_call_count, 0)
  assert.deepEqual(message._airiProvider.message_keys, ['content'])
  assert.deepEqual(message._airiProvider.structured_content, {
    json_valid: true,
    plan_valid: false,
    error: 'Invalid chatMessage',
  })
  assert.equal(Object.keys(message).includes('_airiProvider'), false)
  assert.equal(JSON.stringify(message), '{"content":"{}"}')
})
