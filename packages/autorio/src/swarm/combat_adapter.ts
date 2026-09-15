import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { new_combat_controller } from '../combat'
import type { new_task_manager } from '../task_manager'

type Manager = ReturnType<typeof new_task_manager>
type CombatStatus = ReturnType<ReturnType<typeof new_combat_controller>['status']>
type CombatResult = CombatStatus['last_result']

declare const storage: {
  airi_last_combat_result?: CombatResult
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

/**
 * Keep the upstream NPC combat controller intact while namespacing receipts
 * per logical swarm actor. Restore the singleton upstream receipt immediately
 * so swarm combat cannot overwrite the primary NPC's status channel.
 */
export function new_actor_scoped_combat_controller(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
  manager: Manager,
) {
  const base = new_combat_controller(get_actor, manager)

  function capture_after(before: CombatResult) {
    const after = storage.airi_last_combat_result
    if (after !== undefined && after !== before) store_result(actorId, after)
    if (after !== before) storage.airi_last_combat_result = before
  }

  function submit(searchRadius: number) {
    const before = storage.airi_last_combat_result
    const result = base.submit(searchRadius)
    capture_after(before)
    return result
  }

  function submit_clear(searchRadius: number) {
    const before = storage.airi_last_combat_result
    const result = base.submit_clear(searchRadius)
    capture_after(before)
    return result
  }

  function tick(actor: ControlledActor) {
    const before = storage.airi_last_combat_result
    const result = base.tick(actor)
    capture_after(before)
    return result
  }

  function owns_path_request(requestId: number) {
    const task = manager.player_state.parameters_attack_nearest_enemy as any
    return task?.combat_path_request_id !== undefined && task.combat_path_request_id === requestId
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const before = storage.airi_last_combat_result
    const result = base.on_path_finished(event)
    capture_after(before)
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
