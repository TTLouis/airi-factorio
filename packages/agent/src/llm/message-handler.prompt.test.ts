import { beforeEach, describe, expect, it, vi } from 'vitest'
import prompt from './prompt.md?raw'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock('neuri/openai', () => ({
  assistant: (content: string) => ({ role: 'assistant', content }),
  composeAgent: () => ({ call: mocks.call }),
  defineToolFunction: (_definition: unknown, fn: unknown) => ({ fn }),
  system: (content: string) => ({ role: 'system', content }),
  toolFunction: async (name: string, description: string, schema: unknown) => ({ name, description, schema }),
  user: (content: string) => ({ role: 'user', content }),
}))

vi.mock('../config', () => ({
  openaiConfig: {
    apiKey: 'test-key',
    baseUrl: 'http://provider.invalid/v1',
  },
}))

vi.mock('./tools', () => ({
  tools: [],
}))

import { createMessageHandler } from './message-handler'

function modelPlan(overrides: Record<string, unknown> = {}) {
  return {
    chatMessage: 'Working on it.',
    plan: ['Wait briefly'],
    currentStep: 0,
    operationCommands: ["remote.call('autorio_operations', 'wait', 3)"],
    ...overrides,
  }
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(modelPlan()) } }],
  })
})

describe('actual prompt/message harness', () => {
  it('sends the production prompt as the system message for a chat request', async () => {
    const handler = await createMessageHandler()

    await handler.handleMessage({
      type: 'chat',
      username: 'Louis',
      message: 'wait a moment',
      isServer: false,
      date: '2026-09-13',
    })

    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [messages, options] = mocks.call.mock.calls[0]
    expect(messages[0]).toEqual({ role: 'system', content: prompt })
    expect(messages[1]).toEqual({ role: 'user', content: '[CHAT] wait a moment' })
    expect(options).toMatchObject({ maxRoundTrip: 10 })
  })

  it('keeps the same system prompt and appends the completion event on continuation', async () => {
    const handler = await createMessageHandler()

    await handler.handleMessage({
      type: 'chat',
      username: 'Louis',
      message: 'wait a moment',
      isServer: false,
      date: '2026-09-13',
    })

    mocks.call.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(modelPlan({ operationCommands: [] })) } }],
    })

    await handler.handleMessage({
      type: 'operationsCompleted',
      serverTimestamp: '10.000',
    })

    expect(mocks.call).toHaveBeenCalledTimes(2)
    const [messages] = mocks.call.mock.calls[1]
    expect(messages[0]).toEqual({ role: 'system', content: prompt })
    expect(messages).toContainEqual({ role: 'user', content: '[MOD] All operations completed' })
    expect(messages.filter((message: { role: string }) => message.role === 'system')).toHaveLength(1)
  })

  it('formats mod errors as model-visible state without changing the system prompt', async () => {
    const handler = await createMessageHandler()

    await handler.handleMessage({
      type: 'modError',
      serverTimestamp: '12.000',
      error: 'No iron-ore found',
    })

    const [messages] = mocks.call.mock.calls[0]
    expect(messages[0]).toEqual({ role: 'system', content: prompt })
    expect(messages[1]).toEqual({ role: 'user', content: '[MOD] Error: No iron-ore found' })
  })
})
