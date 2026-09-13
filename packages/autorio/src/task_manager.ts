import type { ControlledActor } from './actors/types'
import type { PlayerParameters, PlayerState } from './types'
import { TaskStates } from './types'

export function new_task_manager(get_controlled_actor: () => ControlledActor | undefined) {
  const player_state: PlayerState = {
    task_state: TaskStates.IDLE,
  }

  const task_queue: PlayerParameters[] = []

  function add_task(task: PlayerParameters) {
    task_queue.push(task)
    log(`[AUTORIO] Task added: ${task.type}, task queue length: ${task_queue.length}`)

    if (task_queue.length === 1) {
      next_task()
    }
  }

  function reset_task_state() {
    player_state.task_state = TaskStates.IDLE
    player_state.parameters_walk_to_entity = undefined
    player_state.parameters_walking_direct = undefined
    player_state.parameters_mine_entity = undefined
    player_state.parameters_place_entity = undefined
    player_state.parameters_move_items = undefined
    player_state.parameters_craft_item = undefined
    player_state.parameters_attack_nearest_enemy = undefined
    player_state.parameters_research_technology = undefined
    player_state.parameters_waiting = undefined
  }

  function next_task() {
    if (player_state.task_state !== TaskStates.IDLE) {
      log('[AUTORIO] Task state is not IDLE, wont execute next task')
      return
    }

    const task = task_queue.shift()
    if (!task) {
      player_state.task_state = TaskStates.IDLE
      game.print('[AUTORIO] All operations completed')
      log('[AUTORIO] All operations completed')
      return
    }

    log(`[AUTORIO] Next task: ${task.type}, task queue length: ${task_queue.length}`)
    player_state.task_state = task.type
    switch (task.type) {
      case TaskStates.WALKING_TO_ENTITY:
        player_state.parameters_walk_to_entity = task
        break
      case TaskStates.WALKING_DIRECT:
        player_state.parameters_walking_direct = task
        break
      case TaskStates.MINING:
        player_state.parameters_mine_entity = task
        break
      case TaskStates.PLACING:
        player_state.parameters_place_entity = task
        break
      case TaskStates.MOVING_ITEMS:
        player_state.parameters_move_items = task
        break
      case TaskStates.CRAFTING:{
        const actor = get_controlled_actor()
        if (!actor) {
          log('[AUTORIO] No player found')
          return
        }

        actor.begin_crafting({
          count: task.count,
          recipe: task.item_name,
        })

        player_state.parameters_craft_item = task
        break
      }
      case TaskStates.ATTACKING:
        player_state.parameters_attack_nearest_enemy = task
        break
      case TaskStates.RESEARCHING:
        player_state.parameters_research_technology = task
        break
      case TaskStates.WAITING:
        player_state.parameters_waiting = task
        break
    }
  }

  function is_task_queue_empty() {
    return task_queue.length === 0
  }

  function get_current_task_snapshot() {
    switch (player_state.task_state) {
      case TaskStates.IDLE:
        return undefined
      case TaskStates.WALKING_TO_ENTITY: {
        const task = player_state.parameters_walk_to_entity
        return task
          ? {
              type: task.type,
              entity_name: task.entity_name,
              search_radius: task.search_radius,
              path_index: task.path_index,
              calculating_path: task.calculating_path,
              target_position: task.target_position,
            }
          : { type: player_state.task_state }
      }
      case TaskStates.WALKING_DIRECT: {
        const task = player_state.parameters_walking_direct
        return task ? { type: task.type, target_position: task.target_position } : { type: player_state.task_state }
      }
      case TaskStates.MINING: {
        const task = player_state.parameters_mine_entity
        return task ? { type: task.type, entity_name: task.entity_name, count: task.count, position: task.position } : { type: player_state.task_state }
      }
      case TaskStates.PLACING: {
        const task = player_state.parameters_place_entity
        return task ? { type: task.type, entity_name: task.entity_name, position: task.position } : { type: player_state.task_state }
      }
      case TaskStates.MOVING_ITEMS: {
        const task = player_state.parameters_move_items
        return task
          ? {
              type: task.type,
              item_name: task.item_name,
              entity_name: task.entity_name,
              max_count: task.max_count,
              to_entity: task.to_entity,
            }
          : { type: player_state.task_state }
      }
      case TaskStates.CRAFTING: {
        const task = player_state.parameters_craft_item
        return task ? { type: task.type, item_name: task.item_name, count: task.count, crafted: task.crafted } : { type: player_state.task_state }
      }
      case TaskStates.ATTACKING: {
        const task = player_state.parameters_attack_nearest_enemy
        const target = task?.target
        return task
          ? {
              type: task.type,
              search_radius: task.search_radius,
              target: target && target.valid
                ? { name: target.name, position: target.position }
                : undefined,
            }
          : { type: player_state.task_state }
      }
      case TaskStates.RESEARCHING: {
        const task = player_state.parameters_research_technology
        return task ? { type: task.type, technology_name: task.technology_name } : { type: player_state.task_state }
      }
      case TaskStates.WAITING: {
        const task = player_state.parameters_waiting
        return task ? { type: task.type, remaining_ticks: task.remaining_ticks } : { type: player_state.task_state }
      }
      default:
        return { type: player_state.task_state }
    }
  }

  function get_status_snapshot() {
    return {
      task_state: player_state.task_state,
      queue_empty: task_queue.length === 0,
      queue_length: task_queue.length,
      queued_task_types: task_queue.map(task => task.type),
      current_task: get_current_task_snapshot(),
    }
  }

  function cancel_task() {
    reset_task_state()
  }

  function cancel_all_tasks() {
    reset_task_state()
    task_queue.length = 0 // can use this to clear the array in lua
  }

  return {
    player_state,
    add_task,
    next_task,
    is_task_queue_empty,
    get_status_snapshot,
    reset_task_state,
    cancel_task,
    cancel_all_tasks,
  }
}
