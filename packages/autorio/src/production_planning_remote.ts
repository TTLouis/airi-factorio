import type { ControlledActor } from './actors/types'
import type { ProductionSolveResult } from './production_planning'
import type { LiveProductionSolveRequest } from './production_planning_live'
import { solve_live_production } from './production_planning_live'

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
  })
}
