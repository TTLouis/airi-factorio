import type { ControlledActor } from './actors/types'

const MAX_RADIUS = 24
const MAX_LIMIT = 8
const MAX_SCANNED_POSITIONS = 10000
const CARDINAL_DIRECTIONS = [0, 4, 8, 12]

export interface PlacementCandidateRequest {
  entity_name: string
  center?: { x: number, y: number }
  radius?: number
  target_resource?: string
  limit?: number
}

interface ResourceCoverage {
  name: string
  entities: number
  amount: number
}

export interface PlacementCandidate {
  id: string
  position: { x: number, y: number }
  direction: number
  distance_from_center: number
  resource_coverage?: ResourceCoverage[]
}

function finite(value: number) {
  return value === value && value !== math.huge && value !== -math.huge
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function sorted_resource_coverages(values: Record<string, ResourceCoverage>) {
  const result: ResourceCoverage[] = []
  for (const [, value] of pairs(values)) result.push(value)
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      if (result[j].name < result[i].name) {
        const tmp = result[i]
        result[i] = result[j]
        result[j] = tmp
      }
    }
  }
  return result
}

function resource_categories(prototype: any) {
  const result: Record<string, boolean> = {}
  for (const [name, enabled] of pairs(prototype?.resource_categories ?? {})) {
    if (enabled) result[name] = true
  }
  return result
}

function resource_coverage(actor: ControlledActor, prototype: any, position: { x: number, y: number }, target_resource?: string) {
  const radius = prototype?.mining_drill_radius
  if (typeof radius !== 'number' || radius <= 0 || !finite(radius)) return undefined

  const allowed_categories = resource_categories(prototype)
  const resources = actor.surface.find_entities_filtered({
    area: [
      { x: position.x - radius, y: position.y - radius },
      { x: position.x + radius, y: position.y + radius },
    ],
    type: 'resource',
  })

  const coverage_by_name: Record<string, ResourceCoverage> = {}
  for (const resource of resources) {
    if (!resource.valid || resource.type !== 'resource') continue
    if (target_resource !== undefined && resource.name !== target_resource) continue
    const category = (resource.prototype as any).resource_category
    if (category !== undefined && allowed_categories[category] !== true) continue
    const existing = coverage_by_name[resource.name]
    const amount = typeof resource.amount === 'number' ? resource.amount : 0
    if (existing) {
      existing.entities += 1
      existing.amount += amount
    }
    else {
      coverage_by_name[resource.name] = { name: resource.name, entities: 1, amount }
    }
  }
  return sorted_resource_coverages(coverage_by_name)
}

function coverage_score(candidate: PlacementCandidate, target_resource?: string) {
  let entities = 0
  let amount = 0
  for (const coverage of candidate.resource_coverage ?? []) {
    if (target_resource !== undefined && coverage.name !== target_resource) continue
    entities += coverage.entities
    amount += coverage.amount
  }
  return { entities, amount }
}

function better(left: PlacementCandidate, right: PlacementCandidate, target_resource?: string) {
  const left_coverage = coverage_score(left, target_resource)
  const right_coverage = coverage_score(right, target_resource)
  if (left_coverage.entities !== right_coverage.entities) return left_coverage.entities > right_coverage.entities
  if (left_coverage.amount !== right_coverage.amount) return left_coverage.amount > right_coverage.amount
  if (left.distance_from_center !== right.distance_from_center) return left.distance_from_center < right.distance_from_center
  if (left.position.y !== right.position.y) return left.position.y < right.position.y
  if (left.position.x !== right.position.x) return left.position.x < right.position.x
  return left.direction < right.direction
}

function sort_candidates(values: PlacementCandidate[], target_resource?: string) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (better(values[j], values[i], target_resource)) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
}

function grid_offset(size: number | undefined) {
  if (typeof size !== 'number' || size < 1) return 0.5
  return math.floor(size) % 2 === 0 ? 0 : 0.5
}

function snapped(value: number, offset: number) {
  return math.floor(value - offset + 0.5) + offset
}

function directions_for(prototype: any) {
  if (prototype?.supports_direction === false || prototype?.rotatable === false) return [0]
  return CARDINAL_DIRECTIONS
}

function diverse_top(values: PlacementCandidate[], limit: number) {
  const result: PlacementCandidate[] = []
  for (const candidate of values) {
    let duplicate_location = false
    for (const existing of result) {
      if (existing.position.x === candidate.position.x && existing.position.y === candidate.position.y && existing.direction === candidate.direction) {
        duplicate_location = true
        break
      }
    }
    if (duplicate_location) continue
    result.push(candidate)
    if (result.length >= limit) break
  }
  return result
}

/**
 * Enumerate legal placement choices locally using the running game's entity
 * prototype and LuaSurface.can_place_entity. Resource coverage is derived from
 * the prototype's mining radius/categories and live map resources, so modded
 * miners participate without name-based special cases.
 */
export function placement_candidates_for_actor(actor: ControlledActor, request: PlacementCandidateRequest) {
  const prototype = prototypes.entity[request.entity_name]
  if (!prototype) return { ok: false as const, error: 'entity prototype not found', entity_name: request.entity_name }

  const center = request.center ?? actor.position
  if (!finite(center.x) || !finite(center.y)) return { ok: false as const, error: 'center must be finite', entity_name: request.entity_name }
  const radius = math.max(1, math.min(MAX_RADIUS, math.floor(request.radius ?? 8)))
  const limit = math.max(1, math.min(MAX_LIMIT, math.floor(request.limit ?? 5)))
  const x_offset = grid_offset((prototype as any).tile_width)
  const y_offset = grid_offset((prototype as any).tile_height)
  const center_x = snapped(center.x, x_offset)
  const center_y = snapped(center.y, y_offset)
  const directions = directions_for(prototype)
  const candidates: PlacementCandidate[] = []
  let scanned = 0

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const position = { x: center_x + dx, y: center_y + dy }
      for (const direction of directions) {
        scanned += 1
        if (scanned > MAX_SCANNED_POSITIONS) break
        if (!actor.surface.can_place_entity({
          name: request.entity_name,
          position,
          direction,
          force: actor.force,
        })) continue

        const coverage = resource_coverage(actor, prototype, position, request.target_resource)
        if (request.target_resource !== undefined) {
          let covered = false
          for (const value of coverage ?? []) if (value.name === request.target_resource && value.entities > 0) covered = true
          if (!covered) continue
        }

        const candidate: PlacementCandidate = {
          id: '',
          position,
          direction,
          distance_from_center: math.sqrt(squared_distance(position, center)),
        }
        if (coverage !== undefined && coverage.length > 0) candidate.resource_coverage = coverage
        candidates.push(candidate)
      }
      if (scanned > MAX_SCANNED_POSITIONS) break
    }
    if (scanned > MAX_SCANNED_POSITIONS) break
  }

  sort_candidates(candidates, request.target_resource)
  const selected = diverse_top(candidates, limit)
  for (let index = 0; index < selected.length; index++) selected[index].id = `candidate-${index + 1}`

  return {
    ok: true as const,
    entity_name: request.entity_name,
    center,
    radius,
    target_resource: request.target_resource,
    scanned,
    legal_candidate_count: candidates.length,
    returned_candidate_count: selected.length,
    candidates: selected,
  }
}
