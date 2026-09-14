import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const MIN_LONG_RANGE_RADIUS = 64
const MAX_LONG_RANGE_RADIUS = 4096
const MAX_LONG_RANGE_RESULTS = 16

type SearchRadiusResult = {
  searched_radius: number
  matched_count: number
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function count_matches(actor: ControlledActor, name: string, radius: number) {
  return actor.surface.count_entities_filtered({
    position: actor.position,
    radius,
    name,
  })
}

/**
 * Find the smallest practical radius that contains the requested number of
 * exact-name matches. Widening uses count_entities_filtered() so the engine
 * does not construct LuaEntity wrappers for every probe. Once a matching range
 * is found, a binary refinement keeps the final materialized result set small.
 */
function find_candidate_radius(actor: ControlledActor, name: string, max_radius: number, desired_count: number): SearchRadiusResult {
  let lower_radius = 0
  let upper_radius = math.min(MIN_LONG_RANGE_RADIUS, max_radius)
  let upper_count = count_matches(actor, name, upper_radius)

  while (upper_count < desired_count && upper_radius < max_radius) {
    lower_radius = upper_radius
    upper_radius = math.min(max_radius, upper_radius * 2)
    upper_count = count_matches(actor, name, upper_radius)
  }

  if (upper_count === 0) {
    return {
      searched_radius: max_radius,
      matched_count: 0,
    }
  }

  // Fewer than desired_count entities exist inside max_radius. Materialize the
  // complete bounded set once so the caller can still return every available
  // match without widening beyond the requested world-search boundary.
  if (upper_count < desired_count) {
    return {
      searched_radius: upper_radius,
      matched_count: upper_count,
    }
  }

  // Refine to the smallest integer radius that still contains desired_count.
  // This avoids materializing a huge ore patch simply because its nearest edge
  // was hundreds of tiles away from AIRI.
  let low = lower_radius + 1
  let high = upper_radius
  while (low < high) {
    const midpoint = math.floor((low + high) / 2)
    const count = count_matches(actor, name, midpoint)
    if (count >= desired_count) {
      high = midpoint
    }
    else {
      low = midpoint + 1
    }
  }

  return {
    searched_radius: low,
    matched_count: count_matches(actor, name, low),
  }
}

function summarize_nearest(actor: ControlledActor, matches: LuaEntity[], limit: number) {
  const remaining = matches.slice()
  const results: Array<Record<string, unknown>> = []

  while (remaining.length > 0 && results.length < limit) {
    const entity = actor.surface.get_closest(actor.position, remaining)
    if (!entity) break

    let remove_index = -1
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] === entity) {
        remove_index = i
        break
      }
    }
    if (remove_index >= 0) remaining.splice(remove_index, 1)

    results.push({
      name: entity.name,
      type: entity.type,
      position: entity.position,
      distance: math.sqrt(squared_distance(actor.position, entity.position)),
      force: entity.force?.name,
      unit_number: entity.unit_number,
      amount: entity.type === 'resource' ? entity.amount : undefined,
    })
  }

  return results
}

export function find_long_range_entities(actor: ControlledActor, name: string, max_radius: number = 1024, limit: number = 8) {
  const bounded_radius = math.max(MIN_LONG_RANGE_RADIUS, math.min(MAX_LONG_RANGE_RADIUS, math.floor(max_radius || 1024)))
  const bounded_limit = math.max(1, math.min(MAX_LONG_RANGE_RESULTS, math.floor(limit || 8)))
  const search = find_candidate_radius(actor, name, bounded_radius, bounded_limit)

  if (search.matched_count === 0) {
    return {
      found: false,
      actor_position: actor.position,
      name,
      searched_radius: search.searched_radius,
      max_radius: bounded_radius,
      matched_count: 0,
      returned_count: 0,
      truncated: false,
      entities: [],
    }
  }

  // Only now ask Factorio to construct LuaEntity wrappers, and only for the
  // refined radius around the nearest requested matches.
  const matches = actor.surface.find_entities_filtered({
    position: actor.position,
    radius: search.searched_radius,
    name,
  })
  const entities = summarize_nearest(actor, matches, bounded_limit)

  return {
    found: entities.length > 0,
    actor_position: actor.position,
    name,
    searched_radius: search.searched_radius,
    max_radius: bounded_radius,
    matched_count: matches.length,
    returned_count: entities.length,
    truncated: matches.length > entities.length,
    entities,
  }
}

export function create_discovery_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_discovery', {
    find_entities: (name: string, max_radius: number = 1024, limit: number = 8) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { found: false, entities: [], error: 'no controlled actor' }
      }
      if (typeof name !== 'string' || name.length === 0 || !prototypes.entity[name]) {
        return { found: false, entities: [], error: 'invalid entity name', name }
      }

      return find_long_range_entities(actor, name, max_radius, limit)
    },
  })
}
