import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type {
  PlayerParameters,
  PlayerParametersWalkToEntity,
  PlayerParametersWalkingDirect,
} from './types'
import { TaskStates } from './types'

const LEGACY_ENTITY_SEARCH_DISTANCE = 8
const INTERACTION_REACH_MARGIN = 0.25
const FALLBACK_ENTITY_REACH = 8
const FALLBACK_BUILD_REACH = 10
const MIN_RECOVERY_REACH = 0.75

type Manager = ReturnType<typeof new_task_manager>

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function bounded_reach(raw: unknown, fallback: number) {
  const value = typeof raw === 'number' && raw === raw && raw > 0 && raw < math.huge ? raw : fallback
  return math.max(MIN_RECOVERY_REACH, value - INTERACTION_REACH_MARGIN)
}

function entity_reach(actor: ControlledActor) {
  return bounded_reach((actor.character as any)?.reach_distance, FALLBACK_ENTITY_REACH)
}

function build_reach(actor: ControlledActor) {
  return bounded_reach((actor.character as any)?.build_distance, FALLBACK_BUILD_REACH)
}

function nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let result: LuaEntity | undefined
  let best = math.huge
  for (const entity of entities) {
    const candidate = squared_distance(actor.position, entity.position)
    if (candidate < best) {
      best = candidate
      result = entity
    }
  }
  return result
}

function entity_navigation(actor: ControlledActor, entity: LuaEntity, reach_distance: number, target_player_name?: string): PlayerParametersWalkToEntity | undefined {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return undefined
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: entity.name,
    search_radius: 1,
    target_player_name,
    reach_distance,
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: entity.position.x, y: entity.position.y },
    target: entity,
    target_unit_number: entity.unit_number,
    owner_actor_id: identity.actor_id,
    owner_actor_kind: identity.kind,
    owner_force_index: actor.force.index,
    path_attempts: 0,
    started_tick: game.tick,
    last_progress_tick: game.tick,
  }
}

function position_navigation(position: { x: number, y: number }): PlayerParametersWalkingDirect {
  return {
    type: TaskStates.WALKING_DIRECT,
    target_position: { x: position.x, y: position.y },
  }
}

function interrupt(manager: Manager, recovery: PlayerParameters | undefined, resume: PlayerParameters, reason: string) {
  if (!recovery) return false
  if (!manager.interrupt_current_with(recovery, resume)) return false
  log(`[AUTORIO] Interaction target is outside real reach; ${reason} recovery started before resuming ${resume.type}`)
  return true
}

export function new_interaction_recovery(manager: Manager) {
  function tick(actor: ControlledActor) {
    if (!actor.is_valid || !actor.character) return false

    if (manager.player_state.task_state === TaskStates.PLACING) {
      const task = manager.player_state.parameters_place_entity
      if (!task?.position) return false
      const reach = build_reach(actor)
      if (squared_distance(actor.position, task.position) <= reach ** 2) return false
      return interrupt(manager, position_navigation(task.position), task, `placement approach to <=${reach} tiles`)
    }

    if (manager.player_state.task_state === TaskStates.SETTING_RECIPE) {
      const task = manager.player_state.parameters_set_recipe
      if (!task) return false
      const target = game.get_entity_by_unit_number(task.target_unit_number as any)
      if (!target || !target.valid || target.surface.index !== actor.surface.index || target.force.index !== actor.force.index) return false
      const reach = entity_reach(actor)
      if (squared_distance(actor.position, target.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, target, reach), task, `recipe-machine approach to <=${reach} tiles`)
    }

    if (manager.player_state.task_state !== TaskStates.MOVING_ITEMS) return false
    const task = manager.player_state.parameters_move_items
    if (!task) return false
    const reach = entity_reach(actor)

    if (task.player_name) {
      const player = game.get_player(task.player_name)
      if (!player || !player.valid || !player.connected || !player.character || player.surface.index !== actor.surface.index) return false
      if (squared_distance(actor.position, player.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, player.character, reach, task.player_name), task, `player-transfer approach to <=${reach} tiles`)
    }

    if (task.target_unit_number !== undefined) {
      const target = game.get_entity_by_unit_number(task.target_unit_number as any)
      if (!target || !target.valid || target.surface.index !== actor.surface.index || target.force.index !== actor.force.index) return false
      if (squared_distance(actor.position, target.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, target, reach), task, `exact entity-transfer approach to <=${reach} tiles`)
    }

    if (!task.entity_name || !prototypes.entity[task.entity_name]) return false
    const nearby = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: LEGACY_ENTITY_SEARCH_DISTANCE,
      name: task.entity_name,
      force: actor.force,
    })
    const target = nearest_entity(actor, nearby)
    if (!target || squared_distance(actor.position, target.position) <= reach ** 2) return false
    return interrupt(manager, entity_navigation(actor, target, reach), task, `nearby entity-transfer approach to <=${reach} tiles`)
  }

  return { tick }
}
