import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { describe, expect, it, vi } from 'vitest'
import { find_long_range_entities, find_nearest_enemy } from './discovery'

type Filter = {
  position: { x: number, y: number }
  radius: number
  name: string
}

function make_entity(name: string, x: number, y = 0) {
  return {
    valid: true,
    name,
    type: 'resource',
    position: { x, y },
    force: { name: 'neutral' },
    amount: 1000,
  } as unknown as LuaEntity
}

function make_context(entities: LuaEntity[]) {
  const position = { x: 0, y: 0 }
  const in_filter = (entity: LuaEntity, filter: Filter) => {
    if (entity.name !== filter.name) return false
    const dx = entity.position.x - filter.position.x
    const dy = entity.position.y - filter.position.y
    return dx * dx + dy * dy <= filter.radius * filter.radius
  }

  const surface = {
    count_entities_filtered: vi.fn((filter: Filter) => entities.filter(entity => in_filter(entity, filter)).length),
    find_entities_filtered: vi.fn((filter: Filter) => entities.filter(entity => in_filter(entity, filter))),
    get_closest: vi.fn((origin: { x: number, y: number }, candidates: LuaEntity[]) => {
      let nearest: LuaEntity | undefined
      let best = Number.POSITIVE_INFINITY
      for (const candidate of candidates) {
        const dx = candidate.position.x - origin.x
        const dy = candidate.position.y - origin.y
        const distance = dx * dx + dy * dy
        if (distance < best) {
          nearest = candidate
          best = distance
        }
      }
      return nearest
    }),
    find_nearest_enemy: vi.fn(),
  }

  const actor = {
    is_valid: true,
    position,
    surface,
    force: { name: 'player', index: 1 },
  } as unknown as ControlledActor

  return { actor, surface }
}

describe('long-range discovery', () => {
  it('uses cheap engine counts while widening and materializes entities only once', () => {
    const { actor, surface } = make_context([
      make_entity('copper-ore', 400),
    ])

    const result = find_long_range_entities(actor, 'copper-ore', 1024, 1)

    expect(result.found).toBe(true)
    expect(result.entities).toHaveLength(1)
    expect(result.searched_radius).toBe(400)
    expect(surface.count_entities_filtered).toHaveBeenCalled()
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    expect(surface.find_entities_filtered).toHaveBeenCalledWith({
      position: { x: 0, y: 0 },
      radius: 400,
      name: 'copper-ore',
    })
    expect(surface.get_closest).toHaveBeenCalledTimes(1)
  })

  it('refines to the smallest radius containing the requested bounded result count', () => {
    const { actor, surface } = make_context([
      make_entity('iron-ore', 100),
      make_entity('iron-ore', 450),
      make_entity('iron-ore', 900),
    ])

    const result = find_long_range_entities(actor, 'iron-ore', 2048, 2)

    expect(result.searched_radius).toBe(450)
    expect(result.returned_count).toBe(2)
    expect(result.entities.map(entity => entity.position)).toEqual([
      { x: 100, y: 0 },
      { x: 450, y: 0 },
    ])
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    expect(surface.get_closest).toHaveBeenCalledTimes(2)
  })

  it('returns every available match when fewer than the requested limit exist inside max radius', () => {
    const { actor, surface } = make_context([
      make_entity('stone', 700),
      make_entity('stone', 1500),
      make_entity('stone', 5000),
    ])

    const result = find_long_range_entities(actor, 'stone', 2048, 8)

    expect(result.searched_radius).toBe(2048)
    expect(result.returned_count).toBe(2)
    expect(result.entities.map(entity => entity.position)).toEqual([
      { x: 700, y: 0 },
      { x: 1500, y: 0 },
    ])
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
  })

  it('does not construct entity wrappers when no target exists in the bounded range', () => {
    const { actor, surface } = make_context([
      make_entity('uranium-ore', 5000),
    ])

    const result = find_long_range_entities(actor, 'uranium-ore', 4096, 4)

    expect(result).toMatchObject({
      found: false,
      searched_radius: 4096,
      matched_count: 0,
      returned_count: 0,
      entities: [],
    })
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
    expect(surface.get_closest).not.toHaveBeenCalled()
  })

  it('uses Factorio native nearest-enemy search for distant hostile discovery', () => {
    const { actor, surface } = make_context([])
    const enemy = {
      valid: true,
      name: 'biter-spawner',
      type: 'unit-spawner',
      position: { x: -120, y: 90 },
      force: { name: 'enemy' },
      unit_number: 77,
      health: 350,
    } as unknown as LuaEntity
    surface.find_nearest_enemy.mockReturnValue(enemy)

    const result = find_nearest_enemy(actor, 2048)

    expect(surface.find_nearest_enemy).toHaveBeenCalledWith({
      position: { x: 0, y: 0 },
      max_distance: 2048,
      force: actor.force,
    })
    expect(result).toMatchObject({
      found: true,
      max_distance: 2048,
      entity: {
        name: 'biter-spawner',
        type: 'unit-spawner',
        position: { x: -120, y: 90 },
        distance: 150,
        unit_number: 77,
      },
    })
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('bounds nearest-enemy discovery and reports no target without broad entity scans', () => {
    const { actor, surface } = make_context([])
    surface.find_nearest_enemy.mockReturnValue(undefined)

    const result = find_nearest_enemy(actor, 99999)

    expect(surface.find_nearest_enemy).toHaveBeenCalledWith({
      position: { x: 0, y: 0 },
      max_distance: 4096,
      force: actor.force,
    })
    expect(result).toEqual({
      found: false,
      actor_position: { x: 0, y: 0 },
      max_distance: 4096,
    })
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
  })
})
