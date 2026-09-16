import type { ControlledActor } from './actors/types'

const INTERACTION_REACH_MARGIN = 0.25
const MIN_INTERACTION_REACH = 0.75
const FALLBACK_ENTITY_REACH = 8
const FALLBACK_BUILD_REACH = 10

function bounded_reach(raw: unknown, fallback: number) {
  const value = typeof raw === 'number' && raw === raw && raw > 0 && raw < math.huge ? raw : fallback
  return math.max(MIN_INTERACTION_REACH, value - INTERACTION_REACH_MARGIN)
}

/**
 * Player-equivalent reach for entity interactions such as inventory transfer,
 * recipe configuration, and rotation. Keep execution and auto-approach using
 * the same value so a task cannot be considered reachable by recovery and then
 * rejected as too_far by the operation runtime on the next tick.
 */
export function entity_interaction_reach(actor: ControlledActor) {
  return bounded_reach((actor.character as any)?.reach_distance, FALLBACK_ENTITY_REACH)
}

/** Player-equivalent build reach for exact-position placement. */
export function build_interaction_reach(actor: ControlledActor) {
  return bounded_reach((actor.character as any)?.build_distance, FALLBACK_BUILD_REACH)
}
