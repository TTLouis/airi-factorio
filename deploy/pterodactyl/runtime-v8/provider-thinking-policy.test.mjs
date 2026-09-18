import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { providerRequest, selectReasoningPolicy } from './provider.mjs'

const VALID_PLAN = JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, operations: [] })
const COMPLETION = '[MOD] Autorio operation batch completed. Detailed task receipt: {"task_state":"completed"}'

function response(model = 'deepseek-flash') {
  return new Response(JSON.stringify({
    id: 'test-response',
    model,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: VALID_PLAN } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function config(overrides = {}) {
  return {
    key: 'test-key',
    model: 'deepseek-flash',
    base: 'https://proxy.example/v1',
    timeoutMs: 5000,
    ...overrides,
  }
}

async function captureRequest(messages, options = {}, providerConfig = config()) {
  let seen
  const message = await providerRequest(providerConfig, messages, {
    ...options,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body) }
      return response(providerConfig.model)
    },
  })
  return { seen, message }
}

test('successful deterministic completion continuation uses low effort with thinking enabled', async () => {
  const { seen, message } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: build a furnace' },
    { role: 'user', content: COMPLETION },
  ], { allowTools: true })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
  assert.equal(seen.body.max_tokens, 1000)
  assert.equal(message._airiProvider.reasoning_effort, 'low')
  assert.equal(message._airiProvider.reasoning_policy_reason, 'deterministic_completion')
})

test('new ordinary DeepSeek goal uses high effort', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: automate iron production' },
  ], { allowTools: true })

  assert.equal(seen.body.reasoning_effort, 'high')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
})

test('strict JSON recovery uses none and disables thinking', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[HARNESS] Invalid provider content JSON. Retry with strict JSON only and no tool calls.' },
  ], { allowTools: false, recoveryAttempt: 1 })

  assert.equal(seen.body.reasoning_effort, 'none')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
})

test('output-budget recovery preserves compact budget and disables thinking', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[HARNESS] continue after output budget exhaustion' },
  ], {
    allowTools: true,
    recoveryAttempt: 1,
    recoveryKind: 'output_budget_exhaustion',
  })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'none')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
  assert.equal(seen.body.max_tokens, 1000)
})

test('meaningful failure following a low continuation escalates the next planning turn to high', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the build' },
    { role: 'user', content: COMPLETION },
    { role: 'user', content: '[HARNESS] Tool-validation failure (1/3; invalid_tool_call): malformed observation tool arguments.' },
  ]
  assert.deepEqual(selectReasoningPolicy(config(), messages, { allowTools: true }), {
    effort: 'high',
    reason: 'ordinary_replan',
  })
  const { seen } = await captureRequest(messages, { allowTools: true })
  assert.equal(seen.body.reasoning_effort, 'high')
})

test('repeated meaningful failures can escalate a later planning turn to max', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the build' },
    { role: 'user', content: COMPLETION },
    { role: 'user', content: '[HARNESS] Tool-validation failure (1/3; invalid_tool_call): first failure.' },
    { role: 'assistant', content: VALID_PLAN },
    { role: 'user', content: '[HARNESS] Tool-validation failure (2/3; invalid_tool_call): second failure.' },
  ]
  const { seen } = await captureRequest(messages, { allowTools: true })
  assert.equal(seen.body.reasoning_effort, 'max')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
})

test('successful grounded execution de-escalates back to low after earlier failures', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: continue the build' },
    { role: 'user', content: '[MOD] Autorio operation error: first failure.' },
    { role: 'user', content: '[MOD] Autorio operation error: second failure.' },
    { role: 'user', content: COMPLETION },
  ]
  const { seen } = await captureRequest(messages, { allowTools: true })
  assert.equal(seen.body.reasoning_effort, 'low')
  assert.deepEqual(seen.body.thinking, { type: 'enabled' })
})

test('custom DeepSeek-compatible base URL keeps its endpoint while receiving model-gated reasoning policy', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect the factory' },
  ], { allowTools: true }, config({ model: 'deepseek/deepseek-v4-pro', base: 'https://gateway.example/custom/v1' }))

  assert.equal(seen.url, 'https://gateway.example/custom/v1/chat/completions')
  assert.equal(seen.body.reasoning_effort, 'high')
})

test('non-DeepSeek providers do not receive DeepSeek-specific request fields', async () => {
  const { seen } = await captureRequest([
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect the factory' },
  ], { allowTools: true }, config({ model: 'gpt-5.6', base: 'https://provider.example/v1' }))

  assert.equal(seen.body.reasoning_effort, undefined)
  assert.equal(seen.body.thinking, undefined)
})

test('provider prompt trace records selected effort and policy reason per call', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-reasoning-policy-'))
  const traceFile = path.join(dir, 'prompts.jsonl')
  try {
    await captureRequest([
      { role: 'system', content: 'system' },
      { role: 'user', content: '[CHAT] tester: plan a production line' },
    ], { allowTools: true, promptTraceFile: traceFile })

    const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const request = rows.find(row => row.event === 'provider.request')
    const result = rows.find(row => row.event === 'provider.response')
    assert.equal(request.reasoning_effort, 'high')
    assert.equal(request.reasoning_policy_reason, 'new_goal')
    assert.equal(request.payload.reasoning_effort, 'high')
    assert.deepEqual(request.payload.thinking, { type: 'enabled' })
    assert.equal(result.reasoning_effort, 'high')
    assert.equal(result.reasoning_policy_reason, 'new_goal')
  }
  finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
