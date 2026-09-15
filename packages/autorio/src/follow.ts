import type { ControlledActor } from './actors/types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MIN_FOLLOW_DISTANCE = 1
const MAX_FOLLOW_DISTANCE = 64
const FOLLOW_HYSTERESIS = 1.5
const FOLLOW_REPATH_COOLDOWN_TICKS = 2 * 60

type FollowCode = 'following' | 'holding' | 'stopped' | 'no_actor' | 'invalid_player' | 'player_unavailable' | 'different_surface' | 'navigation_blocked'
type NavigateToPlayer = (player_name: string, reach_distance: number) => [boolean, string]

interface FollowState {
  active: boolean
  player_name?: string
  follow_distance?: number
  code: FollowCode
  updated_tick: number
  last_navigation_tick?: number
}

declare const storage: {
  airi_follow_state?: FollowState
}

function current_state(): FollowState {
  if (!storage.airi_follow_state) {
    storage.airi_follow_state = {
      active: false,
      code: 'stopped',
      updated_tick: game.tick,
    }
  }
  return storage.airi_follow_state
}

function stop_walking(actor: ControlledActor | undefined) {
  if (!actor || !actor.is_valid || !actor.character) return
  actor.set_walking_state({ walking: false, direction: defines.direction.north })
}

export function new_follow_controller(get_actor: () => ControlledActor | undefined, navigate_to_player?: NavigateToPlayer) {
  function submit(player_name: string, follow_distance: number = 4): [boolean, string] {
    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character) {
      storage.airi_follow_state = { active: false, code: 'no_actor', updated_tick: game.tick }
      return [false, 'No controlled actor']
    }
    if (typeof player_name !== 'string' || player_name.length === 0) {
      storage.airi_follow_state = { active: false, code: 'invalid_player', updated_tick: game.tick }
      return [false, 'player_name is required']
    }

    const bounded_distance = math.max(MIN_FOLLOW_DISTANCE, math.min(MAX_FOLLOW_DISTANCE, follow_distance || 4))
    const player = game.get_player(player_name)
    if (!player || !player.valid) {
      storage.airi_follow_state = {
        active: false,
        player_name,
        follow_distance: bounded_distance,
        code: 'invalid_player',
        updated_tick: game.tick,
      }
      return [false, 'Player does not exist']
    }

    storage.airi_follow_state = {
      active: true,
      player_name,
      follow_distance: bounded_distance,
      code: (!player.connected || !player.character)
        ? 'player_unavailable'
        : player.surface.index !== actor.surface.index
          ? 'different_surface'
          : 'following',
      updated_tick: game.tick,
    }

    if (!player.connected || !player.character) {
      stop_walking(actor)
      return [true, `Follow armed for ${player_name}; waiting for the player to be available`]
    }
    if (player.surface.index !== actor.surface.index) {
      stop_walking(actor)
      return [true, `Follow armed for ${player_name}; waiting for the player to return to this surface`]
    }
    return [true, `Following ${player_name}`]
  }

  function stop(): [boolean, string] {
    const actor = get_actor()
    stop_walking(actor)
    storage.airi_follow_state = {
      active: false,
      code: 'stopped',
      updated_tick: game.tick,
    }
    return [true, 'Follow mode stopped']
  }

  function suspend(actor: ControlledActor) {
    const state = current_state()
    if (!state.active) return
    stop_walking(actor)
  }

  function tick(actor: ControlledActor) {
    const state = current_state()
    if (!state.active || !state.player_name) return

    const player = game.get_player(state.player_name)
    if (!player || !player.valid) {
      stop_walking(actor)
      state.active = false
      state.code = 'invalid_player'
      state.updated_tick = game.tick
      return
    }

    // Disconnects, death screens and the short respawn window are transient.
    // Keep the follow intent armed so the same named LuaPlayer is reacquired
    // automatically after reconnect/respawn, including a replacement character.
    if (!player.connected || !player.character) {
      stop_walking(actor)
      state.code = 'player_unavailable'
      state.updated_tick = game.tick
      return
    }
    if (player.surface.index !== actor.surface.index) {
      stop_walking(actor)
      state.code = 'different_surface'
      state.updated_tick = game.tick
      return
    }

    const follow_distance = state.follow_distance ?? 4
    const current_distance = distance(actor.position, player.position)
    if (current_distance <= follow_distance) {
      stop_walking(actor)
      state.code = 'holding'
      state.updated_tick = game.tick
      return
    }

    if (state.code === 'holding' && current_distance <= follow_distance + FOLLOW_HYSTERESIS) {
      stop_walking(actor)
      return
    }

    if (navigate_to_player) {
      stop_walking(actor)
      if (state.last_navigation_tick !== undefined && game.tick - state.last_navigation_tick < FOLLOW_REPATH_COOLDOWN_TICKS) {
        return
      }
      const [accepted] = navigate_to_player(state.player_name, follow_distance)
      state.last_navigation_tick = game.tick
      state.code = accepted ? 'following' : 'navigation_blocked'
      state.updated_tick = game.tick
      return
    }

    // Legacy/local fallback for callers that do not wire the shared navigation
    // controller. Production Autorio supplies navigate_to_player so persistent
    // follow receives the same cliff/water-aware pathfinding as walk_to_player.
    actor.set_walking_state({
      walking: true,
      direction: direction_towards(actor.position, player.position),
    })
    state.code = 'following'
    state.updated_tick = game.tick
  }

  function status() {
    const state = current_state()
    const actor = get_actor()
    const player = state.player_name ? game.get_player(state.player_name) : undefined
    return {
      ...state,
      actor: actor?.status_snapshot(),
      player: player && player.valid
        ? {
            name: player.name,
            connected: player.connected,
            has_character: !!player.character,
            surface: player.surface.name,
            position: player.character ? player.position : undefined,
            distance: actor && player.character && player.surface.index === actor.surface.index
              ? distance(actor.position, player.position)
              : undefined,
          }
        : undefined,
    }
  }

  return { submit, stop, suspend, tick, status }
}
