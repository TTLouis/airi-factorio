import type { MapPositionStruct } from 'factorio:prototype'
import type {
  LuaEntity,
  OnPlayerCraftedItemEvent,
  OnPlayerMinedEntityEvent,
  OnScriptPathRequestFinishedEvent,
  OnSelectedEntityChangedEvent,
} from 'factorio:runtime'

import type { ControlledActor } from './actors/types'
import { get_controlled_actor } from './actors/actor_controller'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_combat_controller } from './combat'
import { new_crafting_controller } from './crafting'
import { new_navigation_controller } from './navigation'
import { new_navigation_obstacle_recovery } from './navigation_obstacle_recovery'
import { new_research_controller } from './research'
import { with_research_trigger } from './research_trigger'
import { new_swarm_runtime_service } from './swarm/runtime_service'
import { create_task_board_ui_remote_interface } from './task_board_ui'
import { new_task_manager } from './task_manager'
import { create_tools_remote_interface } from './tools'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { get_actor_inventory_items } from './utils/inventory'

create_tools_remote_interface()
create_task_board_ui_remote_interface()

let setup_complete = false

export const task_manager = new_task_manager(get_controlled_actor)
const basic_operation_controller = new_basic_operation_controller(get_controlled_actor, task_manager)
const basic_operation_runtime = new_basic_operation_runtime(task_manager, basic_operation_controller)
const navigation_controller = new_navigation_controller(get_controlled_actor, task_manager)
const navigation_obstacle_recovery = new_navigation_obstacle_recovery()
const crafting_controller = new_crafting_controller(get_controlled_actor, task_manager)
const research_controller = new_research_controller(get_controlled_actor, task_manager)
const combat_controller = new_combat_controller(get_controlled_actor, task_manager)

let swarm_runtime: ReturnType<typeof new_swarm_runtime_service> | undefined

function get_swarm_runtime() {
  if (swarm_runtime === undefined) swarm_runtime = new_swarm_runtime_service()
  return swarm_runtime
}

remote.add_interface('autorio_navigation', {
  status: () => ({
    ...navigation_controller.status(),
    obstacle_recovery: navigation_obstacle_recovery.status(),
  }),
  set_clear_obstacles: (enabled: boolean) => navigation_obstacle_recovery.set_enabled(enabled),
})

remote.add_interface('autorio_crafting', {
  status: () => crafting_controller.status(),
})

remote.add_interface('autorio_research', {
  status: () => research_controller.status(),
  technology: (name: string) => with_research_trigger(name, research_controller.technology(name) as Record<string, unknown>),
  request_result: (request_id: number) => research_controller.request_result(request_id),
})

remote.add_interface('autorio_combat', {
  status: () => combat_controller.status(),
})

remote.add_interface('autorio_swarm', {
  create_actor: (x?: number, y?: number, surface_index: number = 1, force_name: string = 'player') =>
    get_swarm_runtime().create_actor(x, y, surface_index, force_name),
  status: (actor_id?: string) => get_swarm_runtime().status(actor_id),
  create_survey_work: (x: number, y: number, radius: number = 1.5, priority: number = 50, surface_index: number = 1) =>
    get_swarm_runtime().create_survey_work(x, y, radius, priority, surface_index),
  work_status: (work_id?: string) => get_swarm_runtime().work_status(work_id),
  wait: (actor_id: string, ticks: number) => get_swarm_runtime().wait(actor_id, ticks),
  walk_to_position: (actor_id: string, x: number, y: number) =>
    get_swarm_runtime().walk_to_position(actor_id, x, y),
  cancel: (actor_id: string) => get_swarm_runtime().cancel(actor_id),
  destroy_body: (actor_id: string) => get_swarm_runtime().destroy_body(actor_id),
  replace_body: (actor_id: string, x?: number, y?: number, surface_index: number = 1, force_name: string = 'player') =>
    get_swarm_runtime().replace_body(actor_id, x, y, surface_index, force_name),
})

function log_actor_info() {
  const actor = get_controlled_actor()
  if (!actor) {
    log('[AUTORIO] Cannot log actor info: no controlled actor')
    return false
  }

  const technologies: string[] = []
  for (const [name, tech] of pairs(actor.force.technologies)) {
    if (tech.researched) technologies.push(name)
  }

  const nearby_entities = actor.surface.find_entities_filtered({
    position: actor.position,
    radius: 20,
  }).map(({ name, position }) => ({ name, position }))

  const character = actor.character
  const log_data = {
    actor: actor.status_snapshot(),
    force: actor.force.name,
    inventory: get_actor_inventory_items(actor),
    nearby_entities,
    map_info: {
      surface_name: actor.surface.name,
      daytime: actor.surface.daytime,
      wind_speed: actor.surface.wind_speed,
      wind_orientation: actor.surface.wind_orientation,
    },
    research: {
      current_research: actor.force.current_research?.name ?? 'None',
      research_progress: actor.force.research_progress,
    },
    technologies,
    character_stats: character
      ? {
          health: character.health,
          health_max: character.max_health,
          mining_progress: character.mining_progress,
          mining_state: actor.get_mining_state(),
        }
      : undefined,
  }

  log(`[AUTORIO] Actor ${actor.status_snapshot().name} info: ${serpent.block(log_data)}`)
  return true
}

