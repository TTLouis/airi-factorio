import type { ControlledActor } from '../actors/types'
import { new_navigation_obstacle_recovery } from '../navigation_obstacle_recovery'
import type { PlayerParametersWalkToEntity } from '../types'

type ObstacleController = ReturnType<typeof new_navigation_obstacle_recovery>
type ObstacleStatus = ReturnType<ObstacleController['status']>

declare const storage: {
  airi_navigation_clear_obstacles?: boolean
  airi_navigation_obstacle_recovery?: any
  airi_follow_state?: any
  airi_swarm_navigation_clear_obstacles?: Record<string, boolean>
  airi_swarm_navigation_obstacle_recovery?: Record<string, any>
  airi_swarm_follow_states?: Record<string, any>
}

function ensure_maps() {
  if (storage.airi_swarm_navigation_clear_obstacles === undefined) storage.airi_swarm_navigation_clear_obstacles = {}
  if (storage.airi_swarm_navigation_obstacle_recovery === undefined) storage.airi_swarm_navigation_obstacle_recovery = {}
}

/**
 * Reuse the upstream natural-obstacle recovery algorithm without sharing its
 * singleton persistence. Calls are synchronous on Factorio's Lua thread, so
 * the logical actor state can be projected into the legacy slots for the call
 * and restored immediately afterward.
 */
export function new_actor_scoped_navigation_obstacle_recovery(actorId: string) {
  const base = new_navigation_obstacle_recovery()

  function scoped<T>(fn: () => T): T {
    ensure_maps()
    const primaryClear = storage.airi_navigation_clear_obstacles
    const primaryRecovery = storage.airi_navigation_obstacle_recovery
    const primaryFollow = storage.airi_follow_state
    const actorFollow = storage.airi_swarm_follow_states?.[actorId]

    storage.airi_navigation_clear_obstacles = storage.airi_swarm_navigation_clear_obstacles?.[actorId]
    storage.airi_navigation_obstacle_recovery = storage.airi_swarm_navigation_obstacle_recovery?.[actorId]
    storage.airi_follow_state = actorFollow
      ? { active: actorFollow.active === true, clear_obstacles: actorFollow.clear_obstacles !== false }
      : undefined

    try {
      const result = fn()
      ensure_maps()
      if (storage.airi_navigation_clear_obstacles === undefined) delete storage.airi_swarm_navigation_clear_obstacles![actorId]
      else storage.airi_swarm_navigation_clear_obstacles![actorId] = storage.airi_navigation_clear_obstacles
      if (storage.airi_navigation_obstacle_recovery === undefined) delete storage.airi_swarm_navigation_obstacle_recovery![actorId]
      else storage.airi_swarm_navigation_obstacle_recovery![actorId] = storage.airi_navigation_obstacle_recovery
      return result
    }
    finally {
      storage.airi_navigation_clear_obstacles = primaryClear
      storage.airi_navigation_obstacle_recovery = primaryRecovery
      storage.airi_follow_state = primaryFollow
    }
  }

  function set_enabled(enabled: boolean) {
    return scoped(() => base.set_enabled(enabled))
  }

  function enabled() {
    return scoped(() => base.enabled())
  }

  function suspend(actor: ControlledActor | undefined) {
    return scoped(() => base.suspend(actor))
  }

  function tick(actor: ControlledActor, task: PlayerParametersWalkToEntity | undefined) {
    return scoped(() => base.tick(actor, task))
  }

  function status(): ObstacleStatus {
    return scoped(() => base.status())
  }

  return { set_enabled, enabled, suspend, tick, status }
}
