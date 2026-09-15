import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { entity_geometry_for_actor, recipe_details_for_actor } from './knowledge'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function recipe(name: string, options: {
  enabled?: boolean
  categories: string[]
  energy: number
  ingredients: Array<Record<string, unknown>>
  products: Array<Record<string, unknown>>
  hidden_from_player_crafting?: boolean
}) {
  return {
    name,
    enabled: options.enabled ?? true,
    hidden: false,
    energy: options.energy,
    categories: options.categories,
    ingredients: options.ingredients,
    products: options.products,
    prototype: {
      hidden_from_player_crafting: options.hidden_from_player_crafting ?? false,
    },
  }
}

describe('recipe knowledge', () => {
  const originalPairs = (globalThis as any).pairs
  const originalGetEntityFiltered = (globalThis as any).prototypes.get_entity_filtered

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).prototypes.get_entity_filtered = (filters: Array<Record<string, unknown>>) => {
      const category = filters[0]?.crafting_category
      if (category === 'oil-processing') {
        return {
          'refinery-z': {
            type: 'assembling-machine',
            crafting_speed: 2,
            crafting_categories: { 'oil-processing': true },
          },
          'refinery-a': {
            type: 'assembling-machine',
            crafting_speed: 1,
            crafting_categories: { 'oil-processing': true },
          },
        }
      }
      if (category === 'crafting') {
        return {
          'assembling-machine-1': {
            type: 'assembling-machine',
            crafting_speed: 0.5,
            crafting_categories: { crafting: true },
          },
        }
      }
      return {}
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.get_entity_filtered = originalGetEntityFiltered
  })

  it('returns detailed fluid recipe data and deterministic compatible machines', () => {
    const advancedOil = recipe('advanced-oil-processing', {
      categories: ['oil-processing'],
      energy: 5,
      ingredients: [
        { type: 'fluid', name: 'crude-oil', amount: 100, fluidbox_index: 1 },
        { type: 'fluid', name: 'water', amount: 50, fluidbox_index: 2 },
      ],
      products: [
        { type: 'fluid', name: 'heavy-oil', amount: 25, fluidbox_index: 1, independent_probability: 1 },
        { type: 'fluid', name: 'petroleum-gas', amount: 55, fluidbox_index: 3, independent_probability: 1 },
      ],
    })
    const actor = {
      is_valid: true,
      force: { recipes: { 'advanced-oil-processing': advancedOil } },
      character: { prototype: { crafting_categories: { crafting: true } } },
    } as any

    const result = recipe_details_for_actor(actor, 'advanced-oil-processing') as any
    expect(result.found).toBe(true)
    expect(result.recipes).toHaveLength(1)
    expect(result.recipes[0]).toMatchObject({
      name: 'advanced-oil-processing',
      enabled: true,
      energy: 5,
      categories: ['oil-processing'],
      hand_craftable_category: false,
      ingredients: [
        { type: 'fluid', name: 'crude-oil', amount: 100, fluidbox_index: 1 },
        { type: 'fluid', name: 'water', amount: 50, fluidbox_index: 2 },
      ],
      products: expect.arrayContaining([
        expect.objectContaining({ type: 'fluid', name: 'petroleum-gas', amount: 55, fluidbox_index: 3 }),
      ]),
      crafting_machines: [
        expect.objectContaining({ name: 'refinery-a', crafting_speed: 1 }),
        expect.objectContaining({ name: 'refinery-z', crafting_speed: 2 }),
      ],
    })
  })

  it('resolves an item/fluid name through recipe products when recipe names differ', () => {
    const alternate = recipe('make-widget-with-a-different-name', {
      categories: ['crafting'],
      energy: 2,
      ingredients: [{ type: 'item', name: 'iron-plate', amount: 2 }],
      products: [{ type: 'item', name: 'widget', amount: 1, independent_probability: 1 }],
    })
    const actor = {
      is_valid: true,
      force: { recipes: { 'make-widget-with-a-different-name': alternate } },
      character: { prototype: { crafting_categories: { crafting: true } } },
    } as any

    const result = recipe_details_for_actor(actor, 'widget') as any
    expect(result.found).toBe(true)
    expect(result.recipes[0].name).toBe('make-widget-with-a-different-name')
    expect(result.recipes[0].hand_craftable_category).toBe(true)
    expect(result.recipes[0].crafting_machines[0].name).toBe('assembling-machine-1')
  })

  it('reports a bounded not-found result without inventing recipe knowledge', () => {
    const actor = {
      is_valid: true,
      force: { recipes: {} },
      character: { prototype: { crafting_categories: { crafting: true } } },
    } as any

    expect(recipe_details_for_actor(actor, 'does-not-exist')).toEqual({
      found: false,
      query: 'does-not-exist',
      error: 'no recipe produces this item/fluid and no recipe has this name',
    })
  })
})

