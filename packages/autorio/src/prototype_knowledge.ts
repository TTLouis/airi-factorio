const MAX_PLACE_ITEMS = 16
const MAX_FLUIDBOX_PROTOTYPES = 16

function sort_strings(values: string[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j] < values[i]) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
  return values
}

function dictionary_keys(value: any) {
  const result: string[] = []
  if (!value) return result
  for (const [name] of pairs(value)) result.push(name)
  return sort_strings(result)
}

function place_items(prototype: any) {
  const values = prototype?.items_to_place_this ?? []
  return values.slice(0, MAX_PLACE_ITEMS).map((item: any) => ({ name: item.name, count: item.count }))
}

function fluidbox_details(prototype: any) {
  const values = prototype?.fluidbox_prototypes ?? []
  return {
    truncated: values.length > MAX_FLUIDBOX_PROTOTYPES,
    fluidboxes: values.slice(0, MAX_FLUIDBOX_PROTOTYPES).map((fluidbox: any) => ({
      index: fluidbox.index,
      production_type: fluidbox.production_type,
      filter: fluidbox.filter?.name,
      minimum_temperature: fluidbox.minimum_temperature,
      maximum_temperature: fluidbox.maximum_temperature,
      pipe_connection_count: fluidbox.pipe_connections?.length ?? 0,
    })),
  }
}

function entity_details(prototype: any) {
  if (!prototype) return undefined
  const fluidboxes = fluidbox_details(prototype)
  const result: Record<string, unknown> = {
    name: prototype.name,
    type: prototype.type,
    is_building: prototype.is_building,
    tile_width: prototype.tile_width,
    tile_height: prototype.tile_height,
    collision_box: prototype.collision_box,
    selection_box: prototype.selection_box,
    place_items: place_items(prototype),
    fluidboxes: fluidboxes.fluidboxes,
    fluidboxes_truncated: fluidboxes.truncated,
  }

  if (prototype.crafting_categories) {
    result.crafting = {
      speed: prototype.crafting_speed,
      categories: dictionary_keys(prototype.crafting_categories),
      ingredient_count: prototype.ingredient_count,
      energy_usage: prototype.energy_usage,
    }
  }
  if (prototype.type === 'mining-drill') {
    result.mining = {
      speed: prototype.mining_speed,
      radius: prototype.mining_drill_radius,
      resource_categories: dictionary_keys(prototype.resource_categories),
      energy_usage: prototype.energy_usage,
    }
  }
  if (prototype.belt_speed !== undefined) {
    result.belt = {
      speed: prototype.belt_speed,
      max_underground_distance: prototype.max_underground_distance,
    }
  }
  if (prototype.type === 'inserter') {
    result.inserter = {
      pickup_position: prototype.inserter_pickup_position,
      drop_position: prototype.inserter_drop_position,
      allow_custom_vectors: prototype.allow_custom_vectors,
      bulk: prototype.bulk,
      max_belt_stack_size: prototype.inserter_max_belt_stack_size,
      energy_usage: prototype.energy_usage,
    }
  }

  return result
}

function item_details(prototype: any) {
  if (!prototype) return undefined
  return {
    name: prototype.name,
    stack_size: prototype.stack_size,
    place_result: prototype.place_result?.name,
    fuel_category: prototype.fuel_category,
    fuel_value: prototype.fuel_value,
    burnt_result: prototype.burnt_result?.name,
  }
}

function fluid_details(prototype: any) {
  if (!prototype) return undefined
  return {
    name: prototype.name,
    default_temperature: prototype.default_temperature,
    max_temperature: prototype.max_temperature,
    heat_capacity: prototype.heat_capacity,
    fuel_value: prototype.fuel_value,
  }
}

export function prototype_details(name: string) {
  const item = prototypes.item[name]
  const fluid = prototypes.fluid[name]
  const direct_entity = prototypes.entity[name]
  const placed_entity = item?.place_result
  const entity = direct_entity ?? placed_entity

  if (!item && !fluid && !entity) {
    return { found: false, query: name, error: 'prototype not found as item, fluid, or entity' }
  }

  return {
    found: true,
    query: name,
    item: item_details(item),
    fluid: fluid_details(fluid),
    entity: entity_details(entity),
  }
}

export function create_prototype_knowledge_remote_interface() {
  remote.add_interface('autorio_prototypes', {
    details: (name: string) => prototype_details(name),
  })
}
