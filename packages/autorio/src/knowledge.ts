import type { LuaEntity, UnitNumber } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const MAX_RECIPE_MATCHES = 8
const MAX_MACHINE_MATCHES = 32
const MAX_FLUID_STORAGES = 16
const MAX_PIPE_CONNECTIONS = 16

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
      if (seen[name] === true) continue
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

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function entity_summary(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid) return undefined
  return {
    name: entity.name,
    type: entity.type,
    unit_number: entity.unit_number,
    position: entity.position,
    direction: entity.direction,
    force: entity.force?.name,
  }
}

function fluidbox_prototype_summary(value: any) {
  if (!value) return []
  const values: any[] = value.production_type ? [value] : value
  const result: Array<Record<string, unknown>> = []
  for (const prototype of values) {
    result.push({
      index: prototype.index,
      production_type: prototype.production_type,
      filter: prototype.filter?.name,
      minimum_temperature: prototype.minimum_temperature,
      maximum_temperature: prototype.maximum_temperature,
    })
  }
  return result
}

function fluid_storage_summary(entity: LuaEntity, index: number) {
  const fluidbox = entity.fluidbox
  const prototypes_for_storage = fluidbox_prototype_summary(fluidbox.get_prototype(index))
  const connections = fluidbox.get_pipe_connections(index) ?? []
  const current_fluid = entity.get_fluid(index)

  return {
    index,
    capacity: fluidbox.get_capacity(index),
    current_fluid: current_fluid
      ? {
          name: current_fluid.name,
          amount: current_fluid.amount,
          temperature: current_fluid.temperature,
        }
      : undefined,
    prototypes: prototypes_for_storage,
    pipe_connections_truncated: connections.length > MAX_PIPE_CONNECTIONS,
    pipe_connections: connections.slice(0, MAX_PIPE_CONNECTIONS).map(connection => ({
      flow_direction: connection.flow_direction,
      connection_type: connection.connection_type,
      position: connection.position,
      target_position: connection.target_position,
      target: entity_summary(connection.target),
      target_fluidbox_index: connection.target_fluidbox_index,
      target_pipe_connection_index: connection.target_pipe_connection_index,
    })),
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

export function entity_geometry_for_actor(actor: ControlledActor, unit_number: number) {
  if (unit_number < 1 || math.floor(unit_number) !== unit_number) {
    return {
      found: false,
      unit_number,
      error: 'invalid unit_number',
    }
  }

  const entity = game.get_entity_by_unit_number(unit_number as UnitNumber)
  if (!entity || !entity.valid) {
    return {
      found: false,
      unit_number,
      error: 'entity not found',
    }
  }
  if (entity.surface.index !== actor.surface.index) {
    return {
      found: false,
      unit_number,
      error: 'entity is on another surface',
    }
  }

  // Factorio 2.0 exposes connection geometry through LuaFluidBox. LuaFluidBox is
  // array-like in typed-factorio, so .length maps to the Lua length operator.
  const fluid_box_count = entity.fluidbox.length
  const returned_fluid_storages = math.min(fluid_box_count, MAX_FLUID_STORAGES)
  const fluid_storages: Array<Record<string, unknown>> = []
  for (let index = 1; index <= returned_fluid_storages; index++) {
    fluid_storages.push(fluid_storage_summary(entity, index))
  }

  const inserter = entity.type === 'inserter'
  const mining_drill = entity.type === 'mining-drill'

  return {
    found: true,
    distance: math.sqrt(squared_distance(actor.position, entity.position)),
    entity: entity_summary(entity),
    item_io: inserter
      ? {
          pickup_position: entity.pickup_position,
          drop_position: entity.drop_position,
          pickup_target: entity_summary(entity.pickup_target),
          drop_target: entity_summary(entity.drop_target),
        }
      : mining_drill
        ? {
            drop_position: entity.drop_position,
            drop_target: entity_summary(entity.drop_target),
          }
        : undefined,
    fluid_storage_count: entity.fluids_count,
    fluid_box_count,
    non_fluidbox_storage_count: math.max(0, entity.fluids_count - fluid_box_count),
    fluid_storages_truncated: fluid_box_count > MAX_FLUID_STORAGES,
    fluid_storages,
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
    entity_geometry: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return {
          found: false,
          unit_number,
          error: 'no controlled actor',
        }
      }
      return entity_geometry_for_actor(actor, unit_number)
    },
  })
}
