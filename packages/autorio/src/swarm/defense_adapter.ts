import type { ControlledActor } from '../actors/types'
import { new_defense_controller } from '../defense'

type DefenseController = ReturnType<typeof new_defense_controller>
type DefenseState = ReturnType<DefenseController['status']>

declare const storage: {
  airi_defense_state?: any
  airi_swarm_defense_states?: Record<string, any>
}

function scoped_state(actorId: string) {
  return storage.airi_swarm_defense_states?.[actorId]
}

function store_scoped_state(actorId: string, state: any) {
  if (storage.airi_swarm_defense_states === undefined) storage.airi_swarm_defense_states = {}
  storage.airi_swarm_defense_states[actorId] = state
}

/**
 * The upstream defense controller is synchronous and only persists through
 * storage.airi_defense_state. Temporarily project the logical actor's state
 * into that legacy slot for each call, then restore the primary NPC slot.
 */
export function new_actor_scoped_defense_controller(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
) {
  const base = new_defense_controller(get_actor)

  function scoped<T>(fn: () => T): T {
    const primary = storage.airi_defense_state
    storage.airi_defense_state = scoped_state(actorId)
    try {
      const result = fn()
      store_scoped_state(actorId, storage.airi_defense_state)
      return result
    }
    finally {
      storage.airi_defense_state = primary
    }
  }

  function set_enabled(enabled: boolean) {
    return scoped(() => base.set_enabled(enabled))
  }

  function suspend(actor?: ControlledActor) {
    return scoped(() => base.suspend(actor))
  }

  function tick(actor: ControlledActor) {
    return scoped(() => base.tick(actor))
  }

  function status(): DefenseState {
    return scoped(() => base.status())
  }

  return { set_enabled, suspend, tick, status }
}
