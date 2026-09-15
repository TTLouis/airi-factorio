import type { ControlledActor } from '../actors/types'
import { distance } from '../utils/math'
import type { new_actor_scoped_navigation_controller } from './navigation_adapter'

const MIN_FOLLOW_DISTANCE = 1
const MAX_FOLLOW_DISTANCE = 64
const FOLLOW_HYSTERESIS = 1.5
const FOLLOW_REPATH_COOLDOWN_TICKS = 2 * 60
const BLOCKED_RETRY_TARGET_MOVEMENT = 6

type NavigationController = ReturnType<typeof new_actor_scoped_navigation_controller>
type FollowRuntimeState = 'following' | 'holding' | 'paused' | 'blocked' | 'stopped'
type FollowCode = 'following' | 'holding' | 'stopped' | 'no_actor' | 'invalid_player' | 'player_unavailable' | 'different_surface' | 'navigation_blocked'

interface FollowState {
  active: boolean
  state: FollowRuntimeState
  player_name?: string
  follow_distance?: number
  clear_obstacles?: boolean
  code: FollowCode
  updated_tick: number
  last_navigation_tick?: number
  blocked_reason?: string
  blocked_target_position?: { x: number, y: number }
}

declare const storage: {
  airi_swarm_follow_states?: Record<string, FollowState>
}

function state_for(actorId: string) {
  if (storage.airi_swarm_follow_states === undefined) storage.airi_swarm_follow_states = {}
  let state = storage.airi_swarm_follow_states[actorId]
  if (state === undefined) {
    state = { active: false, state: 'stopped', code: 'stopped', clear_obstacles: true, updated_tick: game.tick }
    storage.airi_swarm_follow_states[actorId] = state
  }
  if (state.clear_obstacles === undefined) state.clear_obstacles = true
  return state
}

function replace_state(actorId: string, state: FollowState) {
  if (storage.airi_swarm_follow_states === undefined) storage.airi_swarm_follow_states = {}
  storage.airi_swarm_follow_states[actorId] = state
  return state
}

function copy_position(position: { x: number, y: number } | undefined) {
  return position ? { x: position.x, y: position.y } : undefined
}

function moved_materially(a: { x: number, y: number } | undefined, b: { x: number, y: number } | undefined) {
  return !!a && !!b && distance(a, b) >= BLOCKED_RETRY_TARGET_MOVEMENT
}

function stop_walking(actor: ControlledActor | undefined) {
  if (!actor || !actor.is_valid || !actor.character) return
  actor.set_walking_state({ walking: false, direction: defines.direction.north })
}

