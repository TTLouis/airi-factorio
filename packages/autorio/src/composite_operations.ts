import type { new_basic_operation_controller } from './basic_operations'
import type { new_navigation_controller } from './navigation'
import type { new_task_manager } from './task_manager'

type BasicController = ReturnType<typeof new_basic_operation_controller>
type NavigationController = ReturnType<typeof new_navigation_controller>
type TaskManager = ReturnType<typeof new_task_manager>

const DEFAULT_RESOURCE_SEARCH_RADIUS = 256
const MAX_RESOURCE_SEARCH_RADIUS = 4096
const MAX_RESOURCE_COUNT = 1000

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

/**
 * High-level deterministic operations built only from existing serialized
 * Autorio tasks. These are intentionally thin orchestration helpers: the
 * underlying navigation/mining controllers remain the source of truth for
 * pathfinding, obstacle recovery, actor ownership and completion receipts.
 */
export function new_composite_operation_controller(
  navigation: NavigationController,
  basic: BasicController,
  manager: TaskManager,
) {
  function gather_resource(
    resource_name: string,
    count: number = 1,
    search_radius: number = DEFAULT_RESOURCE_SEARCH_RADIUS,
  ): [boolean, string] {
    if (typeof resource_name !== 'string' || resource_name.length < 1 || resource_name.length > 200) {
      return [false, 'resource_name must be a valid Factorio resource prototype name']
    }
    if (!valid_integer(count, 1, MAX_RESOURCE_COUNT)) {
      return [false, `count must be an integer from 1 to ${MAX_RESOURCE_COUNT}`]
    }
    if (!valid_integer(search_radius, 1, MAX_RESOURCE_SEARCH_RADIUS)) {
      return [false, `search_radius must be an integer from 1 to ${MAX_RESOURCE_SEARCH_RADIUS}`]
    }

    const prototype = prototypes.entity[resource_name]
    if (!prototype || prototype.type !== 'resource') {
      return [false, `${resource_name} is not a mineable resource entity`]
    }

    // Queue one finite approach followed by the existing mining task. The task
    // manager keeps both in one batch; navigation failure cancels the dependent
    // mining task. Once mining starts, its own reach recovery follows the ore
    // patch without requiring another model turn.
    if (!navigation.submit(resource_name, search_radius)) {
      return [false, `Unable to queue navigation to ${resource_name}`]
    }
    if (!basic.submit_mining(resource_name, count)) {
      manager.cancel_all_tasks('gather_resource_admission_failed')
      return [false, `Unable to queue mining for ${resource_name}`]
    }

    return [true, 'Resource gathering task started']
  }

  return { gather_resource }
}
