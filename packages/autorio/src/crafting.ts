import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersCraftItem } from './types'
import { TaskStates } from './types'

const MAX_CRAFT_COUNT = 1000
const MAX_CRAFT_TICKS = 10 * 60 * 60

type CraftingCode = 'queued' | 'started' | 'completed' | 'cancelled'
  | 'no_actor' | 'invalid_count' | 'recipe_unavailable' | 'recipe_locked'
  | 'native_queue_busy' | 'not_enough_ingredients' | 'could_not_start'
  | 'partial_start' | 'actor_changed' | 'output_missing' | 'timeout'

export interface CraftingResult {
  accepted: boolean
  completed: boolean
  code: CraftingCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  item_name?: string
  requested_count?: number
  started_count?: number
  output_count_before?: number
  output_count_after?: number
  native_queue_remaining?: number
}

export interface OwnedCraftingMarker {
  actor_id: number
  actor_kind: string
  force_index: number
  item_name: string
  requested_count: number
  started_tick: number
}

export interface CraftingContextStorage {
  last_result?: CraftingResult
  owned_crafting?: OwnedCraftingMarker
}

export interface CraftingControllerOptions {
  persistenceKey?: string
}

declare const storage: {
  airi_last_crafting_result?: CraftingResult
  airi_owned_crafting?: OwnedCraftingMarker
  airi_crafting_contexts?: Record<string, CraftingContextStorage>
}

function context_storage(key: string) {
  if (storage.airi_crafting_contexts === undefined) storage.airi_crafting_contexts = {}
  let context = storage.airi_crafting_contexts[key]
  if (context === undefined) {
    context = {}
    storage.airi_crafting_contexts[key] = context
  }
  return context
}

export function get_crafting_context_storage(persistenceKey: string) {
  return storage.airi_crafting_contexts?.[persistenceKey]
}

function owned_marker(persistenceKey?: string) {
  return persistenceKey === undefined
    ? storage.airi_owned_crafting
    : storage.airi_crafting_contexts?.[persistenceKey]?.owned_crafting
}

function set_owned_marker(marker: OwnedCraftingMarker | undefined, persistenceKey?: string) {
  if (persistenceKey === undefined) {
    storage.airi_owned_crafting = marker
    return
  }
  context_storage(persistenceKey).owned_crafting = marker
}

function last_result(persistenceKey?: string) {
  return persistenceKey === undefined
    ? storage.airi_last_crafting_result
    : storage.airi_crafting_contexts?.[persistenceKey]?.last_result
}

function store_result(result: CraftingResult, persistenceKey?: string) {
  if (persistenceKey === undefined) storage.airi_last_crafting_result = result
  else context_storage(persistenceKey).last_result = result
}

function valid_count(count: number) {
  return typeof count === 'number'
    && count === math.floor(count)
    && count >= 1
    && count <= MAX_CRAFT_COUNT
}

function identity_matches(actor: ControlledActor, task: PlayerParametersCraftItem) {
  if (task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined) {
    return false
  }

  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function output_count(actor: ControlledActor, item_name: string) {
  return actor.get_main_inventory()?.get_item_count(item_name) ?? 0
}

function record(actor: ControlledActor | undefined, task: PlayerParametersCraftItem | undefined, accepted: boolean, completed: boolean, code: CraftingCode, persistenceKey?: string): CraftingResult {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: CraftingResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    item_name: task?.item_name,
    requested_count: task?.count,
    started_count: task?.started,
    output_count_before: task?.output_count_before,
    output_count_after: actor && task ? output_count(actor, task.item_name) : undefined,
    native_queue_remaining: actor?.get_crafting_queue().length,
  }
  store_result(result, persistenceKey)
  return result
}

function persist_owned_marker(task: PlayerParametersCraftItem, persistenceKey?: string) {
  if (task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined || task.started_tick === undefined) {
    return
  }
  set_owned_marker({
    actor_id: task.owner_actor_id,
    actor_kind: task.owner_actor_kind,
    force_index: task.owner_force_index,
    item_name: task.item_name,
    requested_count: task.count,
    started_tick: task.started_tick,
  }, persistenceKey)
}

function clear_owned_marker(task: PlayerParametersCraftItem, persistenceKey?: string) {
  const marker = owned_marker(persistenceKey)
  if (marker === undefined) return
  if (marker.actor_id === task.owner_actor_id && marker.actor_kind === task.owner_actor_kind && marker.force_index === task.owner_force_index) {
    set_owned_marker(undefined, persistenceKey)
  }
}

