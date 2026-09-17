import { beforeEach, describe, expect, it } from 'vitest'

import {
  current_provider_model,
  provider_button_sprite,
  provider_button_tooltip,
  remember_provider_model,
  task_board_provider_of,
} from './task_board_provider'

const store = (globalThis as any).storage as Record<string, any>

describe('provider avatar selection', () => {
  beforeEach(() => {
    delete store.airi_task_board_provider_model
  })

  it('maps the vendor naming each provider actually ships', () => {
    expect(task_board_provider_of('deepseek-chat').id).toBe('deepseek')
    expect(task_board_provider_of('deepseek-reasoner').id).toBe('deepseek')
    expect(task_board_provider_of('claude-sonnet-4-5').id).toBe('claude')
    expect(task_board_provider_of('anthropic/claude-opus-4-1').id).toBe('claude')
    expect(task_board_provider_of('gpt-4o-mini').id).toBe('openai')
    expect(task_board_provider_of('openai/o3-mini').id).toBe('openai')
  })

  it('reads case-insensitively, the way model identifiers are typed', () => {
    expect(task_board_provider_of('DeepSeek-V3').id).toBe('deepseek')
    expect(task_board_provider_of('Claude-Haiku').id).toBe('claude')
  })

  it('falls back to the AIRI avatar for an unknown or missing model', () => {
    expect(task_board_provider_of('').id).toBe('airi')
    expect(task_board_provider_of(undefined).id).toBe('airi')
    expect(task_board_provider_of('replace-me').id).toBe('airi')
    expect(task_board_provider_of('llama-3.3-70b').id).toBe('airi')
  })

  // A proxy or router prefix puts a second vendor word in the identifier. The
  // model that actually answers is the one on the right of the path.
  it('resolves a routed identifier to the vendor that answers', () => {
    expect(task_board_provider_of('openai-compatible/deepseek-chat').id).toBe('deepseek')
    expect(task_board_provider_of('my-openai-proxy/claude-sonnet-4-5').id).toBe('claude')
  })

  it('keeps the last known model when a snapshot reports none', () => {
    remember_provider_model('deepseek-chat')
    remember_provider_model('')
    remember_provider_model(undefined)
    expect(current_provider_model()).toBe('deepseek-chat')
    expect(provider_button_sprite('item/logistic-robot')).toBe('airi-provider-deepseek')
  })

  it('names the provider and the exact model in the button tooltip', () => {
    remember_provider_model('claude-sonnet-4-5')
    expect(provider_button_tooltip('AIRI NPC Console')).toBe('AIRI NPC Console\nClaude · claude-sonnet-4-5')
  })

  it('leaves the tooltip alone until a model has been reported', () => {
    expect(provider_button_tooltip('AIRI NPC Console')).toBe('AIRI NPC Console')
    expect(provider_button_sprite('item/logistic-robot')).toBe('airi-provider-airi')
  })
})
