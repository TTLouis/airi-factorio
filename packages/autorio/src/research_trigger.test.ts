import { beforeEach, describe, expect, it } from 'vitest'
import { research_trigger_summary, with_research_trigger } from './research_trigger'

beforeEach(() => {
  ;(globalThis as any).prototypes.technology = {}
})

describe('research trigger knowledge', () => {
  it('exposes exact craft-item item and count instead of only the trigger type', () => {
    ;(globalThis as any).prototypes.technology['steam-power'] = {
      research_trigger: { type: 'craft-item', item: 'iron-plate', count: 50 },
    }
    expect(research_trigger_summary('steam-power')).toEqual({
      type: 'craft-item',
      item: 'iron-plate',
      count: 50,
    })
    expect(with_research_trigger('steam-power', { found: true, name: 'steam-power', trigger_type: 'craft-item' })).toMatchObject({
      research_trigger: { type: 'craft-item', item: 'iron-plate', count: 50 },
    })
  })

  it('passes through lab research without inventing a trigger', () => {
    ;(globalThis as any).prototypes.technology.automation = { research_trigger: undefined }
    expect(with_research_trigger('automation', { found: true, name: 'automation' })).toEqual({ found: true, name: 'automation' })
  })
})
