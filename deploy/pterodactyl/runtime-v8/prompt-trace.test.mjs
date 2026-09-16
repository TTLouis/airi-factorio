import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { providerRequest } from './provider.mjs'

function fakeProviderResponse() {
  return new Response(JSON.stringify({
    id: 'resp-prompt-trace',
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const config = {
  base: 'https://provider.example/v1',
  key: 'test-key',
  model: 'test-model',
  timeoutMs: 5000,
}

test('prompt trace records the exact final provider body after continuation compaction and steering', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-prompt-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  let sentBody
  const fetchImpl = async (_url, options) => {
    sentBody = JSON.parse(options.body)
    return fakeProviderResponse()
  }

  await providerRequest(config, [
    { role: 'system', content: 'FULL SYSTEM PROMPT '.repeat(200) },
    { role: 'user', content: '[PLAN_STATE] Harness-owned durable goal/plan state.\n{"goal_id":"goal_1","objective":"continue factory","status":"active","plan":["continue factory"],"current_step":0,"revision":2}' },
    { role: 'user', content: '[CHAT] TTLouis: continue factory' },
    { role: 'assistant', content: '{"chatMessage":"","plan":["continue factory"],"currentStep":0,"operations":[{"name":"wait","args":{"ticks":1}}]}' },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {"task_state":"IDLE","queue_empty":true,"queue_length":0,"last_completed_batch":{"batch_id":4,"task_count":1,"task_types":["waiting"],"tick":100}}' },
  ], {
    fetchImpl,
    allowTools: true,
    recoveryAttempt: 0,
    round: 6,
    epoch: 3,
    actorId: 18,
    promptTraceFile,
  })

  const raw = await fsp.readFile(promptTraceFile, 'utf8')
  const rows = raw.trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.round, 6)
  assert.equal(row.actor_id, 18)
  assert.equal(row.epoch, 3)
  assert.equal(row.trigger_source, 'completion')
  assert.equal(row.recovery_attempt, 0)
  assert.equal(row.allow_tools, true)
  assert.deepEqual(row.payload, sentBody)
  assert.equal(row.stats.body_chars, JSON.stringify(sentBody).length)
  assert.equal(row.stats.message_count, sentBody.messages.length)
  assert.equal(row.stats.tool_count, sentBody.tools.length)
  assert.equal(row.payload.max_tokens, 1000)
  assert.match(row.payload.messages[0].content, /Token-efficient continuation rules/)
  assert.ok(row.payload.messages.some(message => typeof message.content === 'string' && message.content.startsWith('[STEERING]')))
  assert.equal((await fsp.stat(promptTraceFile)).mode & 0o777, 0o600)
})

test('prompt trace redacts common secrets without redacting max_tokens', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-prompt-redaction-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const promptTraceFile = path.join(dir, 'airi-prompts.jsonl')
  const fetchImpl = async () => fakeProviderResponse()

  await providerRequest(config, [
    { role: 'system', content: 'NPC test prompt' },
    { role: 'user', content: '[CHAT] TTLouis: inspect Bearer abcdefghijklmnop and OPENAI_API_KEY=sk-abcdefghijklmnop' },
  ], {
    fetchImpl,
    allowTools: false,
    recoveryAttempt: 0,
    round: 1,
    epoch: 9,
    actorId: 21,
    promptTraceFile,
  })

  const raw = await fsp.readFile(promptTraceFile, 'utf8')
  assert.doesNotMatch(raw, /abcdefghijklmnop/)
  assert.match(raw, /\[REDACTED\]/)
  const row = JSON.parse(raw.trim())
  assert.equal(row.payload.max_tokens, 2000)
  assert.equal(row.trigger_source, 'request')
})