describe('entity geometry knowledge', () => {
  const originalLookup = (globalThis as any).game.get_entity_by_unit_number
  const actor = {
    is_valid: true,
    position: { x: 0, y: 0 },
    surface: { index: 1 },
  } as any

  afterEach(() => {
    ;(globalThis as any).game.get_entity_by_unit_number = originalLookup
  })

  it('returns exact inserter pickup/drop geometry and bound targets', () => {
    const source = {
      valid: true,
      name: 'transport-belt',
      type: 'transport-belt',
      unit_number: 100,
      position: { x: 1, y: 0 },
      direction: 2,
      force: { name: 'player' },
    }
    const destination = {
      valid: true,
      name: 'assembling-machine-1',
      type: 'assembling-machine',
      unit_number: 101,
      position: { x: 3, y: 0 },
      direction: 0,
      force: { name: 'player' },
    }
    const inserter = {
      valid: true,
      name: 'inserter',
      type: 'inserter',
      unit_number: 42,
      position: { x: 2, y: 0 },
      direction: 2,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 0,
      fluidbox: { length: 0 },
      pickup_position: { x: 1, y: 0 },
      drop_position: { x: 3, y: 0 },
      pickup_target: source,
      drop_target: destination,
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => inserter

    expect(entity_geometry_for_actor(actor, 42)).toMatchObject({
      found: true,
      distance: 2,
      entity: { name: 'inserter', unit_number: 42, position: { x: 2, y: 0 } },
      item_io: {
        pickup_position: { x: 1, y: 0 },
        drop_position: { x: 3, y: 0 },
        pickup_target: { name: 'transport-belt', unit_number: 100 },
        drop_target: { name: 'assembling-machine-1', unit_number: 101 },
      },
      fluid_storages: [],
    })
  })

  it('returns mining-drill output position without inventing an input point', () => {
    const drill = {
      valid: true,
      name: 'electric-mining-drill',
      type: 'mining-drill',
      unit_number: 50,
      position: { x: 10, y: 5 },
      direction: 4,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 0,
      fluidbox: { length: 0 },
      drop_position: { x: 10, y: 7 },
      drop_target: undefined,
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => drill

    const result = entity_geometry_for_actor(actor, 50) as any
    expect(result.item_io).toEqual({
      drop_position: { x: 10, y: 7 },
      drop_target: undefined,
    })
    expect(result.item_io.pickup_position).toBeUndefined()
  })

  it('returns rotated absolute fluid connection positions, production roles, and connected targets', () => {
    const pipe = {
      valid: true,
      name: 'pipe',
      type: 'pipe',
      unit_number: 90,
      position: { x: 21, y: 20 },
      direction: 0,
      force: { name: 'player' },
    }
    const fluidbox = {
      length: 2,
      get_capacity: (index: number) => index === 1 ? 100 : 200,
      get_prototype: (index: number) => index === 1
        ? { index: 1, production_type: 'input', filter: undefined }
        : { index: 2, production_type: 'output', filter: { name: 'sulfuric-acid' } },
      get_pipe_connections: (index: number) => index === 1
        ? [{
            flow_direction: 'input',
            connection_type: 'normal',
            position: { x: 19, y: 20 },
            target_position: { x: 18, y: 20 },
          }]
        : [{
            flow_direction: 'output',
            connection_type: 'normal',
            position: { x: 21, y: 20 },
            target_position: { x: 22, y: 20 },
            target: pipe,
            target_fluidbox_index: 1,
            target_pipe_connection_index: 1,
          }],
    }
    const chemicalPlant = {
      valid: true,
      name: 'chemical-plant',
      type: 'assembling-machine',
      unit_number: 77,
      position: { x: 20, y: 20 },
      direction: 2,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 2,
      fluidbox,
      get_fluid: (index: number) => index === 1 ? { name: 'water', amount: 40, temperature: 15 } : undefined,
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => chemicalPlant

    const result = entity_geometry_for_actor(actor, 77) as any
    expect(result).toMatchObject({
      fluid_storage_count: 2,
      fluid_box_count: 2,
      non_fluidbox_storage_count: 0,
    })
    expect(result.fluid_storages).toHaveLength(2)
    expect(result.fluid_storages[0]).toMatchObject({
      index: 1,
      capacity: 100,
      current_fluid: { name: 'water', amount: 40, temperature: 15 },
      prototypes: [{ index: 1, production_type: 'input' }],
      pipe_connections: [{
        flow_direction: 'input',
        position: { x: 19, y: 20 },
        target_position: { x: 18, y: 20 },
      }],
    })
    expect(result.fluid_storages[1]).toMatchObject({
      prototypes: [{ index: 2, production_type: 'output', filter: 'sulfuric-acid' }],
      pipe_connections: [{
        flow_direction: 'output',
        position: { x: 21, y: 20 },
        target: { name: 'pipe', unit_number: 90 },
      }],
    })
  })

  it('reports fluid storage that is not exposed through LuaFluidBox without probing an invalid port', () => {
    const entity = {
      valid: true,
      name: 'fluid-wagon',
      type: 'fluid-wagon',
      unit_number: 81,
      position: { x: 4, y: 4 },
      direction: 0,
      force: { name: 'player' },
      surface: { index: 1 },
      fluids_count: 1,
      fluidbox: { length: 0 },
    }
    ;(globalThis as any).game.get_entity_by_unit_number = () => entity

    expect(entity_geometry_for_actor(actor, 81)).toMatchObject({
      found: true,
      fluid_storage_count: 1,
      fluid_box_count: 0,
      non_fluidbox_storage_count: 1,
      fluid_storages: [],
    })
  })

  it('fails closed for invalid ids, missing entities, and another surface', () => {
    expect(entity_geometry_for_actor(actor, 0)).toMatchObject({ found: false, error: 'invalid unit_number' })

    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
    expect(entity_geometry_for_actor(actor, 999)).toMatchObject({ found: false, error: 'entity not found' })

    ;(globalThis as any).game.get_entity_by_unit_number = () => ({
      valid: true,
      surface: { index: 2 },
    })
    expect(entity_geometry_for_actor(actor, 999)).toMatchObject({ found: false, error: 'entity is on another surface' })
  })
})
