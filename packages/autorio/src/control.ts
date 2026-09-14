import type { MapPositionStruct } from 'factorio:prototype'
import type {
  LuaEntity,
  LuaInventory,
  OnPlayerCraftedItemEvent,
  OnPlayerMinedEntityEvent,
  OnScriptPathRequestFinishedEvent,
  OnSelectedEntityChangedEvent,
  SurfaceCreateEntity,
} from 'factorio:runtime'

import type { ControlledActor } from './actors/types'
import { get_controlled_actor } from './actors/actor_controller'
import { new_combat_controller } from './combat'
import { new_crafting_controller } from './crafting'
import { new_navigation_controller } from './navigation'
import { new_research_controller } from './research'
import { new_task_manager } from './task_manager'
import { create_tools_remote_interface } from './tools'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { get_actor_inventory_items } from './utils/inventory'

create_tools_remote_interface()

let setup_complete = false

export const task_manager = new_task_manager(get_controlled_actor)
const navigation_controller = new_navigation_controller(get_controlled_actor, task_manager)
const crafting_controller = new_crafting_controller(get_controlled_actor, task_manager)
const research_controller = new_research_controller(get_controlled_actor, task_manager)
const combat_controller = new_combat_controller(get_controlled_actor, task_manager)

remote.add_interface('autorio_navigation', {
  status: () => navigation_controller.status(),
})

remote.add_interface('autorio_crafting', {
  status: () => crafting_controller.status(),
})

remote.add_interface('autorio_research', {
  status: () => research_controller.status(),
  technology: (name: string) => research_controller.technology(name),
})

remote.add_interface('autorio_combat', {
  status: () => combat_controller.status(),
})

function log_actor_info() {
  const actor = get_controlled_actor()
  if (!actor) {
    log('[AUTORIO] Cannot log actor info: no controlled actor')
    return false
  }

  const technologies: string[] = []
  for (const [name, tech] of pairs(actor.force.technologies)) {
    if (tech.researched) {
      technologies.push(name)
    }
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
    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name,
      count,
    })

    log(`[AUTORIO] New mine_entity task: ${entity_name} x${count}`)
    return true
  },
  place_entity: (entity_name: string) => {
    task_manager.add_task({
      type: TaskStates.PLACING,
      entity_name,
      position: undefined,
    })

    log(`[AUTORIO] New place_entity task: ${entity_name}`)
    return true
  },
  move_items: (item_name: string, entity_name: string, max_count: number, to_entity: boolean): [boolean, string] => {
    task_manager.add_task({
      type: TaskStates.MOVING_ITEMS,
      item_name,
      entity_name,
      max_count: max_count || math.huge,
      to_entity,
    })

    if (to_entity) {
      log(`[AUTORIO] New move_items task for ${item_name} from actor inventory to ${entity_name}`)
    }
    else {
      log(`[AUTORIO] New move_items task for ${item_name} from ${entity_name} to actor inventory`)
    }

    return [true, 'Task started']
  },
  wait: (ticks: number): [boolean, string] => {
    task_manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: ticks,
    })

    log(`[AUTORIO] New wait task for ${ticks} ticks`)

    return [true, 'Task started']
  },
  craft_item: (item_name: string, count: number = 1): [boolean, string] => crafting_controller.submit(item_name, count),
  attack_nearest_enemy: (search_radius: number = 50): [boolean, string] => combat_controller.submit(search_radius),
  research_technology: (name: string): [boolean, string] => research_controller.submit(name),
  cancel_all_tasks: () => {
    task_manager.cancel_all_tasks()
    return true
  },
  status: () => {
    const actor = get_controlled_actor()
    return {
      ...task_manager.get_status_snapshot(),
      actor: actor?.status_snapshot(),
    }
  },
  log_actor_info: () => log_actor_info(),
  // Compatibility alias for older callers. The player id is intentionally ignored:
  // diagnostics now always describe AIRI's selected ControlledActor.
  log_player_info: (_player_id?: number) => log_actor_info(),
})

export function get_direction(start_position: MapPositionStruct, end_position: MapPositionStruct) {
  return direction_towards(start_position, end_position)
}

export function get_nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let min_distance = math.huge
  let nearest_entity: LuaEntity | null = null

  if (entities.length === 0) {
    return null
  }

  for (const entity of entities) {
    const distance = (entity.position.x - actor.position.x) ** 2 + (entity.position.y - actor.position.y) ** 2
    if (distance < min_distance) {
      min_distance = distance
      nearest_entity = entity
    }
  }

  return nearest_entity
}

