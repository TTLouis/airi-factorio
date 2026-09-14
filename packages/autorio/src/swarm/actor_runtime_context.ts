import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { new_basic_operation_runtime } from '../basic_operation_runtime'
import { new_basic_operation_controller } from '../basic_operations'
import { new_combat_controller } from '../combat'
import { new_crafting_controller } from '../crafting'
import { new_navigation_controller } from '../navigation'
import { new_task_manager } from '../task_manager'
import { TaskStates } from '../types'
import { direction_towards } from '../utils/direction'
import type { new_actor_registry } from './actor_registry'
import type { ActorId } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>

export function new_actor_runtime_context(actorId: ActorId, registry: ActorRegistry) {
  const get_actor = () => registry.resolve_actor(actorId, game.tick)
  const manager = new_task_manager(get_actor, { bindGlobalActorLifecycle: false })
  const basic = new_basic_operation_controller(get_actor, manager, { persistenceKey: actorId })
  const basicRuntime = new_basic_operation_runtime(manager, basic)
  const navigation = new_navigation_controller(get_actor, manager, { persistenceKey: actorId })
  const crafting = new_crafting_controller(get_actor, manager, { persistenceKey: actorId })
  const combat = new_combat_controller(get_actor, manager, { persistenceKey: actorId })

  function tick_walking_direct(actor: ControlledActor) {
    const task = manager.player_state.parameters_walking_direct
    if (!task) {
      manager.reset_task_state()
      manager.next_task()
      return
    }
    const target = task.target_position
    if (!target) {
      manager.reset_task_state()
      manager.next_task()
      return
    }
    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, target) })
    if (((target.x - actor.position.x) ** 2 + (target.y - actor.position.y) ** 2) < 2) {
      manager.reset_task_state()
      manager.next_task()
    }
  }

  function discard_volatile_work_after_actor_loss() {
    if (manager.player_state.task_state === TaskStates.IDLE && manager.is_task_queue_empty()) return false
    const snapshot = registry.runtime_snapshot(actorId, game.tick)
    manager.handle_actor_loss(snapshot?.physical?.physicalActorId ?? -1)
    return true
  }

  function tick() {
    const actor = get_actor()
    if (actor === undefined || !actor.is_valid || actor.character === undefined) {
      discard_volatile_work_after_actor_loss()
      return false
    }

    switch (manager.player_state.task_state) {
      case TaskStates.IDLE:
        return true
      case TaskStates.WALKING_TO_ENTITY:
        navigation.tick(actor)
        return true
      case TaskStates.MINING:
        basicRuntime.state_mining(actor)
        return true
      case TaskStates.PLACING:
        basicRuntime.state_placing(actor)
        return true
      case TaskStates.MOVING_ITEMS:
        basicRuntime.state_moving_items(actor)
        return true
      case TaskStates.CRAFTING:
        crafting.tick(actor)
        return true
      case TaskStates.WALKING_DIRECT:
        tick_walking_direct(actor)
        return true
      case TaskStates.ATTACKING:
        combat.tick(actor)
        return true
      case TaskStates.WAITING:
        basicRuntime.state_waiting(actor)
        return true
      case TaskStates.RESEARCHING:
        manager.cancel_all_tasks()
        log(`[AUTORIO] [ERROR] Actor runtime ${actorId} rejected force-scoped research task`)
        return false
      default:
        manager.cancel_all_tasks()
        return false
    }
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    if (!navigation.owns_path_request(event.id)) return false
    return navigation.on_path_finished(event)
  }

  function owns_player_index(playerIndex: number) {
    const actor = get_actor()
    return actor !== undefined && actor.is_valid && actor.owns_player_index(playerIndex)
  }

  function on_player_mined_entity(playerIndex: number) {
    const actor = get_actor()
    if (actor === undefined || !actor.is_valid || !actor.owns_player_index(playerIndex)) return false
    basicRuntime.on_player_mined_entity(actor, playerIndex)
    return true
  }

  function status() {
    return {
      logical_actor: registry.runtime_snapshot(actorId, game.tick),
      tasks: manager.get_status_snapshot(),
      basic: basic.status(),
      navigation: navigation.status(),
      crafting: crafting.status(),
      combat: combat.status(),
    }
  }

  return {
    actorId,
    manager,
    basic,
    navigation,
    crafting,
    combat,
    tick,
    owns_player_index,
    on_path_finished,
    on_player_mined_entity,
    discard_volatile_work_after_actor_loss,
    status,
  }
}
