import type { ControlledActor } from './actors/types'
import type { ConstructionObservationRequest, PlacementPlanRequest } from './construction_planning'
import type { ProductionSolveResult } from './production_planning'
import type { LiveProductionSolveRequest } from './production_planning_live'
import type { ThroughputCapacityRequest } from './throughput_capacity'
import { local_spatial_observation, plan_placement, select_navigation_escape_point } from './construction_planning'
import { solve_live_production } from './production_planning_live'
import { throughput_capacity } from './throughput_capacity'

export function create_production_planning_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_planning', {
    solve: (request: LiveProductionSolveRequest): ProductionSolveResult => {
      const actor = get_actor()
      if (!actor) {
        return {
          ok: false,
          calculation_id: request?.calculation_id,
          error: {
            code: 'INVALID_REQUEST',
            message: 'controlled actor is unavailable',
          },
        }
      }
      return solve_live_production(actor, request)
    },
    capacity: (request: ThroughputCapacityRequest) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' } }
      return throughput_capacity(actor, request)
    },
    spatial_observation: (request: ConstructionObservationRequest = {}) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: 'controlled actor is unavailable' }
      return local_spatial_observation(actor, request)
    },
    plan_placement: (request: PlacementPlanRequest) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' } }
      return plan_placement(actor, request)
    },
    navigation_escape: (target_position: { x: number, y: number }, radius: number = 6) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: 'controlled actor is unavailable' }
      return select_navigation_escape_point(actor, target_position, radius)
    },
  })
}
