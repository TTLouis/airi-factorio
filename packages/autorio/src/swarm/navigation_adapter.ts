import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { new_navigation_controller } from '../navigation'
import type { new_task_manager } from '../task_manager'

type Manager = ReturnType<typeof new_task_manager>
type NavigationStatus = ReturnType<ReturnType<typeof new_navigation_controller>['status']>
type NavigationResult = NavigationStatus['last_result']

declare const storage: {
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

function same_actor(actor: ControlledActor | undefined, result: NavigationResult) {
  if (!actor || !actor.is_valid || !result) return false
  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && result.actor_id === identity.actor_id
    && result.actor_kind === identity.kind
    && result.force_index === actor.force.index
}

/**
 * Keep the upstream NPC navigation controller intact and scope only its
 * persisted receipt/status projection per logical swarm actor.
 */
export function new_actor_scoped_navigation_controller(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
  manager: Manager,
) {
  const base = new_navigation_controller(get_actor, manager)

  function capture() {
    const result = base.status().last_result
    if (same_actor(get_actor(), result)) store_result(actorId, result)
  }

  function submit(entityName: string, searchRadius: number) {
    const accepted = base.submit(entityName, searchRadius)
    capture()
    return accepted
  }

  function submit_player(playerName: string, reachDistance?: number) {
    const result = reachDistance === undefined
      ? base.submit_player(playerName)
      : base.submit_player(playerName, reachDistance)
    capture()
    return result
  }

  function tick(actor: ControlledActor) {
    const result = base.tick(actor)
    capture()
    return result
  }

  function owns_path_request(requestId: number) {
    const task = manager.player_state.parameters_walk_to_entity
    return task?.path_request_id !== undefined && task.path_request_id === requestId
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const result = base.on_path_finished(event)
    capture()
    return result
  }

  function status() {
    const raw = base.status()
    const last = persisted_result(actorId)
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
      last_spatial_observation: raw.task_active ? raw.last_spatial_observation : last?.spatial_observation,
      last_result: last,
    }
  }

  return { submit, submit_player, tick, owns_path_request, on_path_finished, status }
}
