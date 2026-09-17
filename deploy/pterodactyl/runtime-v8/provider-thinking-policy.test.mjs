import assert from 'node:assert/strict'
import test from 'node:test'

import { providerRequest } from './provider.mjs'

const VALID_PLAN = JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, operations: [] })

function response() {
  return new Response(JSON.stringify({
    id: 'test-response',
    model: 'deepseek-flash',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: VALID_PLAN } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function config() {
  return {
    key: 'test-key',
    model: 'deepseek-flash',
    base: 'https://proxy.example/v1',
    timeoutMs: 5000,
  }
}

test('output-budget recovery disables thinking behind a custom DeepSeek-compatible base URL', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) }
    return response()
  }

  await providerRequest(config(), [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[HARNESS] continue after output budget exhaustion' },
  ], {
    fetchImpl,
    allowTools: true,
    recoveryAttempt: 1,
    recoveryKind: 'output_budget_exhaustion',
  })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
  assert.equal(seen.body.max_tokens, 1000)
})

test('strict JSON recovery disables thinking without changing the configured endpoint', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) }
    return response()
  }

  await providerRequest(config(), [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[HARNESS] Invalid provider content JSON. Retry with strict JSON only and no tool calls.' },
  ], {
    fetchImpl,
    allowTools: false,
    recoveryAttempt: 1,
  })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
})

test('ordinary DeepSeek request does not force no-thinking mode', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) }
    return response()
  }

  await providerRequest(config(), [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] tester: inspect the factory' },
  ], { fetchImpl, allowTools: true })

  assert.equal(seen.url, 'https://proxy.example/v1/chat/completions')
  assert.equal(seen.body.thinking, undefined)
})
