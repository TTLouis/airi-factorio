import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { new_navigation_controller } from '../navigation'
import type { new_task_manager } from '../task_manager'

type Manager = ReturnType<typeof new_task_manager>
type NavigationStatus = ReturnType<ReturnType<typeof new_navigation_controller>['status']>
type NavigationResult = NavigationStatus['last_result']

declare const storage: {
  airi_last_navigation_result?: NavigationResult
  airi_swarm_navigation_results?: Record<string, NavigationResult>
}

function persisted_result(key: string) {
  return storage.airi_swarm_navigation_results?.[key]
}

function store_result(key: string, result: NavigationResult) {
  if (result === undefined) return
  if (storage.airi_swarm_navigation_results === undefined) storage.airi_swarm_navigation_results = {}
  storage.airi_swarm_navigation_results[key] = result
}

/**
 * Keep the upstream NPC navigation controller intact and scope its persisted
 * receipt/status projection per logical swarm actor. Any singleton receipt the
 * upstream controller writes is restored immediately so swarm work cannot
 * overwrite the primary NPC's receipt channel.
 */
export function new_actor_scoped_navigation_controller(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
  manager: Manager,
) {
  const base = new_navigation_controller(get_actor, manager)

  function capture_after(before: NavigationResult) {
    const after = storage.airi_last_navigation_result
    if (after !== undefined && after !== before) store_result(actorId, after)
    if (after !== before) storage.airi_last_navigation_result = before
  }

  function submit(entityName: string, searchRadius: number) {
    const before = storage.airi_last_navigation_result
    const accepted = base.submit(entityName, searchRadius)
    capture_after(before)
    return accepted
  }

  function submit_player(playerName: string, reachDistance?: number) {
    const before = storage.airi_last_navigation_result
    const result = reachDistance === undefined
      ? base.submit_player(playerName)
      : base.submit_player(playerName, reachDistance)
    capture_after(before)
    return result
  }

  function tick(actor: ControlledActor) {
    const before = storage.airi_last_navigation_result
    const result = base.tick(actor)
    capture_after(before)
    return result
  }

  function owns_path_request(requestId: number) {
    const task = manager.player_state.parameters_walk_to_entity
    return task?.path_request_id !== undefined && task.path_request_id === requestId
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const before = storage.airi_last_navigation_result
    const result = base.on_path_finished(event)
    capture_after(before)
    return result
  }

  function status() {
    const raw = base.status()
    const last = persisted_result(actorId)
    const task = manager.player_state.parameters_walk_to_entity as any
    const blocked = !raw.task_active
      && last !== undefined
      && ['unreachable', 'path_timeout', 'stuck', 'path_busy'].indexOf(last.code) >= 0
    return {
      ...raw,
      state: raw.task_active
        ? raw.state
        : blocked
          ? 'blocked'
          : last?.code === 'reached'
            ? 'reached'
            : 'idle',
      blocked_reason: blocked ? last?.blocked_reason ?? last?.code : undefined,
      last_spatial_observation: task?.last_spatial_observation ?? last?.spatial_observation,
      last_result: last,
    }
  }

  return { submit, submit_player, tick, owns_path_request, on_path_finished, status }
}