export function new_crafting_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>, options: CraftingControllerOptions = {}) {
  const persistenceKey = options.persistenceKey

  function cancel_owned_native_queue(actor: ControlledActor, task: PlayerParametersCraftItem) {
    if (!task.owns_native_queue) {
      return 0
    }

    const queue = actor.get_crafting_queue()
    let cancelled = 0
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i]
      if (!item) continue
      actor.cancel_crafting({ index: item.index, count: item.count })
      cancelled += item.count
    }
    task.owns_native_queue = false
    return cancelled
  }

  function fail(actor: ControlledActor | undefined, task: PlayerParametersCraftItem, code: CraftingCode, cancel_native = true) {
    if (cancel_native && actor && identity_matches(actor, task)) {
      cancel_owned_native_queue(actor, task)
    }
    if (code !== 'actor_changed') clear_owned_marker(task, persistenceKey)
    task.owns_native_queue = false
    manager.cancel_all_tasks()
    record(actor, task, false, false, code, persistenceKey)
    log(`[AUTORIO] [ERROR] Crafting task failed: ${code}; dependent operations cancelled`)
  }

  function complete(actor: ControlledActor, task: PlayerParametersCraftItem) {
    clear_owned_marker(task, persistenceKey)
    task.owns_native_queue = false
    record(actor, task, true, true, 'completed', persistenceKey)
    manager.reset_task_state()
    manager.next_task()
    log(`[AUTORIO] Crafting task complete: ${task.item_name} x${task.started ?? task.count}`)
  }

  function submit(item_name: string, count: number = 1): [boolean, string] {
    if (!valid_count(count)) {
      record(get_actor(), undefined, false, false, 'invalid_count', persistenceKey)
      return [false, `Craft count must be an integer from 1 to ${MAX_CRAFT_COUNT}`]
    }

    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      record(actor, undefined, false, false, 'no_actor', persistenceKey)
      return [false, 'No controlled actor']
    }

    const recipe = actor.force.recipes[item_name]
    if (!recipe) {
      record(actor, undefined, false, false, 'recipe_unavailable', persistenceKey)
      return [false, 'Recipe not available']
    }
    if (!recipe.enabled) {
      record(actor, undefined, false, false, 'recipe_locked', persistenceKey)
      return [false, 'Recipe not unlocked']
    }

    if (actor.get_crafting_queue().length > 0) {
      record(actor, undefined, false, false, 'native_queue_busy', persistenceKey)
      return [false, 'Native crafting queue is busy; wait for existing crafts before retrying']
    }

    if (actor.get_craftable_count(item_name) < count) {
      record(actor, undefined, false, false, 'not_enough_ingredients', persistenceKey)
      return [false, 'Not enough ingredients']
    }

    const task: PlayerParametersCraftItem = {
      type: TaskStates.CRAFTING,
      item_name,
      count,
      crafted: 0,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    }
    manager.add_task(task)
    record(actor, task, true, false, 'queued', persistenceKey)
    log(`[AUTORIO] New craft_item task: ${item_name} x${count}`)
    return [true, 'Task started']
  }

  function start_native(actor: ControlledActor, task: PlayerParametersCraftItem) {
    if (actor.get_crafting_queue().length > 0) {
      fail(actor, task, 'native_queue_busy', false)
      return false
    }

    const recipe = actor.force.recipes[task.item_name]
    if (!recipe) {
      fail(actor, task, 'recipe_unavailable', false)
      return false
    }
    if (!recipe.enabled) {
      fail(actor, task, 'recipe_locked', false)
      return false
    }
    if (actor.get_craftable_count(task.item_name) < task.count) {
      fail(actor, task, 'not_enough_ingredients', false)
      return false
    }

    task.output_count_before = output_count(actor, task.item_name)
    task.started = actor.begin_crafting({ count: task.count, recipe: task.item_name })
    task.started_tick = game.tick
    task.expected_output_delta = task.started
    task.owns_native_queue = task.started > 0 && actor.get_crafting_queue().length > 0

    if (task.started <= 0) {
      fail(actor, task, 'could_not_start', false)
      return false
    }
    if (task.started !== task.count) {
      fail(actor, task, 'partial_start')
      return false
    }

    if (task.owns_native_queue) persist_owned_marker(task, persistenceKey)
    record(actor, task, true, false, 'started', persistenceKey)
    return true
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_craft_item
    if (!task || manager.player_state.task_state !== TaskStates.CRAFTING) return
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed', false)
      return
    }

    if (task.started === undefined) {
      if (!start_native(actor, task)) return
    }

    const before = task.output_count_before ?? 0
    const expected = task.expected_output_delta ?? task.started ?? task.count
    const produced = math.max(0, output_count(actor, task.item_name) - before)
    task.crafted = math.min(task.started ?? task.count, produced)

    const queue = actor.get_crafting_queue()
    if (queue.length === 0) {
      task.owns_native_queue = false
      if (produced >= expected) complete(actor, task)
      else fail(actor, task, 'output_missing', false)
      return
    }

    if (task.started_tick !== undefined && game.tick - task.started_tick > MAX_CRAFT_TICKS) {
      fail(actor, task, 'timeout')
    }
  }

  function status() {
    const actor = get_actor()
    return {
      task_active: manager.player_state.task_state === TaskStates.CRAFTING,
      actor: actor?.status_snapshot(),
      native_queue: actor?.get_crafting_queue().slice(0, 16),
      persisted_owner: owned_marker(persistenceKey),
      last_result: last_result(persistenceKey),
    }
  }

  manager.register_cancel_handler(TaskStates.CRAFTING, () => {
    const task = manager.player_state.parameters_craft_item
    if (!task || task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined) return

    const actor = get_actor()
    if (!actor || !identity_matches(actor, task)) return

    const before = task.output_count_before ?? output_count(actor, task.item_name)
    const expected = task.expected_output_delta ?? task.started ?? task.count
    const produced = math.max(0, output_count(actor, task.item_name) - before)
    if (task.started !== undefined && actor.get_crafting_queue().length === 0 && produced >= expected) {
      clear_owned_marker(task, persistenceKey)
      task.owns_native_queue = false
      record(actor, task, true, true, 'completed', persistenceKey)
      return
    }

    cancel_owned_native_queue(actor, task)
    clear_owned_marker(task, persistenceKey)
    record(actor, task, false, false, 'cancelled', persistenceKey)
  })

  return { submit, tick, status }
}
