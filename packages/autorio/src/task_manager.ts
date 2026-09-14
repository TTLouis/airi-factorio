import type { ControlledActor } from './actors/types'
import type { ActorMode } from './actors/actor_controller'
import { register_actor_mode_transition_handler, register_npc_recovery_handler } from './actors/actor_controller'
import type { PlayerParameters, PlayerState } from './types'
import { TaskStates } from './types'

export interface TaskManagerOptions {
  /** Legacy singleton compatibility. Multi-actor contexts must set this false
   * and route lifecycle events explicitly to the owning context. */
  bindGlobalActorLifecycle?: boolean
}

export function new_task_manager(get_controlled_actor: () => ControlledActor | undefined, options: TaskManagerOptions = {}) {
  const player_state: PlayerState = {
    task_state: TaskStates.IDLE,
  }

  const task_queue: PlayerParameters[] = []
  const cancel_handlers: Partial<Record<TaskStates, () => void>> = {}

  function add_task(task: PlayerParameters) {
    task_queue.push(task)
    log(`[AUTORIO] Task added: ${task.type}, task queue length: ${task_queue.length}`)

    if (task_queue.length === 1) {
      next_task()
    }
  }

  function register_cancel_handler(state: TaskStates, handler: () => void) {
    cancel_handlers[state] = handler
  }

  function run_cancel_cleanup() {
    const handler = cancel_handlers[player_state.task_state]
    if (handler) {
      handler()
    }
  }

  function stop_task_controls() {
    // Clearing our task record does not clear a standalone character's engine
    // inputs. Stop the outgoing task's controls before a queued task can start.
    // Do not stop unrelated controls (e.g. a human walking while hand-crafting),
    // and do not resolve/spawn an actor for an already-idle reset.
    const state = player_state.task_state
    const stop_walking = state === TaskStates.WALKING_TO_ENTITY
      || state === TaskStates.WALKING_DIRECT
      || state === TaskStates.ATTACKING
    const stop_mining = state === TaskStates.MINING
    const stop_shooting = state === TaskStates.ATTACKING
    if (!stop_walking && !stop_mining && !stop_shooting) {
      return
    }

    const actor = get_controlled_actor()
    if (!actor || !actor.is_valid || !actor.character) {
      return
    }

    if (stop_walking) {
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
    }
    if (stop_mining) {
      actor.set_mining_state({ mining: false })
    }
    if (stop_shooting) {
      actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
    }
  }

  function clear_task_state_without_controls() {
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

  function reset_task_state() {
    stop_task_controls()
    clear_task_state_without_controls()
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
      case TaskStates.CRAFTING:
        // Native queue admission/start belongs to the crafting controller so it
        // can bind actor identity, reject an already-busy native queue, verify
        // output, and clean up only task-owned native work on cancellation.
        player_state.parameters_craft_item = task
        break
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
        return task
          ? {
              type: task.type,
              entity_name: task.entity_name,
              count: task.count,
              position: task.position,
              last_target_amount: task.last_target_amount,
            }
          : { type: player_state.task_state }
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
        if (!task) {
          return { type: player_state.task_state }
        }
        const actor = get_controlled_actor()
        return {
          type: task.type,
          item_name: task.item_name,
          count: task.count,
          crafted: task.crafted,
          started: task.started,
          owns_native_queue: task.owns_native_queue ?? false,
          queued_crafts: actor?.get_crafting_queue_count(task.item_name),
        }
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
    run_cancel_cleanup()
    reset_task_state()
  }

  function cancel_all_tasks() {
    run_cancel_cleanup()
    reset_task_state()
    task_queue.length = 0 // can use this to clear the array in lua
  }

  function discard_all_tasks_after_actor_loss() {
    // The previous actor is already invalid. Do not call task cleanup or
    // stop_task_controls(), because resolving an actor here would enter
    // replacement creation again. Native state on the dead body is gone with it.
    clear_task_state_without_controls()
    task_queue.length = 0
  }

  function handle_actor_loss(previous_actor_id: number) {
    discard_all_tasks_after_actor_loss()
    log(`[AUTORIO] Discarded active and queued work after loss of actor_id=${previous_actor_id}`)
  }

  function handle_actor_mode_transition(previous_mode: ActorMode, next_mode: ActorMode) {
    if (player_state.task_state === TaskStates.IDLE && task_queue.length === 0) {
      return
    }
    // The actor controller invokes this before changing storage.airi_actor_mode,
    // so cancellation resolves the previous actor and stops/cancels only work
    // that belonged to that actor (including an owned native crafting queue).
    cancel_all_tasks()
    log(`[AUTORIO] Cancelled active and queued work before actor mode change ${previous_mode} -> ${next_mode}`)
  }

  if (options.bindGlobalActorLifecycle !== false) {
    register_npc_recovery_handler(({ previous_actor_id }) => handle_actor_loss(previous_actor_id))
    register_actor_mode_transition_handler(({ previous_mode, next_mode }) => handle_actor_mode_transition(previous_mode, next_mode))
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
    discard_all_tasks_after_actor_loss,
    handle_actor_loss,
    handle_actor_mode_transition,
    register_cancel_handler,
  }
}
