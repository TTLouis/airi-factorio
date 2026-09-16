import type { ControlledActor } from './actors/types'
import type { ConstructionExecutionValidationRequest } from './construction_execution'
import type { ConstructionObservationRequest, PlacementPlanRequest } from './construction_planning'
import type { LiveProductionCandidateSolveResult } from './production_planning_candidates_live'
import type { LiveProductionSolveRequest } from './production_planning_live'
import type { ThroughputCapacityRequest } from './throughput_capacity'
import type { ThroughputMeasurementRequest } from './throughput_measurement'
import { validate_construction_execution_plan } from './construction_execution'
import { local_spatial_observation, plan_placement, select_navigation_escape_point } from './construction_planning'
import { solve_live_production_candidates } from './production_planning_candidates_live'
import { plan_research_path } from './research_path'
import { throughput_capacity } from './throughput_capacity'
import { new_throughput_measurement_controller } from './throughput_measurement'

export function create_production_planning_remote_interface(
  get_actor: () => ControlledActor | undefined,
  injected_throughput_measurement?: ReturnType<typeof new_throughput_measurement_controller>,
) {
  const throughput_measurement = injected_throughput_measurement ?? new_throughput_measurement_controller(get_actor)
  if (!injected_throughput_measurement) script.on_nth_tick(1, () => throughput_measurement.tick())

  remote.add_interface('autorio_planning', {
    solve: (request: LiveProductionSolveRequest): LiveProductionCandidateSolveResult => {
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
      return solve_live_production_candidates(actor, request)
    },
    capacity: (request: ThroughputCapacityRequest) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' } }
      return throughput_capacity(actor, request)
    },
    throughput_measurement_start: (request: ThroughputMeasurementRequest) => throughput_measurement.start(request),
    throughput_measurement_status: (measurement_id: number) => throughput_measurement.status(measurement_id),
    throughput_measurement_cancel: (measurement_id: number) => throughput_measurement.cancel(measurement_id),
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
    validate_construction_plan: (request: ConstructionExecutionValidationRequest) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' } }
      return validate_construction_execution_plan(actor, request)
    },
    research_path: (name: string, max_nodes: number = 32) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' } }
      return plan_research_path(actor, name, max_nodes)
    },
    navigation_escape: (target_position: { x: number, y: number }, radius: number = 6) => {
      const actor = get_actor()
      if (!actor) return { ok: false, error: 'controlled actor is unavailable' }
      return select_navigation_escape_point(actor, target_position, radius)
    },
  })
}