function is_standalone_actor(actor: ControlledActor) {
  return actor.status_snapshot().kind === 'standalone_character'
}

function start_mining(actor: ControlledActor, entity: LuaEntity) {
  const parameters = task_manager.player_state.parameters_mine_entity
  if (!parameters) {
    return
  }

  parameters.position = { x: entity.position.x, y: entity.position.y }
  parameters.last_target_amount = entity.type === 'resource' ? entity.amount : undefined
  actor.update_selected_entity(entity.position)
  actor.set_mining_state({ mining: true, position: entity.position })
  log(`[AUTORIO] Started mining ${entity.name} at position: ${serpent.line(entity.position)}`)
}

function find_current_mining_target(actor: ControlledActor) {
  const parameters = task_manager.player_state.parameters_mine_entity
  if (!parameters?.position) {
    return undefined
  }

  return actor.surface.find_entities_filtered({
    position: parameters.position,
    radius: 0.25,
    name: parameters.entity_name,
  })[0]
}

function finish_mining_task(actor: ControlledActor) {
  actor.set_mining_state({ mining: false })
  log('[AUTORIO] Mining task complete')
  task_manager.reset_task_state()
  task_manager.next_task()
}

function poll_standalone_mining_progress(actor: ControlledActor) {
  const parameters = task_manager.player_state.parameters_mine_entity
  if (!parameters || !parameters.position || !is_standalone_actor(actor)) {
    return false
  }

  const target = find_current_mining_target(actor)
  if (!target) {
    // Non-resource entities disappear when the mining cycle completes. A
    // depleted resource with amount 1 also disappears, so this accounts for
    // that final cycle as well.
    parameters.count -= 1
    parameters.position = undefined
    parameters.last_target_amount = undefined
    actor.set_mining_state({ mining: false })
    log(`[AUTORIO] Standalone actor completed mining cycle, remaining: ${parameters.count}`)
  }
  else if (target.type === 'resource') {
    const amount = target.amount
    if (parameters.last_target_amount === undefined) {
      parameters.last_target_amount = amount
    }
    else if (amount < parameters.last_target_amount) {
      const mined = math.min(parameters.count, parameters.last_target_amount - amount)
      parameters.count -= mined
      parameters.last_target_amount = amount
      log(`[AUTORIO] Standalone actor mined ${mined} ${parameters.entity_name}, remaining: ${parameters.count}`)
    }
  }

  if (parameters.count <= 0) {
    finish_mining_task(actor)
    return true
  }

  return false
}

// FIXME: who are changing the selected entity while mining?
// This only happens in multiplayer, why?
script.on_event(defines.events.on_selected_entity_changed, (unused_event: OnSelectedEntityChangedEvent) => {})

script.on_event(defines.events.on_script_path_request_finished, (event: OnScriptPathRequestFinishedEvent) => {
  navigation_controller.on_path_finished(event)
})

script.on_event(defines.events.on_player_mined_entity, (event: OnPlayerMinedEntityEvent) => {
  const actor = get_controlled_actor()
  if (!actor || !actor.owns_player_index(event.player_index)) {
    // NPCs have no LuaPlayer mining event. Player events must never advance an
    // NPC task, and other players must not advance the controlled player task.
    return
  }

  if (task_manager.player_state.task_state !== TaskStates.MINING) {
    return
  }

  const parameters = task_manager.player_state.parameters_mine_entity
  if (!parameters) {
    log('[AUTORIO] No parameters found when on_player_mined_entity event')
    return
  }

  parameters.count -= 1
  parameters.position = undefined
  parameters.last_target_amount = undefined
  log(`[AUTORIO] Controlled player completed mining cycle, remaining: ${parameters.count}`)

  if (parameters.count <= 0) {
    finish_mining_task(actor)
  }
})

function setup() {
  // Production setup must never delete world enemies. Deterministic tests own
  // their fixtures explicitly; combat must interact with real enemy entities.
  setup_complete = true
  log('[AUTORIO] Setup complete')
}

