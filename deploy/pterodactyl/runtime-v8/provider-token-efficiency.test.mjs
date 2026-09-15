import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compactCompletionMessages,
  compactCompletionTools,
  providerRequest,
} from './provider.mjs'
import { toolDefinitions } from './structured-policy.mjs'

function fakeProviderResponse() {
  return new Response(JSON.stringify({
    id: 'resp-test',
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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

test('successful operation completion uses compact system prompt and lower output budget', async () => {
  let body
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body)
    return fakeProviderResponse()
  }

  await providerRequest(config, [
    { role: 'system', content: 'FULL SYSTEM PROMPT '.repeat(500) },
    { role: 'user', content: '[PLAN_STATE] current task' },
    { role: 'assistant', content: '{"chatMessage":"working","plan":["gather"],"currentStep":0,"operations":[{"name":"gather_resource","args":{"resource_name":"iron-ore","count":20,"search_radius":256}}]}' },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
  ], { fetchImpl, allowTools: true, recoveryAttempt: 0 })

  assert.equal(body.max_tokens, 1000)
  assert.notEqual(body.messages[0].content, 'FULL SYSTEM PROMPT '.repeat(500))
  assert.match(body.messages[0].content, /Token-efficient continuation rules/)
  assert.match(body.messages[0].content, /deterministic_verification/)
  assert.equal(body.tools.length, toolDefinitions.length)
  assert.ok(body.tools.every(tool => !tool.function?.description || tool.function.description.length <= 120))
})

test('initial requests and recovery attempts retain the full prompt and full output budget', async () => {
  const bodies = []
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return fakeProviderResponse()
  }
  const fullPrompt = 'FULL SYSTEM PROMPT '.repeat(100)

  await providerRequest(config, [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: '[CHAT] TTLouis: gather iron' },
  ], { fetchImpl, allowTools: true, recoveryAttempt: 0 })

  await providerRequest(config, [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
  ], { fetchImpl, allowTools: false, recoveryAttempt: 1 })

  for (const body of bodies) {
    assert.equal(body.max_tokens, 2000)
    assert.equal(body.messages[0].content, fullPrompt)
  }
})

test('compact helpers do not mutate the canonical messages or tool registry', () => {
  const messages = [{ role: 'system', content: 'original' }, { role: 'user', content: 'continuation' }]
  const compactMessages = compactCompletionMessages(messages)
  assert.equal(messages[0].content, 'original')
  assert.notEqual(compactMessages[0].content, 'original')

  const firstDescription = toolDefinitions[0]?.function?.description
  const compactTools = compactCompletionTools(toolDefinitions)
  assert.equal(toolDefinitions[0]?.function?.description, firstDescription)
  assert.equal(compactTools.length, toolDefinitions.length)
})