export function new_actor_scoped_follow_controller(
  actorId: string,
  get_actor: () => ControlledActor | undefined,
  navigation: NavigationController,
) {
  function submit(player_name: string, follow_distance: number = 4, clear_obstacles: boolean = true): [boolean, string] {
    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character) {
      replace_state(actorId, { active: false, state: 'stopped', code: 'no_actor', clear_obstacles, updated_tick: game.tick })
      return [false, 'No controlled actor']
    }
    if (typeof player_name !== 'string' || player_name.length === 0) {
      replace_state(actorId, { active: false, state: 'stopped', code: 'invalid_player', clear_obstacles, updated_tick: game.tick })
      return [false, 'player_name is required']
    }

    const bounded_distance = math.max(MIN_FOLLOW_DISTANCE, math.min(MAX_FOLLOW_DISTANCE, follow_distance || 4))
    const player = game.get_player(player_name)
    if (!player || !player.valid) {
      replace_state(actorId, { active: false, state: 'stopped', player_name, follow_distance: bounded_distance, clear_obstacles, code: 'invalid_player', updated_tick: game.tick })
      return [false, 'Player does not exist']
    }

    replace_state(actorId, {
      active: true,
      state: (!player.connected || !player.character || player.surface.index !== actor.surface.index) ? 'paused' : 'following',
      player_name,
      follow_distance: bounded_distance,
      clear_obstacles,
      code: (!player.connected || !player.character)
        ? 'player_unavailable'
        : player.surface.index !== actor.surface.index
          ? 'different_surface'
          : 'following',
      updated_tick: game.tick,
    })

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
    stop_walking(get_actor())
    const previous = state_for(actorId)
    replace_state(actorId, {
      active: false,
      state: 'stopped',
      player_name: previous.player_name,
      follow_distance: previous.follow_distance,
      clear_obstacles: previous.clear_obstacles,
      code: 'stopped',
      updated_tick: game.tick,
    })
    return [true, 'Follow mode stopped']
  }

  function suspend(actor?: ControlledActor) {
    const state = state_for(actorId)
    if (!state.active) return
    stop_walking(actor ?? get_actor())
  }

  function navigation_blocked(playerName: string) {
    const nav = navigation.status()
    if (nav.task_active) return undefined
    const last = nav.last_result
    if (!last || last.player_name !== playerName) return undefined
    if (['unreachable', 'path_timeout', 'stuck', 'path_busy'].indexOf(last.code ?? '') < 0) return undefined
    return last.blocked_reason ?? last.code
  }

  function tick(actor: ControlledActor) {
    const state = state_for(actorId)
    if (!state.active || !state.player_name) return

    const player = game.get_player(state.player_name)
    if (!player || !player.valid) {
      stop_walking(actor)
      state.active = false
      state.state = 'stopped'
      state.code = 'invalid_player'
      state.updated_tick = game.tick
      return
    }
    if (!player.connected || !player.character) {
      stop_walking(actor)
      state.state = 'paused'
      state.code = 'player_unavailable'
      state.updated_tick = game.tick
      return
    }
    if (player.surface.index !== actor.surface.index) {
      stop_walking(actor)
      state.state = 'paused'
      state.code = 'different_surface'
      state.updated_tick = game.tick
      return
    }

    const followDistance = state.follow_distance ?? 4
    const currentDistance = distance(actor.position, player.position)
    if (currentDistance <= followDistance) {
      stop_walking(actor)
      state.state = 'holding'
      state.code = 'holding'
      state.blocked_reason = undefined
      state.blocked_target_position = undefined
      state.updated_tick = game.tick
      return
    }
    if (state.state === 'holding' && currentDistance <= followDistance + FOLLOW_HYSTERESIS) {
      stop_walking(actor)
      return
    }

    const nav = navigation.status()
    if (nav.task_active && nav.player_name === state.player_name) {
      state.state = 'following'
      state.code = 'following'
      state.blocked_reason = undefined
      state.updated_tick = game.tick
      return
    }

    const blockedReason = navigation_blocked(state.player_name)
    if (blockedReason) {
      const blockedAt = state.blocked_target_position
      if (!blockedAt || !moved_materially(blockedAt, player.position)) {
        stop_walking(actor)
        state.state = 'blocked'
        state.code = 'navigation_blocked'
        state.blocked_reason = blockedReason
        state.blocked_target_position = blockedAt ?? copy_position(player.position)
        state.updated_tick = game.tick
        return
      }
      state.blocked_reason = undefined
      state.blocked_target_position = undefined
    }

    if (state.last_navigation_tick !== undefined && game.tick - state.last_navigation_tick < FOLLOW_REPATH_COOLDOWN_TICKS) return
    const [accepted] = navigation.submit_player(state.player_name, followDistance)
    state.last_navigation_tick = game.tick
    state.state = accepted ? 'following' : 'blocked'
    state.code = accepted ? 'following' : 'navigation_blocked'
    state.blocked_reason = accepted ? undefined : 'navigation_admission_rejected'
    state.blocked_target_position = accepted ? undefined : copy_position(player.position)
    state.updated_tick = game.tick
  }

  function status() {
    const state = state_for(actorId)
    const actor = get_actor()
    const player = state.player_name ? game.get_player(state.player_name) : undefined
    const nav = navigation.status()
    const currentDistance = actor && player?.valid && player.character && player.surface.index === actor.surface.index
      ? distance(actor.position, player.position)
      : undefined
    const liveNavigation = state.active && nav.task_active === true && nav.player_name === state.player_name
    const holding = state.active && state.state === 'holding' && currentDistance !== undefined && currentDistance <= (state.follow_distance ?? 4) + FOLLOW_HYSTERESIS
    return {
      ...state,
      target_player: state.player_name,
      desired_distance: state.follow_distance,
      healthy: liveNavigation || holding,
      controller_live: liveNavigation || holding,
      current_distance: currentDistance,
      last_position: actor ? { x: actor.position.x, y: actor.position.y } : undefined,
      last_progress_tick: nav.path?.physical_last_progress_tick ?? nav.path?.last_progress_tick ?? (holding ? game.tick : undefined),
      stuck_for_ticks: nav.path?.physical_stuck_for_ticks ?? nav.path?.stuck_for_ticks,
      path_request_id: nav.path?.request_id,
      path_attempts: nav.path?.attempts,
      waypoints_remaining: nav.path?.waypoints_remaining,
      last_repath_tick: nav.path?.last_repath_tick,
      last_failure: state.blocked_reason ?? nav.blocked_reason ?? nav.path?.last_recovery_reason,
      navigation: {
        active: nav.task_active === true,
        state: nav.state,
        player_name: nav.player_name,
        blocked_reason: nav.blocked_reason,
        path: nav.path,
      },
      actor: actor?.status_snapshot(),
      player: player && player.valid
        ? {
            name: player.name,
            connected: player.connected,
            has_character: !!player.character,
            surface: player.surface.name,
            position: player.character ? player.position : undefined,
            distance: currentDistance,
          }
        : undefined,
    }
  }

  return { submit, stop, suspend, tick, status }
}
