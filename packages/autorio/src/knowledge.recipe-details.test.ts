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
    has_category: (candidate: any) => (typeof candidate === 'string' ? candidate : candidate?.name) === category,
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
