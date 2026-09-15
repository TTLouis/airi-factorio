import type { ControlledActor } from './actors/types'

const MAX_RECIPE_MATCHES = 8
const MAX_MACHINE_MATCHES = 32

interface RecipeCandidate {
  name: string
  recipe: any
}

interface MachineCandidate {
  name: string
  prototype: any
}

function sort_named<T extends { name: string }>(values: T[]) {
  // Keep output deterministic without depending on Lua table iteration order.
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j].name < values[i].name) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
}

function recipe_candidates(actor: ControlledActor, item_or_recipe: string) {
  const direct = actor.force.recipes[item_or_recipe]
  if (direct) {
    return { candidates: [{ name: direct.name, recipe: direct }], truncated: false }
  }

  const candidates: RecipeCandidate[] = []
  for (const [name, recipe] of pairs(actor.force.recipes)) {
    for (const product of recipe.products) {
      if (product.name === item_or_recipe) {
        candidates.push({ name, recipe })
        break
      }
    }
  }
  sort_named(candidates)
  return {
    candidates: candidates.slice(0, MAX_RECIPE_MATCHES),
    truncated: candidates.length > MAX_RECIPE_MATCHES,
  }
}

function categories_for(recipe: any): string[] {
  const categories: string[] = []
  for (const category of recipe.categories ?? []) {
    categories.push(category)
  }
  return categories
}

function machine_summaries(categories: string[]) {
  const seen: Record<string, boolean> = {}
  const candidates: MachineCandidate[] = []

  for (const category of categories) {
    const matches = prototypes.get_entity_filtered([
      { filter: 'crafting-category', crafting_category: category },
    ])
    for (const [name, prototype] of pairs(matches)) {
      if (seen[name]) continue
      seen[name] = true
      candidates.push({ name, prototype })
    }
  }

  sort_named(candidates)
  return {
    truncated: candidates.length > MAX_MACHINE_MATCHES,
    machines: candidates.slice(0, MAX_MACHINE_MATCHES).map(({ name, prototype }) => ({
      name,
      type: prototype.type,
      crafting_speed: prototype.crafting_speed,
      crafting_categories: prototype.crafting_categories,
    })),
  }
}

function character_can_craft(actor: ControlledActor, categories: string[]) {
  const supported = actor.character?.prototype.crafting_categories
  if (!supported) return false
  for (const category of categories) {
    if (supported[category]) return true
  }
  return false
}

function ingredient_summary(ingredient: any) {
  return {
    type: ingredient.type,
    name: ingredient.name,
    amount: ingredient.amount,
    minimum_temperature: ingredient.minimum_temperature,
    maximum_temperature: ingredient.maximum_temperature,
    temperature: ingredient.temperature,
    fluidbox_index: ingredient.fluidbox_index,
  }
}

function product_summary(product: any) {
  return {
    type: product.type,
    name: product.name,
    amount: product.amount,
    amount_min: product.amount_min,
    amount_max: product.amount_max,
    independent_probability: product.independent_probability,
    temperature: product.temperature,
    fluidbox_index: product.fluidbox_index,
  }
}

export function recipe_details_for_actor(actor: ControlledActor, item_or_recipe: string) {
  const { candidates, truncated } = recipe_candidates(actor, item_or_recipe)
  if (candidates.length === 0) {
    return {
      found: false,
      query: item_or_recipe,
      error: 'no recipe produces this item/fluid and no recipe has this name',
    }
  }

  return {
    found: true,
    query: item_or_recipe,
    truncated,
    recipes: candidates.map(({ name, recipe }) => {
      const categories = categories_for(recipe)
      const machine_result = machine_summaries(categories)
      return {
        name,
        enabled: recipe.enabled,
        hidden: recipe.hidden,
        energy: recipe.energy,
        categories,
        hand_craftable_category: character_can_craft(actor, categories),
        hidden_from_player_crafting: recipe.prototype?.hidden_from_player_crafting,
        ingredients: recipe.ingredients.map(ingredient_summary),
        products: recipe.products.map(product_summary),
        crafting_machines: machine_result.machines,
        crafting_machines_truncated: machine_result.truncated,
      }
    }),
  }
}

export function create_knowledge_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_knowledge', {
    recipe_details: (item_or_recipe: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return {
          found: false,
          query: item_or_recipe,
          error: 'no controlled actor',
        }
      }
      return recipe_details_for_actor(actor, item_or_recipe)
    },
  })
}
