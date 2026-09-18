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
    category,
    additional_categories: [],
  }
}

function actorWithRecipes(recipes: Record<string, any>, inventory: Record<string, number> = {}, craftable: Record<string, number> = {}) {
  return {
    is_valid: true,
    force: { recipes },
    character: {
      prototype: {
        crafting_categories: { crafting: true },
      },
    },
    get_main_inventory: () => ({
      get_item_count: (name: string) => inventory[name] ?? 0,
    }),
    get_craftable_count: (name: string) => craftable[name] ?? 0,
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).prototypes.recipe_category = {
    crafting: { name: 'crafting' },
    smelting: { name: 'smelting' },
  }
  ;(globalThis as any).prototypes.get_entity_filtered = () => ({})
})

describe('recipe details use Factorio 2.0 recipe category fields', () => {
  it('returns burner-mining-drill details from the Factorio 2.0 category field', () => {
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

  it('includes deterministic additional categories without duplicates', () => {
    const multi = recipe('multi', 'multi') as any
    multi.additional_categories = ['smelting', 'crafting']
    const actor = actorWithRecipes({ multi })

    const result = recipe_details_for_actor(actor, 'multi')
    expect(result.recipes[0].categories).toEqual(['crafting', 'smelting'])
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
    expect(result.recipes[0].crafting_machines[0]).toEqual({ name: 'assembler-01', type: 'assembling-machine' })
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

  it('attaches only dependency-relevant inventory counts for the requested craft quantity', () => {
    const gear = recipe('iron-gear-wheel', 'iron-gear-wheel') as any
    gear.ingredients = [{ type: 'item', name: 'iron-plate', amount: 2 }]
    const actor = actorWithRecipes(
      { 'iron-gear-wheel': gear },
      { 'iron-plate': 2, 'iron-gear-wheel': 1, coal: 99, stone: 50 },
    )

    const result = recipe_details_for_actor(actor, 'iron-gear-wheel', 3) as any

    expect(result.recipes[0].requested_crafts).toBe(3)
    expect(result.recipes[0].inventory_overlay.outputs).toEqual([
      { type: 'item', name: 'iron-gear-wheel', required: 3, held: 1 },
    ])
    expect(result.recipes[0].inventory_overlay.ingredients).toEqual([
      { type: 'item', name: 'iron-plate', required: 6, held: 2, missing: 4, status: 'needs_acquisition/processing' },
    ])
    expect(JSON.stringify(result.recipes[0].inventory_overlay)).not.toContain('coal')
    expect(JSON.stringify(result.recipes[0].inventory_overlay)).not.toContain('stone')
  })

  it('does not require JavaScript map methods on runtime recipe ingredient/product arrays', () => {
    const runtimeRecipe = recipe('runtime-array-shape', 'runtime-array-shape') as any
    runtimeRecipe.ingredients.map = undefined
    runtimeRecipe.products.map = undefined
    const actor = actorWithRecipes({ 'runtime-array-shape': runtimeRecipe })

    const result = recipe_details_for_actor(actor, 'runtime-array-shape')
    expect(result.found).toBe(true)
    expect(result.recipes[0].ingredients).toEqual([{ type: 'item', name: 'iron-plate', amount: 1 }])
    expect(result.recipes[0].products).toEqual([{ type: 'item', name: 'runtime-array-shape', amount: 1 }])
  })
})
