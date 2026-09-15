import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { new_combat_controller } from '../combat'
import type { new_task_manager } from '../task_manager'

type Manager = ReturnType<typeof new_task_manager>
type CombatStatus = ReturnType<ReturnType<typeof new_combat_controller>['status']>
type CombatResult = CombatStatus['last_result']

declare const storage: {
  airi_swarm_combat_results?: Record<string, CombatResult>
}

function persisted_result(key: string) {
  return storage.airi_swarm_combat_results?.[key]
}

function store_result(key: string, result: CombatResult) {
  if (result === undefined) return
  if (storage.airi_swarm_combat_results === undefined) storage.airi_swarm_combat_results = {}
  storage.airi_swarm_combat_results[key] = result
}

function same_actor(actor: ControlledActor | undefined, result: CombatResult) {
  if (!actor || !actor.is_valid || !result) return false
  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && result.actor_id === identity.actor_id
    && result.actor_kind === identity.kind
    && result.force_index === actor.force.index
}

/** Keep upstream combat behavior intact while namespacing receipts per swarm actor. */
export function new_actor_scoped_combat_controller(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
  manager: Manager,
) {
  const base = new_combat_controller(get_actor, manager)

  function capture() {
    const result = base.status().last_result
    if (same_actor(get_actor(), result)) store_result(actorId, result)
  }

  function submit(searchRadius: number) {
    const result = base.submit(searchRadius)
    capture()
    return result
  }

  function submit_clear(searchRadius: number) {
    const result = base.submit_clear(searchRadius)
    capture()
    return result
  }

  function tick(actor: ControlledActor) {
    const result = base.tick(actor)
    capture()
    return result
  }

  function owns_path_request(requestId: number) {
    const task = manager.player_state.parameters_attack_nearest_enemy as any
    return task?.combat_path_request_id !== undefined && task.combat_path_request_id === requestId
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const result = base.on_path_finished(event)
    capture()
    return result
  }

  function status() {
    return {
      ...base.status(),
      last_result: persisted_result(actorId),
    }
  }

  return { submit, submit_clear, tick, owns_path_request, on_path_finished, status }
}
