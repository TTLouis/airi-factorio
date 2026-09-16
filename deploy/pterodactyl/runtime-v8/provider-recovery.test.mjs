import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeProviderPlanContent, providerRequest } from './provider.mjs'

const config = {
  base: 'https://api.example.test/v1',
  key: 'test-key-1234',
  model: 'test-model',
}
const messages = [{ role: 'user', content: 'hello' }]

function hangingFetch(_url, { signal }) {
  return new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 10000)
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive)
      reject(signal.reason)
    }, { once: true })
  })
}

function successfulFetch(captured) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function contentFetch(content) {
  return async () => new Response(JSON.stringify({
    id: 'resp-recovery',
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('provider timeout reports an explicit error instead of leaving the turn active', async () => {
  await assert.rejects(
    () => providerRequest({ ...config, timeoutMs: 1000 }, messages, { fetchImpl: hangingFetch }),
    /Provider timed out after 1000 ms/,
  )
})

test('external cancellation aborts an in-flight provider request', async () => {
  const controller = new AbortController()
  const pending = providerRequest({ ...config, timeoutMs: 5000 }, messages, {
    fetchImpl: hangingFetch,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(() => pending, /Provider request cancelled/)
})

test('recovery requests can disable the tool surface completely', async () => {
  const captured = []
  await providerRequest(config, messages, { fetchImpl: successfulFetch(captured), allowTools: false })
  assert.equal(captured.length, 1)
  assert.equal('tools' in captured[0], false)
  assert.equal('tool_choice' in captured[0], false)

  await providerRequest(config, messages, { fetchImpl: successfulFetch(captured), allowTools: true })
  assert.ok(Array.isArray(captured[1].tools))
  assert.equal(captured[1].tool_choice, 'auto')
})

test('provider strips a single JSON markdown fence before strict plan parsing', async () => {
  const plan = '{"chatMessage":"","plan":["continue"],"currentStep":0,"operations":[]}'
  const message = await providerRequest(config, messages, {
    fetchImpl: contentFetch(`\`\`\`json\n${plan}\n\`\`\``),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(message.content, plan)
})

test('provider extracts one unambiguous plan object from harmless prose', async () => {
  const plan = '{"chatMessage":"继续","plan":["继续"],"currentStep":0,"operations":[]}'
  const message = await providerRequest(config, messages, {
    fetchImpl: contentFetch(`Here is the requested JSON:\n${plan}\n`),
    allowTools: false,
    recoveryAttempt: 1,
  })
  assert.equal(message.content, plan)
})

test('normalizer refuses to guess when provider content contains multiple top-level objects', () => {
  const content = 'first {"a":1} second {"b":2}'
  assert.equal(normalizeProviderPlanContent(content), content)
})
