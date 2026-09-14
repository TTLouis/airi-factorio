import type { BoundingBoxArray, CollisionMask, LuaEntity, OnScriptPathRequestFinishedEvent, PathfinderWaypoint } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersWalkToEntity } from './types'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MAX_SEARCH_RADIUS = 256
const MAX_NAVIGATION_TICKS = 60 * 60
const PATH_REQUEST_TIMEOUT_TICKS = 15 * 60
const STUCK_TICKS = 10 * 60
const PATH_RETRY_DELAY_TICKS = 30
const MAX_PATH_ATTEMPTS = 4
const WAYPOINT_REACHED_DISTANCE = 0.5
const TARGET_REACHED_DISTANCE = 2.5
const TARGET_REPATH_DISTANCE = 4
const PROGRESS_DISTANCE = 0.25

type NavigationCode = 'started' | 'reached' | 'no_actor' | 'invalid_radius' | 'invalid_entity_name'
  | 'no_target' | 'actor_changed' | 'target_gone' | 'path_start_unavailable'
  | 'path_busy' | 'unreachable' | 'path_timeout' | 'stuck' | 'timeout'

interface NavigationResult {
  accepted: boolean
  completed: boolean
  code: NavigationCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  entity_name?: string
  target_unit_number?: number
  target_position?: { x: number, y: number }
  path_request_id?: number
  path_attempts?: number
}

declare const storage: {
  airi_last_navigation_result?: NavigationResult
}

function valid_radius(radius: number) {
  return typeof radius === 'number'
    && radius === math.floor(radius)
    && radius >= 1
    && radius <= MAX_SEARCH_RADIUS
}

function copy_position(position: { x: number, y: number }) {
  return { x: position.x, y: position.y }
}

function nearest(actor: ControlledActor, entities: LuaEntity[]) {
  let result: LuaEntity | undefined
  let best = math.huge
  for (const entity of entities) {
    const candidate = distance(actor.position, entity.position)
    if (candidate < best) {
      best = candidate
      result = entity
    }
  }
  return result
}

function identity_matches(actor: ControlledActor, task: PlayerParametersWalkToEntity) {
  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function draw_path(actor: ControlledActor, path: PathfinderWaypoint[]) {
  for (let i = 0; i < path.length - 1; i++) {
    rendering.draw_line({
      color: { r: 0, g: 1, b: 0 },
      width: 2,
      from: path[i].position,
      to: path[i + 1].position,
      surface: actor.surface,
      time_to_live: 600,
      draw_on_ground: true,
    })
  }
}

function record(actor: ControlledActor | undefined, task: PlayerParametersWalkToEntity | undefined, accepted: boolean, completed: boolean, code: NavigationCode): NavigationResult {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: NavigationResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    entity_name: task?.entity_name,
    target_unit_number: task?.target_unit_number,
    target_position: task?.target_position ? copy_position(task.target_position) : undefined,
    path_request_id: task?.path_request_id,
    path_attempts: task?.path_attempts,
  }
  storage.airi_last_navigation_result = result
  return result
}

