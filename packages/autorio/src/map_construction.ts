import type { LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const MAX_SURFACE_INDEX = 4294967295
const MAX_COORDINATE = 1000000

type Position = { x: number, y: number }

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value >= -MAX_COORDINATE && value <= MAX_COORDINATE
}

function surface_by_index(surface_index: number) {
  if (!valid_integer(surface_index, 1, MAX_SURFACE_INDEX)) return undefined
  return game.get_surface(surface_index as LuaSurface['index'])
}

function chunk_position(position: Position) {
  return {
    x: math.floor(position.x / 32),
    y: math.floor(position.y / 32),
  }
}

function position_charted(actor: ControlledActor, surface: LuaSurface, position: Position) {
  return actor.force.is_chunk_charted(surface, chunk_position(position))
}

function position_visible(actor: ControlledActor, surface: LuaSurface, position: Position) {
  return actor.force.is_chunk_visible(surface, chunk_position(position))
}

function construction_item(entity_name: string) {
  const prototype = prototypes.entity[entity_name]
  const place_items = prototype?.items_to_place_this
  const first = place_items?.[0]
  if (!first) return undefined
  return { name: first.name, count: first.count }
}

function fulfillment_status(network_count: number, total_robot_count: number, available_robot_count: number, item_count: number, required_item_count: number) {
  if (network_count === 0) return 'blocked_no_construction_network'
  if (total_robot_count === 0) return 'blocked_no_construction_robots'
  if (item_count < required_item_count) return 'blocked_item_missing'
  if (available_robot_count === 0) return 'queued_no_available_construction_robots'
  return 'ready'
}

function remotely_fulfillable(fulfillment: string) {
  return fulfillment === 'ready' || fulfillment === 'queued_no_available_construction_robots'
}

export function inspect_remote_construction(
  actor: ControlledActor,
  surface_index: number,
  x: number,
  y: number,
  entity_name: string,
  direction?: number,
) {
  if (!valid_coordinate(x) || !valid_coordinate(y)) {
    return { ok: false, code: 'invalid_position' }
  }
  if (direction !== undefined && !valid_integer(direction, 0, 15)) {
    return { ok: false, code: 'invalid_direction' }
  }
  if (typeof entity_name !== 'string' || entity_name.length === 0 || !prototypes.entity[entity_name]) {
    return { ok: false, code: 'invalid_entity_name', entity_name }
  }

  const surface = surface_by_index(surface_index)
  if (!surface || !surface.valid) {
    return { ok: false, code: 'invalid_surface', surface_index }
  }
  const position = { x, y }
  if (!position_charted(actor, surface, position)) {
    return { ok: false, code: 'area_uncharted', surface_index, position }
  }
  if (!position_visible(actor, surface, position)) {
    return { ok: false, code: 'area_not_visible', surface_index, position }
  }

  const item = construction_item(entity_name)
  if (!item) {
    return {
      ok: false,
      code: 'entity_not_bot_placeable',
      surface_index,
      position,
      entity_name,
    }
  }

  const can_place_ghost = surface.can_place_entity({
    name: 'entity-ghost',
    inner_name: entity_name,
    position,
    direction,
    force: actor.force,
  })

  const networks = surface.find_logistic_networks_by_construction_area(position, actor.force)
  const network_summaries: Array<Record<string, unknown>> = []
  let total_robots = 0
  let available_robots = 0
  let available_items = 0
  for (const network of networks) {
    if (!network.valid) continue
    const network_items = network.get_item_count(item.name as any)
    total_robots += network.all_construction_robots
    available_robots += network.available_construction_robots
    available_items += network_items
    network_summaries.push({
      network_id: network.network_id,
      all_construction_robots: network.all_construction_robots,
      available_construction_robots: network.available_construction_robots,
      construction_item_count: network_items,
    })
  }

  const fulfillment = fulfillment_status(network_summaries.length, total_robots, available_robots, available_items, item.count)
  return {
    ok: true,
    code: 'ok',
    execution_mode: 'remote',
    surface_index,
    surface_name: surface.name,
    position,
    entity_name,
    direction,
    can_place_ghost,
    construction_item: item,
    fulfillment,
    remotely_fulfillable: can_place_ghost && remotely_fulfillable(fulfillment),
    network_count: network_summaries.length,
    all_construction_robots: total_robots,
    available_construction_robots: available_robots,
    available_construction_items: available_items,
    networks: network_summaries,
  }
}

export function stage_remote_entity_ghost(
  actor: ControlledActor,
  surface_index: number,
  x: number,
  y: number,
  entity_name: string,
  direction?: number,
) {
  const capability = inspect_remote_construction(actor, surface_index, x, y, entity_name, direction)
  if (!capability.ok) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      ...capability,
    }
  }
  if (!capability.can_place_ghost) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'world_collision',
      construction: capability,
    }
  }

  const surface = surface_by_index(surface_index)!
  const ghost = surface.create_entity({
    name: 'entity-ghost',
    inner_name: entity_name,
    position: { x, y },
    direction,
    force: actor.force,
    raise_built: true,
  })
  if (!ghost || !ghost.valid) {
    return {
      accepted: false,
      completed: false,
      execution_mode: 'remote',
      code: 'ghost_creation_failed',
      construction: capability,
    }
  }

  return {
    accepted: true,
    completed: true,
    execution_mode: 'remote',
    code: 'ghost_staged',
    world_completion: capability.remotely_fulfillable ? 'pending_robot_fulfillment' : 'blocked',
    ghost: {
      name: ghost.name,
      ghost_name: ghost.ghost_name,
      position: ghost.position,
      surface_index: ghost.surface.index,
      direction: ghost.direction,
    },
    construction: capability,
  }
}

export function create_map_construction_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_map_construction', {
    inspect: (surface_index: number, x: number, y: number, entity_name: string, direction?: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
      return inspect_remote_construction(actor, surface_index, x, y, entity_name, direction)
    },
    stage_ghost: (surface_index: number, x: number, y: number, entity_name: string, direction?: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { accepted: false, completed: false, execution_mode: 'remote', code: 'no_actor' }
      }
      return stage_remote_entity_ghost(actor, surface_index, x, y, entity_name, direction)
    },
  })
}
