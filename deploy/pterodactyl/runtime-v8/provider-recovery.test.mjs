import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeProviderPlanContent, providerRequest } from './provider.mjs'

const config = {
  base: 'https://api.example.test/v1',
  key: 'test-key-1234',
  model: 'test-model',
}
const messages = [{ role: 'user', content: 'hello' }]
const completionMessages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
]

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

function lengthExhaustedFetch(captured = []) {
  return async (_url, options) => {
    captured.push(JSON.parse(options.body))
    return new Response(JSON.stringify({
      id: 'resp-length',
      model: 'test-model',
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'hidden reasoning' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
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

test('official DeepSeek completion continuation disables thinking without changing ordinary requests globally', async () => {
  const captured = []
  await providerRequest({ ...config, base: 'https://api.deepseek.com/v1' }, completionMessages, {
    fetchImpl: successfulFetch(captured),
  })
  assert.deepEqual(captured[0].thinking, { type: 'disabled' })
  assert.equal(captured[0].max_tokens, 1000)

  await providerRequest({ ...config, base: 'https://api.deepseek.com/v1' }, messages, {
    fetchImpl: successfulFetch(captured),
  })
  assert.equal('thinking' in captured[1], false)
  assert.equal(captured[1].max_tokens, 2000)
})

test('unknown OpenAI-compatible completion continuation avoids provider-private fields and uses bounded fallback cap', async () => {
  const captured = []
  await providerRequest(config, completionMessages, { fetchImpl: successfulFetch(captured) })
  assert.equal('thinking' in captured[0], false)
  assert.equal(captured[0].max_tokens, 4000)
})

test('completion provider contract advertises candidate-id execution alongside placement candidates', async () => {
  const captured = []
  await providerRequest(config, completionMessages, { fetchImpl: successfulFetch(captured) })
  assert.ok(captured[0].tools.some(tool => tool?.function?.name === 'getPlacementCandidates'))
  assert.ok(captured[0].messages.some(message => String(message?.content ?? '').includes('place_candidate {candidate_set_id,candidate_id}')))
  assert.ok(captured[0].messages.some(message => String(message?.content ?? '').includes('do not copy candidate coordinates into place_entity')))
})

test('empty length response with no tool calls is classified as output-budget exhaustion', async () => {
  const message = await providerRequest(config, completionMessages, { fetchImpl: lengthExhaustedFetch() })
  assert.equal(message._airiProvider.diagnostic_code, 'provider_output_budget_exhausted')
  assert.equal(message._airiProvider.output_budget_exhausted, true)
  assert.equal(message._airiProvider.finish_reason, 'length')
  assert.equal(message._airiProvider.tool_call_count, 0)
  assert.equal(message._airiProvider.content_chars, 0)
})

test('output-budget recovery keeps continuation budget policy when explicitly classified', async () => {
  const captured = []
  await providerRequest(config, [
    ...completionMessages,
    { role: 'user', content: '[HARNESS] Retry after output budget exhaustion with tools available.' },
  ], {
    fetchImpl: successfulFetch(captured),
    recoveryAttempt: 1,
    recoveryKind: 'output_budget_exhaustion',
    allowTools: true,
  })
  assert.equal(captured[0].max_tokens, 4000)
  assert.ok(Array.isArray(captured[0].tools))
  assert.equal(captured[0].tool_choice, 'auto')
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

test('normalizer extracts the final strict plan after reasoning JSON', () => {
  const plan = '{"chatMessage":"","plan":["continue"],"currentStep":0,"operations":[]}'
  assert.equal(normalizeProviderPlanContent(`thinking {"candidate":1}\n${plan}`), plan)
})

test('normalizer prefers the last valid plan candidate', () => {
  const draft = '{"chatMessage":"draft","plan":["draft"],"currentStep":0,"operations":[]}'
  const finalPlan = '{"chatMessage":"final","plan":[],"currentStep":0,"operations":[]}'
  assert.equal(normalizeProviderPlanContent(`draft ${draft}\nreason {"x":2}\nfinal ${finalPlan}`), finalPlan)
})

test('normalizer does not accept plan-like JSON that fails strict schema', () => {
  const invalid = '{"chatMessage":"x","plan":[],"currentStep":0,"operations":[],"reasoning":"no"}'
  assert.equal(normalizeProviderPlanContent(invalid), invalid)
})

test('normalizer validates operations through the plan policy', () => {
  const valid = '{"chatMessage":"","plan":["wait"],"currentStep":0,"operations":[{"name":"wait","args":{"ticks":60}}]}'
  const invalid = '{"chatMessage":"","plan":["bad"],"currentStep":0,"operations":[{"name":"shell","args":{}}]}'
  assert.equal(normalizeProviderPlanContent(`reason {"x":1}\n${valid}`), valid)
  assert.equal(normalizeProviderPlanContent(invalid), invalid)
})
