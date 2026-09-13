import type { ControlledActor } from './types'
import { ConnectedPlayerActor } from './connected_player_actor'
import { StandaloneCharacterActor } from './standalone_character_actor'

export type ActorMode = 'player' | 'npc'

declare const storage: {
  airi_actor_mode?: ActorMode
}

let standalone_actor: StandaloneCharacterActor | undefined

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

function get_npc_actor(): ControlledActor | undefined {
  if (standalone_actor?.is_valid) {
    return standalone_actor
  }

  const surface = game.surfaces[1]
  const force = game.forces.player
  if (!surface || !force) {
    return undefined
  }

  standalone_actor = StandaloneCharacterActor.reacquire(surface)
  if (standalone_actor?.is_valid) {
    return standalone_actor
  }

  const spawn_position = force.get_spawn_position(surface)
  const position = surface.find_non_colliding_position('character', spawn_position, 32, 0.5) ?? spawn_position
  standalone_actor = StandaloneCharacterActor.create(surface, force, position)
  return standalone_actor
}

export function get_controlled_actor(): ControlledActor | undefined {
  if (get_actor_mode() === 'npc') {
    return get_npc_actor()
  }
  return get_player_actor()
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
      }
    },
  })
}
