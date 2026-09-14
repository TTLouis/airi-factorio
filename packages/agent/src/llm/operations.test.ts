import { describe, expect, it } from 'vitest'
import { parseStructuredOperations, renderStructuredOperation, renderStructuredOperations } from './operations'

describe('structured Autorio operations', () => {
  it('normalizes optional defaults while validating operation shape', () => {
    const operations = parseStructuredOperations([
      { name: 'mine_entity', args: { entity_name: 'iron-ore' } },
      { name: 'attack_nearest_enemy', args: {} },
    ])

    expect(operations).toEqual([
      { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } },
      { name: 'attack_nearest_enemy', args: { search_radius: 50 } },
    ])
  })

  it('rejects unknown operations and unexpected arguments', () => {
    expect(() => parseStructuredOperations([
      { name: 'game.clear', args: {} },
    ])).toThrow()

    expect(() => parseStructuredOperations([
      { name: 'wait', args: { ticks: 60, arbitrary_lua: 'game.clear()' } },
    ])).toThrow()
  })

  it('bounds operation batches plus navigation and combat scans', () => {
    const operations = Array.from({ length: 17 }, () => ({
      name: 'wait',
      args: { ticks: 1 },
    }))

    expect(() => parseStructuredOperations(operations)).toThrow()
    expect(() => parseStructuredOperations([
      { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 257 } },
    ])).toThrow()
    expect(parseStructuredOperations([
      { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 256 } },
    ])[0]).toEqual({ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 256 } })
    expect(() => parseStructuredOperations([
      { name: 'attack_nearest_enemy', args: { search_radius: 257 } },
    ])).toThrow()
    expect(parseStructuredOperations([
      { name: 'attack_nearest_enemy', args: { search_radius: 256 } },
    ])[0]).toEqual({ name: 'attack_nearest_enemy', args: { search_radius: 256 } })
  })

  it('renders validated operations into the existing Autorio remote-call format', () => {
    expect(renderStructuredOperations([
      { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 50 } },
      { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 8 } },
      { name: 'move_items', args: { item_name: 'iron-plate', entity_name: 'stone-furnace', max_count: 50, to_entity: true } },
    ])).toEqual([
      "remote.call('autorio_operations', 'walk_to_entity', 'iron-ore', 50)",
      "remote.call('autorio_operations', 'mine_entity', 'iron-ore', 8)",
      "remote.call('autorio_operations', 'move_items', 'iron-plate', 'stone-furnace', 50, true)",
    ])
  })

  it('escapes strings before rendering Lua', () => {
    const [operation] = parseStructuredOperations([
      { name: 'place_entity', args: { entity_name: "mod's-entity" } },
    ])

    expect(renderStructuredOperation(operation)).toBe(
      "remote.call('autorio_operations', 'place_entity', 'mod\\'s-entity')",
    )
  })
})
