import { describe, expect, it } from 'vitest'
import { parseLLMMessage } from '../parser'

function baseResponse(overrides: Record<string, unknown> = {}) {
  return {
    chatMessage: 'Working on it.',
    plan: ['Wait briefly'],
    currentStep: 0,
    ...overrides,
  }
}

describe('LLM structured operation compatibility', () => {
  it('keeps approved legacy operationCommands responses working', () => {
    const operationCommands = ["remote.call('autorio_operations', 'wait', 3)"]
    const parsed = parseLLMMessage(JSON.stringify(baseResponse({ operationCommands })))

    expect(parsed.operationCommands).toEqual(operationCommands)
    expect(parsed.operations).toBeUndefined()
  })

  it('rejects arbitrary Lua in the legacy compatibility field', () => {
    expect(() => parseLLMMessage(JSON.stringify(baseResponse({
      operationCommands: ["remote.call('autorio_operations', 'wait', 3); game.clear()"],
    })))).toThrow(/approved Autorio call/)
  })

  it('validates and renders structured operations into the existing execution path', () => {
    const parsed = parseLLMMessage(JSON.stringify(baseResponse({
      operations: [
        { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 50 } },
        { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 8 } },
      ],
    })))

    expect(parsed.operations).toEqual([
      { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 50 } },
      { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 8 } },
    ])
    expect(parsed.operationCommands).toEqual([
      "remote.call('autorio_operations', 'walk_to_entity', 'iron-ore', 50)",
      "remote.call('autorio_operations', 'mine_entity', 'iron-ore', 8)",
    ])
  })

  it('rejects ambiguous responses containing both action formats', () => {
    expect(() => parseLLMMessage(JSON.stringify(baseResponse({
      operationCommands: [],
      operations: [],
    })))).toThrow(/exactly one/)
  })

  it('rejects responses with no executable action field', () => {
    expect(() => parseLLMMessage(JSON.stringify(baseResponse()))).toThrow(/exactly one/)
  })

  it('rejects unapproved structured operation names before execution', () => {
    expect(() => parseLLMMessage(JSON.stringify(baseResponse({
      operations: [
        { name: 'game.clear', args: {} },
      ],
    })))).toThrow()
  })

  it('rejects a currentStep that does not point at an existing plan step', () => {
    expect(() => parseLLMMessage(JSON.stringify(baseResponse({
      currentStep: 2,
      operations: [],
    })))).toThrow(/existing plan step/)
  })
})
