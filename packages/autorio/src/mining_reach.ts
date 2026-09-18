import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const MINING_REACH_MARGIN = 0.25
const MIN_MINING_REACH = 0.5
const FALLBACK_MINING_REACH = 2.5
const REJECTED_START_APPROACH_STEP = 0.75

export const MAX_MINING_START_REJECTIONS = 3

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function finite_world_mining_target(entity: LuaEntity) {
  if (entity.type === 'resource') return true
  const prototype = entity.prototype
  return prototype.is_building !== true
    && prototype.mineable_properties !== undefined
    && prototype.mineable_properties.minable !== false
}

/**
 * Conservative player-equivalent mining reach. Resource patches and finite
 * natural mineables such as trees/rocks use resource_reach_distance; placed
 * buildings keep ordinary reach_distance for explicit deconstruction mining.
 */
export function mining_reach_distance(actor: ControlledActor, entity: LuaEntity) {
  const character = actor.character
  if (!character) return MIN_MINING_REACH
  const raw = finite_world_mining_target(entity)
    ? character.resource_reach_distance
    : character.reach_distance
  const reach = typeof raw === 'number' && raw === raw && raw > 0 && raw < math.huge
    ? raw
    : FALLBACK_MINING_REACH
  return math.max(MIN_MINING_REACH, reach - MINING_REACH_MARGIN)
}

export function within_mining_reach(actor: ControlledActor, entity: LuaEntity) {
  const reach = mining_reach_distance(actor, entity)
  return squared_distance(actor.position, entity.position) <= reach ** 2
}

/** Force a closer approach after Factorio rejects a mining start in nominal reach. */
export function mining_navigation_reach(actor: ControlledActor, entity: LuaEntity, rejected_starts: number = 0) {
  const normal = mining_reach_distance(actor, entity)
  if (rejected_starts <= 0) return normal
  const distance = math.sqrt(squared_distance(actor.position, entity.position))
  return math.max(MIN_MINING_REACH, math.min(normal, distance - REJECTED_START_APPROACH_STEP))
}

export function mining_navigation_requires_movement(actor: ControlledActor, entity: LuaEntity, reach: number) {
  return squared_distance(actor.position, entity.position) > reach ** 2
}

/** Bind mining to the exact already-observed entity rather than same-name proximity. */
export function select_exact_mining_target(actor: ControlledActor, target: LuaEntity) {
  actor.update_selected_entity(target.position)
  const selected = actor.character?.selected
  if (!selected || !selected.valid) return false
  if (target.unit_number !== undefined || selected.unit_number !== undefined) {
    return target.unit_number !== undefined && selected.unit_number === target.unit_number
  }
  return selected === target
}
