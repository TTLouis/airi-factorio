import type { LuaEntity, LuaInventory, SurfaceCreateEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import type { new_task_manager } from './task_manager'
import { TaskStates } from './types'

type Manager = ReturnType<typeof new_task_manager>
type BasicController = ReturnType<typeof new_basic_operation_controller>

function nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let min_distance = math.huge
  let nearest: LuaEntity | null = null
  for (const entity of entities) {
    const distance = (entity.position.x - actor.position.x) ** 2 + (entity.position.y - actor.position.y) ** 2
    if (distance < min_distance) {
      min_distance = distance
      nearest = entity
    }
  }
  return nearest
}

export function new_basic_operation_runtime(manager: Manager, controller: BasicController) {
  function start_mining(actor: ControlledActor, entity: LuaEntity) {
    const task = manager.player_state.parameters_mine_entity
    if (!task) return
    task.position = { x: entity.position.x, y: entity.position.y }
    task.last_target_amount = entity.type === 'resource' ? entity.amount : undefined
    actor.update_selected_entity(entity.position)
    actor.set_mining_state({ mining: true, position: entity.position })
    log(`[AUTORIO] Started mining ${entity.name} at position: ${serpent.line(entity.position)}`)
  }

  function current_mining_target(actor: ControlledActor) {
    const task = manager.player_state.parameters_mine_entity
    if (!task?.position) return undefined
    return actor.surface.find_entities_filtered({
      position: task.position,
      radius: 0.25,
      name: task.entity_name,
    })[0]
  }

  function finish_mining(actor: ControlledActor) {
    const task = manager.player_state.parameters_mine_entity
    if (!task) return
    actor.set_mining_state({ mining: false })
    log('[AUTORIO] Mining task complete')
    controller.complete(actor, task)
  }

  function poll_standalone_mining(actor: ControlledActor) {
    const task = manager.player_state.parameters_mine_entity
    if (!task || !task.position || actor.status_snapshot().kind !== 'standalone_character') return false

    const target = current_mining_target(actor)
    if (!target) {
      // A standalone scripted character has no LuaPlayer mined-entity event. A
      // disappeared selected entity is the engine-visible completion boundary
      // retained from the verified mining harness. Cross-world interference is
      // still treated fail-closed at actor identity boundaries; stronger product
      // attribution can be layered on top without changing this receipt model.
      task.count -= 1
      task.position = undefined
      task.last_target_amount = undefined
      actor.set_mining_state({ mining: false })
      log(`[AUTORIO] Standalone actor completed mining cycle, remaining: ${task.count}`)
    }
    else if (target.type === 'resource') {
      const amount = target.amount
      if (task.last_target_amount === undefined) {
        task.last_target_amount = amount
      }
      else if (amount < task.last_target_amount) {
        const mined = math.min(task.count, task.last_target_amount - amount)
        task.count -= mined
        task.last_target_amount = amount
        log(`[AUTORIO] Standalone actor mined ${mined} ${task.entity_name}, remaining: ${task.count}`)
      }
    }

    if (task.count <= 0) {
      finish_mining(actor)
      return true
    }
    return false
  }

  function state_mining(actor: ControlledActor) {
    const task = manager.player_state.parameters_mine_entity
    if (!task) {
      log('[AUTORIO] No parameters found when mining')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }
    if (poll_standalone_mining(actor)) return
    if (actor.get_mining_state().mining) return

    if (task.position) {
      const existing = current_mining_target(actor)
      if (existing) {
        start_mining(actor, existing)
        return
      }
      task.position = undefined
      task.last_target_amount = undefined
    }

    const entities = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: 5,
      name: task.entity_name,
    })
    if (entities.length === 0) {
      controller.fail(actor, task, 'no_target')
      return
    }
    const nearest = nearest_entity(actor, entities)
    if (!nearest) {
      controller.fail(actor, task, 'no_target')
      return
    }
    start_mining(actor, nearest)
  }

  function on_player_mined_entity(actor: ControlledActor, player_index: number) {
    if (!actor.owns_player_index(player_index) || manager.player_state.task_state !== TaskStates.MINING) return
    const task = manager.player_state.parameters_mine_entity
    if (!task) return
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }
    task.count -= 1
    task.position = undefined
    task.last_target_amount = undefined
    log(`[AUTORIO] Controlled player completed mining cycle, remaining: ${task.count}`)
    if (task.count <= 0) finish_mining(actor)
  }

  function state_placing(actor: ControlledActor) {
    const task = manager.player_state.parameters_place_entity
    if (!task) {
      log('[AUTORIO] No parameters found when placing')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return [false, 'Actor changed']
    }

    const surface = actor.surface
    const inventory = actor.get_main_inventory()
    if (!inventory) {
      controller.fail(actor, task, 'no_inventory')
      return [false, 'Cannot access actor inventory']
    }

    const prototype = prototypes.entity[task.entity_name]
    if (!prototype || !prototype.items_to_place_this || !prototype.items_to_place_this[0]) {
      controller.fail(actor, task, 'invalid_entity')
      return [false, 'Invalid entity name']
    }

    const [item_stack] = inventory.find_item_stack(task.entity_name)
    if (!item_stack) {
      controller.fail(actor, task, 'item_missing')
      return [false, 'Entity not found in inventory']
    }

    if (!task.position) {
      task.position = surface.find_non_colliding_position(task.entity_name, actor.position, 1, 1)
      if (!task.position) {
        controller.fail(actor, task, 'no_position')
        return [false, 'Could not find a valid position to place the entity']
      }
    }

    const create_entity_args: SurfaceCreateEntity = {
      name: task.entity_name,
      position: task.position,
      raise_built: true,
      ...actor.entity_build_args(),
    }
    const entity = surface.create_entity(create_entity_args)
    if (!entity) {
      controller.fail(actor, task, 'create_failed')
      return [false, 'Failed to place entity']
    }

    item_stack.count = item_stack.count - 1
    log(`[AUTORIO] Entity placed successfully: ${task.entity_name}`)
    controller.complete(actor, task)
    return [true, 'Entity placed successfully', entity]
  }

  function state_moving_items(actor: ControlledActor) {
    const task = manager.player_state.parameters_move_items
    if (!task) {
      log('[AUTORIO] No parameters found when moving items')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return 0
    }

    const nearby_entities = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: 8,
      name: task.entity_name,
      force: actor.force,
    })
    if (nearby_entities.length === 0) {
      controller.fail(actor, task, 'no_target')
      return 0
    }

    const actor_inventory = actor.get_main_inventory()
    if (!actor_inventory) {
      controller.fail(actor, task, 'no_inventory')
      return 0
    }

    let moved_total = 0
    if (task.to_entity) {
      const [item_stack] = actor_inventory.find_item_stack(task.item_name)
      if (!item_stack) {
        controller.fail(actor, task, 'item_missing')
        return 0
      }

      nearby_entities
        .map((entity) => {
          const inventories: LuaInventory[] = []
          const max_index = entity.get_max_inventory_index()
          for (let i = 1; i <= max_index; i++) {
            const inventory = entity.get_inventory(i)
            if (inventory && inventory.can_insert({ name: task.item_name })) inventories.push(inventory)
          }
          return inventories
        })
        .flat()
        .forEach((inventory) => {
          if (moved_total >= task.max_count) return
          const to_move = math.min(item_stack.count, task.max_count - moved_total)
          if (to_move <= 0) return
          const moved = inventory.insert({ name: task.item_name, count: to_move })
          if (moved > 0) {
            actor_inventory.remove({ name: task.item_name, count: moved })
            moved_total += moved
          }
        })
    }
    else {
      nearby_entities
        .map((entity) => {
          const inventories: LuaInventory[] = []
          const max_index = entity.get_max_inventory_index()
          for (let i = 1; i <= max_index; i++) {
            const inventory = entity.get_inventory(i)
            if (inventory) inventories.push(inventory)
          }
          return inventories
        })
        .flat()
        .forEach((inventory) => {
          if (moved_total >= task.max_count) return
          if (!actor_inventory.can_insert({ name: task.item_name })) return
          const removed = inventory.remove({ name: task.item_name, count: task.max_count - moved_total })
          if (removed <= 0) return
          const inserted = actor_inventory.insert({ name: task.item_name, count: removed })
          if (inserted < removed) inventory.insert({ name: task.item_name, count: removed - inserted })
          moved_total += inserted
        })
    }

    if (moved_total <= 0) {
      controller.fail(actor, task, 'nothing_moved', { moved_count: 0 })
      return 0
    }
    log(`[AUTORIO] Moved a total of ${moved_total} ${task.item_name}`)
    controller.complete(actor, task, { moved_count: moved_total })
    return moved_total
  }

  function state_waiting(actor: ControlledActor) {
    const task = manager.player_state.parameters_waiting
    if (!task) {
      log('[AUTORIO] No parameters found when waiting')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }
    if (task.remaining_ticks <= 0) {
      log('[AUTORIO] Waiting task complete')
      controller.complete(actor, task)
      return
    }
    task.remaining_ticks -= 1
  }

  return {
    state_mining,
    state_placing,
    state_moving_items,
    state_waiting,
    on_player_mined_entity,
  }
}