function state_mining(actor: ControlledActor) {
  const parameters = task_manager.player_state.parameters_mine_entity
  if (!parameters) {
    log('[AUTORIO] No parameters found when mining')
    return
  }

  if (poll_standalone_mining_progress(actor)) {
    return
  }

  if (actor.get_mining_state().mining) {
    return
  }

  if (parameters.position) {
    const existing_target = find_current_mining_target(actor)
    if (existing_target) {
      start_mining(actor, existing_target)
      return
    }
    parameters.position = undefined
    parameters.last_target_amount = undefined
  }

  const entities = actor.surface.find_entities_filtered({
    position: actor.position,
    radius: 5, // but the character can only mine entities within its normal reach
    name: parameters.entity_name,
  })

  if (entities.length === 0) {
    log('[AUTORIO] No entity found to mine, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  const nearest_entity = get_nearest_entity(actor, entities)
  if (!nearest_entity) {
    log('[AUTORIO] No entity found to mine, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  start_mining(actor, nearest_entity)
}

function state_placing(actor: ControlledActor) {
  if (!actor) {
    log('[AUTORIO] Invalid actor, ending PLACING task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid actor']
  }

  if (!task_manager.player_state.parameters_place_entity) {
    log('[AUTORIO] No parameters found when placing')
    return
  }

  const surface = actor.surface
  const inventory = actor.get_main_inventory()

  if (!inventory) {
    log('[AUTORIO] Cannot access actor inventory, ending PLACING task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Cannot access actor inventory']
  }

  const entity_prototype = prototypes.entity[task_manager.player_state.parameters_place_entity.entity_name]
  if (!entity_prototype || !entity_prototype.items_to_place_this) {
    log('[AUTORIO] Invalid entity name, ending PLACING task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid entity name']
  }

  const item_name = entity_prototype.items_to_place_this[0]
  if (!item_name) {
    log('[AUTORIO] Invalid entity name, ending PLACING task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid entity name']
  }

  const [item_stack, unused_count] = inventory.find_item_stack(task_manager.player_state.parameters_place_entity.entity_name)
  if (!item_stack) {
    log('[AUTORIO] Entity not found in inventory, ending PLACING task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Entity not found in inventory']
  }

  if (!task_manager.player_state.parameters_place_entity.position) {
    task_manager.player_state.parameters_place_entity.position = surface.find_non_colliding_position(task_manager.player_state.parameters_place_entity.entity_name, actor.position, 1, 1)
    if (!task_manager.player_state.parameters_place_entity.position) {
      log('[AUTORIO] Could not find a valid position to place the entity, ending PLACING task')
      task_manager.reset_task_state()
      task_manager.next_task()
      return [false, 'Could not find a valid position to place the entity']
    }
  }

  task_manager.player_state.task_state = TaskStates.IDLE
  const create_entity_args: SurfaceCreateEntity = {
    name: task_manager.player_state.parameters_place_entity.entity_name,
    position: task_manager.player_state.parameters_place_entity.position,
    raise_built: true,
    ...actor.entity_build_args(),
  }
  const entity = surface.create_entity(create_entity_args)

  if (entity) {
    item_stack.count = item_stack.count - 1
    log(`[AUTORIO] Entity placed successfully: ${task_manager.player_state.parameters_place_entity.entity_name}`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return [true, 'Entity placed successfully', entity]
  }
  log(`[AUTORIO] Failed to place entity: ${task_manager.player_state.parameters_place_entity.entity_name}`)
  return [false, 'Failed to place entity']
}

// TODO: Move items between specified entity and actor inventory, give the entity name and position as parameters
export function state_moving_items(actor: ControlledActor) {
  const parameters = task_manager.player_state.parameters_move_items

  if (!parameters) {
    log('[AUTORIO] No parameters found when moving items')
    return
  }

  const nearby_entities = actor.surface.find_entities_filtered({
    position: actor.position,
    radius: 8,
    name: parameters.entity_name,
    force: actor.force,
  })

  const actor_inventory = actor.get_main_inventory()
  if (!actor_inventory) {
    log('[AUTORIO] Cannot access actor inventory, ending MOVING_ITEMS task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  let moved_total = 0

  if (parameters.to_entity) {
    const [item_stack, unused_count] = actor_inventory.find_item_stack(parameters.item_name)
    if (!item_stack) {
      log('[AUTORIO] Item not found in actor inventory, ending MOVING_ITEMS task')
      task_manager.reset_task_state()
      task_manager.next_task()
      return
    }

    nearby_entities
      .filter(it => it.can_insert({ name: parameters.item_name }))
      .map((entity) => {
        const max_index = entity.get_max_inventory_index()
        const inventories: LuaInventory[] = []
        for (let i = 1; i <= max_index; i++) {
          const inventory = entity.get_inventory(i)
          if (inventory && inventory.can_insert({ name: parameters.item_name })) {
            inventories.push(inventory)
          }
        }

        return inventories
      })
      .flat()
      .forEach((inventory) => {
        if (moved_total >= parameters.max_count) {
          return
        }

        const to_move = math.min(item_stack.count, parameters.max_count - moved_total)
        if (to_move <= 0) {
          return
        }

        log(`[AUTORIO] Moving ${to_move} ${parameters.item_name} to ${inventory.entity_owner?.name} inventory index ${inventory.index}`)
        const moved = inventory.insert({ name: parameters.item_name, count: to_move })
        if (moved > 0) {
          actor_inventory.remove({ name: parameters.item_name, count: moved })
          moved_total += moved

          log(`[AUTORIO] Moved ${moved} ${parameters.item_name} to ${inventory.entity_owner?.name} inventory index ${inventory.index}`)
        }
      })
  }
  else {
    nearby_entities
      .map((entity) => {
        const max_index = entity.get_max_inventory_index()
        const inventories: LuaInventory[] = []
        for (let i = 1; i <= max_index; i++) {
          const inventory = entity.get_inventory(i)
          if (!inventory) {
            continue
          }
          inventories.push(inventory)
        }

        return inventories
      })
      .flat()
      .forEach((inventory) => {
        if (moved_total >= parameters.max_count) {
          return
        }

        if (!actor_inventory.can_insert({ name: parameters.item_name })) {
          log(`[AUTORIO] Cannot insert ${parameters.item_name} into actor inventory, skipping`)
          return
        }

        const removed = inventory.remove({ name: parameters.item_name, count: parameters.max_count - moved_total })
        if (removed <= 0) {
          return
        }

        const inserted = actor_inventory.insert({ name: parameters.item_name, count: removed })
        if (inserted < removed) {
          // move back the remaining items
          inventory.insert({ name: parameters.item_name, count: removed - inserted })
          moved_total += inserted
        }
        else {
          moved_total += removed
        }

        log(`[AUTORIO] Moved ${removed} ${parameters.item_name} from ${inventory.entity_owner?.name} inventory index ${inventory.index}`)
      })
  }

  if (moved_total === 0) {
    log('[AUTORIO] No items moved, ending task')
  }
  else {
    log(`[AUTORIO] Moved a total of ${moved_total} ${parameters.item_name}`)
  }

  task_manager.reset_task_state()
  task_manager.next_task()

  return moved_total
}

function state_walking_direct(actor: ControlledActor) {
  if (!task_manager.player_state.parameters_walking_direct) {
    log('[AUTORIO] No parameters found when walking directly')
    return
  }

  const target = task_manager.player_state.parameters_walking_direct.target_position

  if (target) {
    const direction = get_direction(actor.position, target)
    actor.set_walking_state({
      walking: true,
      direction,
    })

    if (((target.x - actor.position.x) ** 2 + (target.y - actor.position.y) ** 2) < 2) {
      log('[AUTORIO] Reached target, switching to IDLE state')
      task_manager.reset_task_state()
      task_manager.next_task()
    }
  }
  else {
    log('[AUTORIO] No target position, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
  }
}

function state_waiting() {
  if (!task_manager.player_state.parameters_waiting) {
    log('[AUTORIO] No parameters found when waiting')
    return
  }

  if (task_manager.player_state.parameters_waiting.remaining_ticks <= 0) {
    log('[AUTORIO] Waiting task complete')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  task_manager.player_state.parameters_waiting.remaining_ticks -= 1
}

let no_actor_found = false

script.on_event(defines.events.on_tick, (unused_event) => {
  if (!setup_complete) {
    setup()
  }

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
    return
  }

  if (task_manager.player_state.task_state === TaskStates.WALKING_TO_ENTITY) {
    navigation_controller.tick(actor)
  }
  else if (task_manager.player_state.task_state === TaskStates.MINING) {
    state_mining(actor)
  }
  else if (task_manager.player_state.task_state === TaskStates.PLACING) {
    state_placing(actor)
  }
  else if (task_manager.player_state.task_state === TaskStates.MOVING_ITEMS) {
    state_moving_items(actor)
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
    state_waiting()
  }
})

script.on_event(defines.events.on_player_crafted_item, (event: OnPlayerCraftedItemEvent) => {
  const actor = get_controlled_actor()
  if (!actor || !actor.owns_player_index(event.player_index)) {
    // Not our controlled actor's craft (e.g. another connected player) — ignore it.
    // Standalone NPC crafting produces no LuaPlayer event at all.
    return
  }

  // This event is diagnostic only. Queue ownership and completion are verified
  // by the crafting controller against the controlled actor's native queue and
  // real inventory output; a player-sourced event cannot complete an NPC task.
  log(`[AUTORIO] Actor ${actor.status_snapshot().name} crafted item: ${event.item_stack.name}`)
})

log('[AUTORIO] Mod loaded 1')