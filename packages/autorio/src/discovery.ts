import type { ControlledActor } from './actors/types'

const MIN_LONG_RANGE_RADIUS = 64
const MAX_LONG_RANGE_RADIUS = 4096
const MAX_LONG_RANGE_RESULTS = 16
const SEARCH_RING_SIZE = 256

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function nearest_matches(actor: ControlledActor, matches: any[], limit: number) {
  const remaining = matches.slice()
  const results: Array<Record<string, unknown>> = []

  while (remaining.length > 0 && results.length < limit) {
    let nearest_index = 0
    let nearest_distance = squared_distance(actor.position, remaining[0].position)
    for (let i = 1; i < remaining.length; i++) {
      const candidate_distance = squared_distance(actor.position, remaining[i].position)
      if (candidate_distance < nearest_distance) {
        nearest_distance = candidate_distance
        nearest_index = i
      }
    }

    const entity = remaining[nearest_index]
    remaining.splice(nearest_index, 1)
    results.push({
      name: entity.name,
      type: entity.type,
      position: entity.position,
      distance: math.sqrt(nearest_distance),
      force: entity.force?.name,
      unit_number: entity.unit_number,
      amount: entity.type === 'resource' ? entity.amount : undefined,
    })
  }

  return results
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

      const bounded_radius = math.max(MIN_LONG_RANGE_RADIUS, math.min(MAX_LONG_RANGE_RADIUS, math.floor(max_radius || 1024)))
      const bounded_limit = math.max(1, math.min(MAX_LONG_RANGE_RESULTS, math.floor(limit || 8)))
      let searched_radius = 0
      let matches: any[] = []

      for (let radius = SEARCH_RING_SIZE; radius <= bounded_radius; radius += SEARCH_RING_SIZE) {
        searched_radius = math.min(radius, bounded_radius)
        matches = actor.surface.find_entities_filtered({
          position: actor.position,
          radius: searched_radius,
          name,
        }) as any[]
        if (matches.length > 0 || searched_radius >= bounded_radius) break
      }

      if (searched_radius < bounded_radius && matches.length === 0) {
        searched_radius = bounded_radius
        matches = actor.surface.find_entities_filtered({
          position: actor.position,
          radius: searched_radius,
          name,
        }) as any[]
      }

      const entities = nearest_matches(actor, matches, bounded_limit)
      return {
        found: entities.length > 0,
        actor_position: actor.position,
        name,
        searched_radius,
        max_radius: bounded_radius,
        matched_count: matches.length,
        returned_count: entities.length,
        truncated: matches.length > entities.length,
        entities,
      }
    },
  })
}
