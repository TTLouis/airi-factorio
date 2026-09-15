import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recipe_details_for_actor } from './knowledge'

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
          refinery-z: {
            type: 'assembling-machine',
            crafting_speed: 2,
            crafting_categories: { 'oil-processing': true },
          },
          refinery-a: {
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