remote.add_interface('autorio_operations', {
  walk_to_entity: (entity_name: string, search_radius: number) => {
    log(`[AUTORIO] New walk_to_entity task: ${entity_name}, radius: ${search_radius}`)
    return navigation_controller.submit(entity_name, search_radius)
  },
  mine_entity: (entity_name: string, count: number = 1) => {
    const accepted = basic_operation_controller.submit_mining(entity_name, count)
    if (accepted) log(`[AUTORIO] New mine_entity task: ${entity_name} x${count}`)
    return accepted
  },
  place_entity: (entity_name: string) => {
    const accepted = basic_operation_controller.submit_placement(entity_name)
    if (accepted) log(`[AUTORIO] New place_entity task: ${entity_name}`)
    return accepted
  },
  move_items: (item_name: string, entity_name: string, max_count: number, to_entity: boolean): [boolean, string] => {
    const result = basic_operation_controller.submit_move(item_name, entity_name, max_count, to_entity)
    if (result[0]) log(`[AUTORIO] New move_items task for ${item_name} ${to_entity ? 'to' : 'from'} ${entity_name}`)
    return result
  },
  wait: (ticks: number): [boolean, string] => {
    const result = basic_operation_controller.submit_wait(ticks)
    if (result[0]) log(`[AUTORIO] New wait task for ${ticks} ticks`)
    return result
  },
  craft_item: (item_name: string, count: number = 1): [boolean, string] => crafting_controller.submit(item_name, count),
  attack_nearest_enemy: (search_radius: number = 50): [boolean, string] => combat_controller.submit(search_radius),
  research_technology: (name: string): [boolean, string, number] => research_controller.submit(name),
  cancel_all_tasks: () => {
    task_manager.cancel_all_tasks()
    return true
  },
  status: () => {
    const actor = get_controlled_actor()
    return {
      ...task_manager.get_status_snapshot(),
      actor: actor?.status_snapshot(),
      basic_operation: basic_operation_controller.status(),
    }
  },
  log_actor_info: () => log_actor_info(),
  log_player_info: (_player_id?: number) => log_actor_info(),
})

export function get_direction(start_position: MapPositionStruct, end_position: MapPositionStruct) {
  return direction_towards(start_position, end_position)
}

export function get_nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let min_distance = math.huge
  let nearest_entity: LuaEntity | null = null
  if (entities.length === 0) return null
  for (const entity of entities) {
    const distance = (entity.position.x - actor.position.x) ** 2 + (entity.position.y - actor.position.y) ** 2
    if (distance < min_distance) {
      min_distance = distance
      nearest_entity = entity
    }
  }
  return nearest_entity
}

export function state_moving_items(actor: ControlledActor) {
  return basic_operation_runtime.state_moving_items(actor)
}

function state_walking_direct(actor: ControlledActor) {
  const task = task_manager.player_state.parameters_walking_direct
  if (!task) {
    log('[AUTORIO] No parameters found when walking directly')
    return
  }

  const target = task.target_position
  if (!target) {
    log('[AUTORIO] No target position, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  const direction = get_direction(actor.position, target)
  actor.set_walking_state({ walking: true, direction })
  if (((target.x - actor.position.x) ** 2 + (target.y - actor.position.y) ** 2) < 2) {
    log('[AUTORIO] Reached target, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
  }
}

script.on_event(defines.events.on_selected_entity_changed, (unused_event: OnSelectedEntityChangedEvent) => {})

script.on_event(defines.events.on_script_path_request_finished, (event: OnScriptPathRequestFinishedEvent) => {
  const routed = get_swarm_runtime().on_path_finished(event)
  if ('code' in routed && routed.code === 'not_owned') navigation_controller.on_path_finished(event)
})

script.on_event(defines.events.on_player_mined_entity, (event: OnPlayerMinedEntityEvent) => {
  const routed = get_swarm_runtime().on_player_mined_entity(event.player_index)
  if (!('code' in routed) || routed.code !== 'not_owned') return
  const actor = get_controlled_actor()
  if (!actor) return
  basic_operation_runtime.on_player_mined_entity(actor, event.player_index)
})

function setup() {
  setup_complete = true
  log('[AUTORIO] Setup complete')
}

let no_actor_found = false

script.on_event(defines.events.on_tick, (unused_event) => {
  if (!setup_complete) setup()

  get_swarm_runtime().tick_all()

  const actor = get_controlled_actor()
  if (actor === undefined || actor.character === undefined || !actor.is_valid) {
    if (!no_actor_found) {
      log('[AUTORIO] No valid controlled actor found')
      no_actor_found = true
    }
    return
  }
  no_actor_found = false

  if (task_manager.player_state.task_state === TaskStates.IDLE) {
    navigation_obstacle_recovery.suspend(actor)
    return
  }

  if (task_manager.player_state.task_state === TaskStates.WALKING_TO_ENTITY) {
    const handled = navigation_obstacle_recovery.tick(actor, task_manager.player_state.parameters_walk_to_entity)
    if (!handled) navigation_controller.tick(actor)
  }
  else {
    navigation_obstacle_recovery.suspend(actor)
    if (task_manager.player_state.task_state === TaskStates.MINING) {
      basic_operation_runtime.state_mining(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.PLACING) {
      basic_operation_runtime.state_placing(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.MOVING_ITEMS) {
      basic_operation_runtime.state_moving_items(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.CRAFTING) {
      crafting_controller.tick(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.RESEARCHING) {
      research_controller.tick(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.WALKING_DIRECT) {
      state_walking_direct(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.ATTACKING) {
      combat_controller.tick(actor)
    }
    else if (task_manager.player_state.task_state === TaskStates.WAITING) {
      basic_operation_runtime.state_waiting(actor)
    }
  }
})

script.on_event(defines.events.on_player_crafted_item, (event: OnPlayerCraftedItemEvent) => {
  const actor = get_controlled_actor()
  if (!actor || !actor.owns_player_index(event.player_index)) return
  log(`[AUTORIO] Actor ${actor.status_snapshot().name} crafted item: ${event.item_stack.name}`)
})

log('[AUTORIO] Mod loaded 1')
