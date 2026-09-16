import type { LuaEntity, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspect_charted_entity, is_position_charted, query_charted_entities, set_charted_machine_recipe } from './map_remote'

function make_surface(index = 1, name = 'nauvis') {
  return {
    index,
    name,
    valid: true,
    find_entities_filtered: vi.fn(() => []),
  } as unknown as LuaSurface
}

function make_actor(surface: LuaSurface, charted: Set<string>) {
  const force = {
    index: 1,
    name: 'player',
    recipes: {},
    is_chunk_charted: vi.fn((_surface: LuaSurface, chunk: { x: number, y: number }) => charted.has(`${chunk.x},${chunk.y}`)),
  }
  return {
    is_valid: true,
    surface,
    force,
    position: { x: 0, y: 0 },
    status_snapshot: () => ({ kind: 'standalone_character', valid: true, name: 'AIRI', position: { x: 0, y: 0 }, has_character: true }),
  } as unknown as ControlledActor
}

function make_entity(surface: LuaSurface, overrides: Partial<LuaEntity> = {}) {
  const entity = {
    valid: true,
    name: 'assembling-machine-1',
    type: 'assembling-machine',
    position: { x: 10, y: 10 },
    surface,
    force: { index: 1, name: 'player' },
    unit_number: 42,
    direction: 0,
    health: 300,
    operable: true,
    prototype: { crafting_categories: { crafting: true } },
    get_recipe: vi.fn(() => [undefined, 0.15]),
    set_recipe: vi.fn(),
    ...overrides,
  }
  return entity as unknown as LuaEntity
}

beforeEach(() => {
  ;(globalThis as any).game.get_surface = vi.fn()
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn()
  ;(globalThis as any).game.tick = 1234
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {}
})

describe('map-first remote control', () => {
  it('uses force chart visibility as the map knowledge boundary', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0', '-1,0']))

    expect(is_position_charted(actor, surface, { x: 1, y: 1 })).toBe(true)
    expect(is_position_charted(actor, surface, { x: -1, y: 1 })).toBe(true)
    expect(is_position_charted(actor, surface, { x: 64, y: 64 })).toBe(false)
  })

  it('refuses map queries when none of the requested chunks are charted', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set())
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = query_charted_entities(actor, 1, 256, 256, 16, 8)

    expect(result).toMatchObject({
      ok: false,
      code: 'area_uncharted',
      entities: [],
      charted_chunks: 0,
    })
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('filters returned entities to charted chunks even for a partially charted area', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    const visible = make_entity(surface, { position: { x: 8, y: 8 }, unit_number: 1 })
    const hidden = make_entity(surface, { position: { x: 40, y: 8 }, unit_number: 2 })
    ;(surface.find_entities_filtered as any).mockReturnValue([visible, hidden])
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = query_charted_entities(actor, 1, 16, 16, 32, 8, 'assembling-machine-1')

    expect(result.ok).toBe(true)
    expect(result.partial).toBe(true)
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].unit_number).toBe(1)
  })

  it('refuses exact entity inspection for uncharted entities', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set())
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    expect(inspect_charted_entity(actor, 42)).toEqual({
      ok: false,
      code: 'area_uncharted',
      unit_number: 42,
    })
  })

  it('sets an enabled compatible machine recipe remotely without physical-distance checks', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    ;(actor.force.recipes as any)['electronic-circuit'] = {
      name: 'electronic-circuit',
      enabled: true,
      categories: ['crafting'],
    }
    const entity = make_entity(surface)
    let recipe: { name: string } | undefined
    ;(entity.get_recipe as any).mockImplementation(() => [recipe, 0.15])
    ;(entity.set_recipe as any).mockImplementation((name: string) => {
      recipe = { name }
    })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = set_charted_machine_recipe(actor, 42, 'electronic-circuit')

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'completed',
      execution_mode: 'remote',
      unit_number: 42,
      recipe_name: 'electronic-circuit',
    })
    expect(entity.set_recipe).toHaveBeenCalledWith('electronic-circuit')
  })

  it('keeps remote mutations inside the owning force', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    const entity = make_entity(surface, { force: { index: 2, name: 'enemy' } as any })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = set_charted_machine_recipe(actor, 42, 'anything')

    expect(result).toMatchObject({
      accepted: false,
      completed: false,
      code: 'wrong_force',
      execution_mode: 'remote',
    })
    expect(entity.set_recipe).not.toHaveBeenCalled()
  })
})
