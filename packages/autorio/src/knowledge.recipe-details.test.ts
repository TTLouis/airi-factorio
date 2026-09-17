import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { recipe_details_for_actor } from './knowledge'

function recipe(name: string, product: string, category = 'crafting') {
  return {
    name,
    enabled: true,
    hidden: false,
    energy: 0.5,
    ingredients: [{ type: 'item', name: 'iron-plate', amount: 1 }],
    products: [{ type: 'item', name: product, amount: 1 }],
    prototype: { hidden_from_player_crafting: false },
    has_category: (candidate: any) => {
      if (typeof candidate !== 'string') throw new Error('Factorio runtime category IDs must cross this boundary as strings')
      return candidate === category
    },
  }
}

function actorWithRecipes(recipes: Record<string, any>) {
  return {
    is_valid: true,
    force: { recipes },
    character: {
      prototype: {
        crafting_categories: { crafting: true },
      },
    },
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).prototypes.recipe_category = {
    crafting: { name: 'crafting' },
    smelting: { name: 'smelting' },
  }
  ;(globalThis as any).prototypes.get_entity_filtered = () => ({})
})

describe('recipe details use the Factorio 2 runtime category predicate', () => {
  it('returns burner-mining-drill details without reading LuaRecipe.categories', () => {
    const actor = actorWithRecipes({
      'burner-mining-drill': recipe('burner-mining-drill', 'burner-mining-drill'),
    })

    const result = recipe_details_for_actor(actor, 'burner-mining-drill')
    expect(result.found).toBe(true)
    expect(result.recipes[0]).toMatchObject({
      name: 'burner-mining-drill',
      enabled: true,
      categories: ['crafting'],
      hand_craftable_category: true,
    })
  })

  it('caps compatible machine summaries at eight and reports the full match count', () => {
    const machines: Record<string, any> = {}
    for (let i = 1; i <= 12; i++) machines[`assembler-${String(i).padStart(2, '0')}`] = {
      name: `assembler-${String(i).padStart(2, '0')}`, type: 'assembling-machine', crafting_speed: i,
    }
    ;(globalThis as any).prototypes.get_entity_filtered = () => machines
    const actor = actorWithRecipes({ widget: recipe('widget', 'widget') })
    const result = recipe_details_for_actor(actor, 'widget') as any
    expect(result.recipes[0].crafting_machine_count).toBe(12)
    expect(result.recipes[0].crafting_machines).toHaveLength(8)
    expect(result.recipes[0].crafting_machines_truncated).toBe(true)
    expect(result.recipes[0].crafting_machines[0]).toEqual({ name: 'assembler-01', type: 'assembling-machine', crafting_speed: 1 })
  })

  it('returns another ordinary enabled recipe with deterministic categories', () => {
    const actor = actorWithRecipes({
      'iron-gear-wheel': recipe('iron-gear-wheel', 'iron-gear-wheel'),
    })

    const result = recipe_details_for_actor(actor, 'iron-gear-wheel')
    expect(result.found).toBe(true)
    expect(result.recipes[0].categories).toEqual(['crafting'])
    expect(result.recipes[0].ingredients[0]).toMatchObject({ name: 'iron-plate', amount: 1 })
    expect(result.recipes[0].products[0]).toMatchObject({ name: 'iron-gear-wheel', amount: 1 })
  })
})
