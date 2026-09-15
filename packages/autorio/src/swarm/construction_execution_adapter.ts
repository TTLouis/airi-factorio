import type { ControlledActor } from '../actors/types'
import type { new_basic_operation_controller } from '../basic_operations'
import {
  execute_validated_construction_plan,
  type ConstructionExecutionValidationRequest,
  validate_construction_execution_plan,
} from '../construction_execution'
import type { new_task_manager } from '../task_manager'

type BasicController = ReturnType<typeof new_basic_operation_controller>
type TaskManager = ReturnType<typeof new_task_manager>

declare const storage: {
  airi_validated_construction_plan?: any
  airi_next_construction_validation_id?: number
  airi_swarm_validated_construction_plans?: Record<string, any>
  airi_swarm_next_construction_validation_ids?: Record<string, number>
}

function ensure_maps() {
  if (storage.airi_swarm_validated_construction_plans === undefined) storage.airi_swarm_validated_construction_plans = {}
  if (storage.airi_swarm_next_construction_validation_ids === undefined) storage.airi_swarm_next_construction_validation_ids = {}
}

/**
 * Reuse the upstream validated-construction implementation without sharing its
 * singleton validation slot between logical swarm actors. Calls are
 * synchronous on Factorio's Lua thread, so the actor's scoped slot can be
 * projected into the legacy storage keys and restored immediately afterward.
 */
export function new_actor_scoped_construction_execution(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
  basic: BasicController,
  manager: TaskManager,
) {
  function scoped<T>(fn: () => T): T {
    ensure_maps()
    const primaryPlan = storage.airi_validated_construction_plan
    const primaryNextId = storage.airi_next_construction_validation_id

    storage.airi_validated_construction_plan = storage.airi_swarm_validated_construction_plans?.[actorId]
    storage.airi_next_construction_validation_id = storage.airi_swarm_next_construction_validation_ids?.[actorId]

    try {
      const result = fn()
      ensure_maps()
      if (storage.airi_validated_construction_plan === undefined) delete storage.airi_swarm_validated_construction_plans![actorId]
      else storage.airi_swarm_validated_construction_plans![actorId] = storage.airi_validated_construction_plan
      if (storage.airi_next_construction_validation_id === undefined) delete storage.airi_swarm_next_construction_validation_ids![actorId]
      else storage.airi_swarm_next_construction_validation_ids![actorId] = storage.airi_next_construction_validation_id
      return result
    }
    finally {
      storage.airi_validated_construction_plan = primaryPlan
      storage.airi_next_construction_validation_id = primaryNextId
    }
  }

  function validate(request: ConstructionExecutionValidationRequest) {
    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character) {
      return { ok: false as const, error: { code: 'ACTOR_UNAVAILABLE', message: 'controlled actor is unavailable' } }
    }
    return scoped(() => validate_construction_execution_plan(actor, request))
  }

  function execute(validationId: number, placementCount: number): [boolean, string] {
    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character) return [false, 'controlled actor is unavailable']
    return scoped(() => execute_validated_construction_plan(actor, validationId, placementCount, basic, manager))
  }

  function status() {
    ensure_maps()
    const plan = storage.airi_swarm_validated_construction_plans?.[actorId]
    return {
      actor_id: actorId,
      validated: plan !== undefined,
      validation_id: plan?.validation_id,
      plan_id: plan?.plan_id,
      created_tick: plan?.created_tick,
      placement_count: Array.isArray(plan?.placements) ? plan.placements.length : 0,
      next_validation_id: storage.airi_swarm_next_construction_validation_ids?.[actorId] ?? 0,
    }
  }

  return { validate, execute, status }
}