export function new_navigation_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function fail(actor: ControlledActor | undefined, task: PlayerParametersWalkToEntity, code: NavigationCode) {
    record(actor, task, false, false, code)
    rendering.clear()
    if (actor && identity_matches(actor, task)) {
      manager.cancel_all_tasks()
    }
    else {
      manager.discard_all_tasks_after_actor_loss()
    }
    log(`[AUTORIO] [ERROR] Navigation task failed: ${code}; queued operations cancelled`)
  }

  function complete(actor: ControlledActor, task: PlayerParametersWalkToEntity) {
    record(actor, task, true, true, 'reached')
    rendering.clear()
    manager.reset_task_state()
    manager.next_task()
    log(`[AUTORIO] Navigation task complete: reached ${task.entity_name}`)
  }

  function submit(entity_name: string, search_radius: number): boolean {
    if (typeof entity_name !== 'string' || entity_name.length === 0) {
      record(get_actor(), undefined, false, false, 'invalid_entity_name')
      return false
    }
    if (!valid_radius(search_radius)) {
      record(get_actor(), undefined, false, false, 'invalid_radius')
      return false
    }

    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      record(actor, undefined, false, false, 'no_actor')
      return false
    }

    manager.add_task({
      type: TaskStates.WALKING_TO_ENTITY,
      entity_name,
      search_radius,
      path: null,
      path_drawn: false,
      path_index: 1,
      calculating_path: false,
      target_position: null,
      target: null,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
      path_attempts: 0,
    })
    return true
  }

  function request_path(actor: ControlledActor, task: PlayerParametersWalkToEntity) {
    const character = actor.character
    if (!character) {
      fail(actor, task, 'no_actor')
      return false
    }
    if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
      fail(actor, task, 'path_timeout')
      return false
    }

    const start = actor.surface.find_non_colliding_position(
      'iron-chest',
      character.position,
      10,
      0.5,
      false,
    )
    if (!start) {
      fail(actor, task, 'path_start_unavailable')
      return false
    }

    const target = task.target
    if (!target || !target.valid) {
      fail(actor, task, 'target_gone')
      return false
    }

    const bbox: BoundingBoxArray = [[-0.5, -0.5], [0.5, 0.5]]
    const collision_mask: CollisionMask = {
      layers: {
        player: true,
        train: true,
        water_tile: true,
        object: true,
      },
      consider_tile_transitions: true,
    }

    task.path_attempts = (task.path_attempts ?? 0) + 1
    task.target_position = copy_position(target.position)
    task.path_request_id = actor.surface.request_path({
      bounding_box: bbox,
      collision_mask,
      radius: 2,
      start,
      goal: task.target_position,
      force: actor.force,
      entity_to_ignore: character,
      pathfind_flags: {
        cache: false,
        no_break: true,
        prefer_straight_paths: false,
        allow_paths_through_own_entities: false,
      },
    })
    task.path_requested_tick = game.tick
    task.calculating_path = true
    task.path = null
    task.path_drawn = false
    task.next_retry_tick = undefined
    log(`[AUTORIO] Requested path id=${task.path_request_id} attempt=${task.path_attempts} to ${serpent.line(task.target_position)}`)
    return true
  }

  function acquire(actor: ControlledActor, task: PlayerParametersWalkToEntity) {
    const target = nearest(actor, actor.surface.find_entities_filtered({
      position: actor.position,
      radius: task.search_radius,
      name: task.entity_name,
    }))
    if (!target) {
      fail(actor, task, 'no_target')
      return false
    }

    task.target = target
    task.target_unit_number = target.unit_number
    task.target_position = copy_position(target.position)
    task.started_tick = game.tick
    task.last_progress_tick = game.tick
    task.last_position = copy_position(actor.position)
    record(actor, task, true, false, 'started')
    return request_path(actor, task)
  }

  function repath(actor: ControlledActor, task: PlayerParametersWalkToEntity, exhausted_code: NavigationCode) {
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    rendering.clear()
    task.path = null
    task.path_drawn = false
    task.calculating_path = false
    task.path_request_id = undefined
    task.path_requested_tick = undefined
    task.next_retry_tick = undefined
    task.last_progress_tick = game.tick
    task.last_position = copy_position(actor.position)
    if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
      fail(actor, task, exhausted_code)
      return false
    }
    return request_path(actor, task)
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const task = manager.player_state.parameters_walk_to_entity
    if (!task || manager.player_state.task_state !== TaskStates.WALKING_TO_ENTITY) {
      return
    }
    if (task.path_request_id === undefined || event.id !== task.path_request_id) {
      log(`[AUTORIO] Ignoring stale path result id=${event.id}; active=${task.path_request_id ?? 'none'}`)
      return
    }

    const actor = get_actor()
    if (!actor || manager.player_state.parameters_walk_to_entity !== task) {
      return
    }
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }

    task.calculating_path = false
    task.path_request_id = undefined
    task.path_requested_tick = undefined

    if (event.try_again_later) {
      if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
        fail(actor, task, 'path_busy')
        return
      }
      task.next_retry_tick = game.tick + PATH_RETRY_DELAY_TICKS
      log('[AUTORIO] Pathfinder busy; bounded retry scheduled')
      return
    }

    if (!event.path || event.path.length === 0) {
      fail(actor, task, 'unreachable')
      return
    }

    task.path = event.path
    task.path_drawn = false
    task.path_index = 1
    task.last_progress_tick = game.tick
    task.last_position = copy_position(actor.position)
    log(`[AUTORIO] Accepted path result with ${event.path.length} waypoints`)
  }

  function follow_path(actor: ControlledActor, task: PlayerParametersWalkToEntity) {
    const path = task.path
    if (!path || path.length === 0) {
      return false
    }

    if (!task.path_drawn) {
      draw_path(actor, path)
      task.path_drawn = true
    }

    const next_position = path[0].position
    if (distance(next_position, actor.position) <= WAYPOINT_REACHED_DISTANCE) {
      path.shift()
      return true
    }

    const previous_position = task.last_position ?? actor.position
    if (distance(previous_position, actor.position) >= PROGRESS_DISTANCE) {
      task.last_position = copy_position(actor.position)
      task.last_progress_tick = game.tick
    }

    if (game.tick - (task.last_progress_tick ?? game.tick) > STUCK_TICKS) {
      repath(actor, task, 'stuck')
      return true
    }

    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, next_position) })
    return true
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_walk_to_entity
    if (!task || manager.player_state.task_state !== TaskStates.WALKING_TO_ENTITY) {
      return
    }
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }

    if (!task.target && !acquire(actor, task)) {
      return
    }

    const target = task.target
    if (!target || !target.valid) {
      fail(actor, task, 'target_gone')
      return
    }

    const started_tick = task.started_tick ?? game.tick
    if (game.tick - started_tick > MAX_NAVIGATION_TICKS) {
      fail(actor, task, 'timeout')
      return
    }

    if (distance(actor.position, target.position) <= TARGET_REACHED_DISTANCE) {
      complete(actor, task)
      return
    }

    if (task.target_position && distance(task.target_position, target.position) >= TARGET_REPATH_DISTANCE) {
      repath(actor, task, 'stuck')
      return
    }

    if (task.calculating_path) {
      const requested_tick = task.path_requested_tick ?? game.tick
      if (game.tick - requested_tick > PATH_REQUEST_TIMEOUT_TICKS) {
        repath(actor, task, 'path_timeout')
      }
      return
    }

    if (task.next_retry_tick !== undefined) {
      if (game.tick >= task.next_retry_tick) {
        request_path(actor, task)
      }
      return
    }

    if (task.path && task.path.length > 0) {
      follow_path(actor, task)
      return
    }

    repath(actor, task, 'stuck')
  }

  function status() {
    const actor = get_actor()
    const task = manager.player_state.parameters_walk_to_entity
    const target = task?.target
    return {
      task_active: manager.player_state.task_state === TaskStates.WALKING_TO_ENTITY,
      actor: actor?.status_snapshot(),
      target: target && target.valid
        ? {
            name: target.name,
            unit_number: target.unit_number,
            position: target.position,
            distance: actor ? distance(actor.position, target.position) : undefined,
          }
        : undefined,
      path: task
        ? {
            calculating: task.calculating_path,
            request_id: task.path_request_id,
            attempts: task.path_attempts ?? 0,
            waypoints_remaining: task.path?.length ?? 0,
          }
        : undefined,
      last_result: storage.airi_last_navigation_result,
    }
  }

  return { submit, tick, on_path_finished, status }
}
