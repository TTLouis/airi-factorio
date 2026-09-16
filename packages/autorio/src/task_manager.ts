import type { ControlledActor } from './actors/types'
import { register_actor_mode_transition_handler, register_npc_recovery_handler } from './actors/actor_controller'
import type { PlayerParameters, PlayerState } from './types'
import { TaskStates } from './types'

interface TaskBatchReceipt {
  batch_id: number
  task_count: number
  task_types: TaskStates[]
  tick: number
  reason?: string
}

export function new_task_manager(get_controlled_actor: () => ControlledActor | undefined) {
  const player_state: PlayerState = {
    task_state: TaskStates.IDLE,
  }

  const task_queue: PlayerParameters[] = []
  const cancel_handlers: Partial<Record<TaskStates, () => void>> = {}
  let batch_sequence = 0
  let active_batch_id: number | undefined
  let active_batch_task_types: TaskStates[] = []
  let last_completed_batch: TaskBatchReceipt | undefined
  let last_cancelled_batch: TaskBatchReceipt | undefined

  function begin_or_extend_batch(task: PlayerParameters) {
    const created = active_batch_id === undefined
    if (created) {
      batch_sequence += 1
      active_batch_id = batch_sequence
      active_batch_task_types = []
    }
    active_batch_task_types.push(task.type)
    return created
  }

  function close_batch(kind: 'completed' | 'cancelled', reason?: string) {
    if (active_batch_id === undefined) return undefined
    const receipt: TaskBatchReceipt = {
      batch_id: active_batch_id,
      task_count: active_batch_task_types.length,
      task_types: [...active_batch_task_types],
      tick: game.tick,
      reason,
    }
    if (kind === 'completed') last_completed_batch = receipt
    else last_cancelled_batch = receipt
    active_batch_id = undefined
    active_batch_task_types = []
    return receipt
  }

  function receipt_details(receipt: TaskBatchReceipt) {
    const reason = receipt.reason ? `, reason=${receipt.reason}` : ''
    return `batch=${receipt.batch_id}, task_count=${receipt.task_count}, tasks=${receipt.task_types.join(',') || 'none'}, tick=${receipt.tick}${reason}`
  }

  function add_task(task: PlayerParameters) {
    const new_batch = begin_or_extend_batch(task)
    task_queue.push(task)
    log(`[AUTORIO] Task added: ${task.type}, batch=${active_batch_id}, task queue length: ${task_queue.length}`)
    if (new_batch) {
      const details = `batch=${active_batch_id}, first_task=${task.type}, tick=${game.tick}`
      game.print(`[AUTORIO] Operation batch started: ${details}`)
      log(`[AUTORIO] Operation batch started: ${details}`)
    }

    if (task_queue.length === 1) {
      next_task()
    }
  }

  function register_cancel_handler(state: TaskStates, handler: () => void) {
    cancel_handlers[state] = handler
  }

  function run_cancel_cleanup() {
    const handler = cancel_handlers[player_state.task_state]
    if (handler) handler()
  }

  function stop_task_controls() {
    const state = player_state.task_state
    const stop_walking = state === TaskStates.WALKING_TO_ENTITY
      || state === TaskStates.WALKING_DIRECT
      || state === TaskStates.ATTACKING
    const stop_mining = state === TaskStates.MINING
    const stop_shooting = state === TaskStates.ATTACKING
    if (!stop_walking && !stop_mining && !stop_shooting) return

    const actor = get_controlled_actor()
    if (!actor || !actor.is_valid || !actor.character) return

    if (stop_walking) actor.set_walking_state({ walking: false, direction: defines.direction.north })
    if (stop_mining) actor.set_mining_state({ mining: false })
    if (stop_shooting) actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  }

  function clear_task_state_without_controls() {
    player_state.task_state = TaskStates.IDLE
    player_state.parameters_walk_to_entity = undefined
    player_state.parameters_walking_direct = undefined
    player_state.parameters_mine_entity = undefined
    player_state.parameters_place_entity = undefined
    player_state.parameters_rotate_entity = undefined
    player_state.parameters_move_items = undefined
    player_state.parameters_set_recipe = undefined
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
      const receipt = close_batch('completed')
      const details = receipt
        ? receipt_details(receipt)
        : `batch=none, task_count=0, tasks=none, tick=${game.tick}`
      game.print(`[AUTORIO] All operations completed: ${details}`)
      log(`[AUTORIO] All operations completed: ${details}`)
      return
    }

    log(`[AUTORIO] Next task: ${task.type}, batch=${active_batch_id}, task queue length: ${task_queue.length}`)
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
      case TaskStates.ROTATING:
        player_state.parameters_rotate_entity = task
        break
      case TaskStates.MOVING_ITEMS:
        player_state.parameters_move_items = task
        break
      case TaskStates.SETTING_RECIPE:
        player_state.parameters_set_recipe = task
        break
      case TaskStates.CRAFTING:
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

  function interrupt_current_with(recovery_task: PlayerParameters, resume_task: PlayerParameters) {
    if (player_state.task_state === TaskStates.IDLE) return false
    const interrupted_type = player_state.task_state
    stop_task_controls()
    clear_task_state_without_controls()
    task_queue.unshift(resume_task)
    task_queue.unshift(recovery_task)
    log(`[AUTORIO] Temporarily interrupted ${interrupted_type} with ${recovery_task.type}; original task will resume afterward`)
    next_task()
    return true
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
              player_name: task.target_player_name,
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
              target_unit_number: task.target_unit_number,
              requested_position: task.requested_position,
              count: task.count,
              position: task.position,
              last_target_amount: task.last_target_amount,
            }
          : { type: player_state.task_state }
      }
      case TaskStates.PLACING: {
        const task = player_state.parameters_place_entity
        return task ? { type: task.type, entity_name: task.entity_name, position: task.position, direction: task.direction } : { type: player_state.task_state }
      }
      case TaskStates.ROTATING: {
        const task = player_state.parameters_rotate_entity
        return task ? { type: task.type, target_unit_number: task.target_unit_number, reverse: task.reverse } : { type: player_state.task_state }
      }
      case TaskStates.MOVING_ITEMS: {
        const task = player_state.parameters_move_items
        return task
          ? {
              type: task.type,
              item_name: task.item_name,
              entity_name: task.entity_name,
              player_name: task.player_name,
              target_unit_number: task.target_unit_number,
              max_count: task.max_count,
              to_entity: task.to_entity,
              to_player: task.to_player,
            }
          : { type: player_state.task_state }
      }
      case TaskStates.SETTING_RECIPE: {
        const task = player_state.parameters_set_recipe
        return task
          ? {
              type: task.type,
              target_unit_number: task.target_unit_number,
              recipe_name: task.recipe_name,
            }
          : { type: player_state.task_state }
      }
      case TaskStates.CRAFTING: {
        const task = player_state.parameters_craft_item
        if (!task) return { type: player_state.task_state }
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
      active_batch: active_batch_id === undefined
        ? undefined
        : {
            batch_id: active_batch_id,
            task_count: active_batch_task_types.length,
            task_types: [...active_batch_task_types],
          },
      last_completed_batch,
      last_cancelled_batch,
    }
  }

  function cancel_task() {
    run_cancel_cleanup()
    reset_task_state()
  }

  function cancel_all_tasks(reason = 'cancelled') {
    run_cancel_cleanup()
    reset_task_state()
    task_queue.length = 0
    const receipt = close_batch('cancelled', reason)
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  function discard_all_tasks_after_actor_loss() {
    clear_task_state_without_controls()
    task_queue.length = 0
    const receipt = close_batch('cancelled', 'actor_loss')
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  register_npc_recovery_handler(({ previous_actor_id }) => {
    discard_all_tasks_after_actor_loss()
    log(`[AUTORIO] Discarded active and queued work after loss of actor_id=${previous_actor_id}`)
  })

  register_actor_mode_transition_handler(({ previous_mode, next_mode }) => {
    if (player_state.task_state === TaskStates.IDLE && task_queue.length === 0) return
    cancel_all_tasks('actor_mode_change')
    log(`[AUTORIO] Cancelled active and queued work before actor mode change ${previous_mode} -> ${next_mode}`)
  })

  return {
    player_state,
    add_task,
    next_task,
    interrupt_current_with,
    is_task_queue_empty,
    get_status_snapshot,
    reset_task_state,
    cancel_task,
    cancel_all_tasks,
    discard_all_tasks_after_actor_loss,
    register_cancel_handler,
  }
}
