import type { ControlledActor } from './types'
import { ConnectedPlayerActor } from './connected_player_actor'
import { StandaloneCharacterActor } from './standalone_character_actor'

export type ActorMode = 'player' | 'npc'

declare const storage: {
  airi_actor_mode?: ActorMode
}

let standalone_actor: StandaloneCharacterActor | undefined
let post_load_reconciliation_pending = false
let last_reconciled_actor_id: number | undefined
let last_reconciled_tick: number | undefined

// Factorio does not persist ordinary Lua module locals across save/load. Autorio's
// logical task manager is therefore intentionally volatile for now, while the
// standalone character entity and its engine control states are persisted in the
// save. on_load cannot access `game` or mutate `storage`, so it only marks local
// work for the first normal runtime resolution of the NPC.
script.on_load(() => {
  standalone_actor = undefined
  post_load_reconciliation_pending = true
  last_reconciled_actor_id = undefined
  last_reconciled_tick = undefined
})

export function get_actor_mode(): ActorMode {
  return storage.airi_actor_mode ?? 'player'
}

export function set_actor_mode(mode: ActorMode): ActorMode {
  storage.airi_actor_mode = mode
  standalone_actor = undefined
  return mode
}

function get_player_actor(): ControlledActor | undefined {
  const player = game.connected_players[0]
  if (!player) {
    return undefined
  }
  return new ConnectedPlayerActor(player)
}

function reconcile_loaded_npc(actor: StandaloneCharacterActor) {
  if (!post_load_reconciliation_pending) {
    return
  }

  // Logical Autorio tasks are not resumed across a save/load boundary. Clear
  // the engine-owned physical inputs that *are* serialized with the character,
  // otherwise a freshly loaded NPC could keep walking/mining/shooting with no
  // task left to own or stop that action.
  actor.set_walking_state({ walking: false, direction: defines.direction.north })
  actor.set_mining_state({ mining: false })
  actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  rendering.clear()

  const identity = actor.status_snapshot()
  last_reconciled_actor_id = identity.actor_id
  last_reconciled_tick = game.tick
  post_load_reconciliation_pending = false
  log(`[AUTORIO] Reconciled loaded NPC controls for actor_id=${identity.actor_id ?? 'unknown'}`)
}

function get_npc_actor(): ControlledActor | undefined {
  if (standalone_actor?.is_valid) {
    reconcile_loaded_npc(standalone_actor)
    return standalone_actor
  }

  const surface = game.surfaces[1]
  const force = game.forces.player
  if (!surface || !force) {
    return undefined
  }

  standalone_actor = StandaloneCharacterActor.reacquire(surface)
  if (standalone_actor?.is_valid) {
    reconcile_loaded_npc(standalone_actor)
    return standalone_actor
  }

  const spawn_position = force.get_spawn_position(surface)
  const position = surface.find_non_colliding_position('character', spawn_position, 32, 0.5) ?? spawn_position
  standalone_actor = StandaloneCharacterActor.create(surface, force, position)
  if (standalone_actor?.is_valid) {
    reconcile_loaded_npc(standalone_actor)
  }
  return standalone_actor
}

export function get_controlled_actor(): ControlledActor | undefined {
  if (get_actor_mode() === 'npc') {
    return get_npc_actor()
  }
  return get_player_actor()
}

export function get_load_reconciliation_status() {
  return {
    policy: 'discard_autorio_tasks_and_stop_npc_controls_on_load',
    pending: post_load_reconciliation_pending,
    last_actor_id: last_reconciled_actor_id,
    last_tick: last_reconciled_tick,
  }
}

export function create_actor_remote_interface() {
  remote.add_interface('autorio_actor', {
    get_mode: () => get_actor_mode(),
    set_mode: (mode: string) => {
      if (mode !== 'player' && mode !== 'npc') {
        return [false, `Invalid actor mode: ${mode}`]
      }

      set_actor_mode(mode)
      const actor = get_controlled_actor()
      return [true, actor?.status_snapshot()]
    },
    status: () => {
      const actor = get_controlled_actor()
      return {
        mode: get_actor_mode(),
        actor: actor?.status_snapshot(),
        connected_players: game.connected_players.length,
        load_reconciliation: get_load_reconciliation_status(),
      }
    },
  })
}
