import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersAttackNearestEnemy } from './types'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MAX_SEARCH_RADIUS = 256
const MAX_COMBAT_TICKS = 60 * 60
const STUCK_TICKS = 10 * 60
const DISTANCE_PROGRESS_EPSILON = 0.25

type CombatCode = 'started' | 'target_destroyed' | 'no_actor' | 'invalid_radius'
  | 'no_target' | 'no_weapon_or_ammo' | 'actor_changed' | 'stuck' | 'timeout'

interface CombatResult {
  accepted: boolean
  completed: boolean
  code: CombatCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  target_name?: string
  target_unit_number?: number
  target_initial_health?: number
}

declare const storage: {
  airi_last_combat_result?: CombatResult
}

function nearest(actor: ControlledActor, entities: LuaEntity[]) {
  let result: LuaEntity | undefined
  let best = math.huge
  for (const entity of entities) {
    const candidate = distance(actor.position, entity.position)
    if (candidate < best) {
      best = candidate
      result = entity
    }
  }
  return result
}

function valid_radius(radius: number) {
  return typeof radius === 'number'
    && radius === math.floor(radius)
    && radius >= 1
    && radius <= MAX_SEARCH_RADIUS
}

function identity_matches(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function has_selected_weapon_and_ammo(character: LuaEntity) {
  const factorioIndex = character.selected_gun_index
  const guns = character.get_inventory(defines.inventory.character_guns)
  const ammo = character.get_inventory(defines.inventory.character_ammo)
  if (!factorioIndex || !guns || !ammo) {
    return false
  }

  // Factorio exposes selected_gun_index as a 1-based Lua inventory slot.
  // typed-factorio intentionally presents LuaInventory as a 0-based
  // TypeScript array, so convert the engine slot before indexing it here.
  const typescriptIndex = factorioIndex - 1
  const gun = guns[typescriptIndex]
  const magazine = ammo[typescriptIndex]
  return gun?.valid_for_read === true && magazine?.valid_for_read === true
}

function record(actor: ControlledActor | undefined, task: PlayerParametersAttackNearestEnemy | undefined, accepted: boolean, completed: boolean, code: CombatCode): CombatResult {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: CombatResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    target_name: task?.target_name,
    target_unit_number: task?.target_unit_number,
    target_initial_health: task?.target_initial_health,
  }
  storage.airi_last_combat_result = result
  return result
}

export function new_combat_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function submit(search_radius: number = 50): [boolean, string] {
    if (!valid_radius(search_radius)) {
      record(get_actor(), undefined, false, false, 'invalid_radius')
      return [false, 'invalid_radius']
    }
    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      record(actor, undefined, false, false, 'no_actor')
      return [false, 'no_actor']
    }
    manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius,
      target: null,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    })
    return [true, 'Combat task queued']
  }

  function fail(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy, code: CombatCode) {
    record(actor, task, false, false, code)
    manager.cancel_all_tasks()
    log(`[AUTORIO] [ERROR] Combat task failed: ${code}; queued operations cancelled`)
  }

  function complete(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    record(actor, task, true, true, 'target_destroyed')
    manager.reset_task_state()
    manager.next_task()
    log('[AUTORIO] Combat task complete: target destroyed')
  }

  function acquire(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    const target = nearest(actor, actor.surface.find_entities_filtered({
      position: actor.position,
      radius: task.search_radius,
      force: 'enemy',
    }))
    if (!target) {
      fail(actor, task, 'no_target')
      return false
    }
    task.target = target
    task.target_name = target.name
    task.target_unit_number = target.unit_number
    task.target_initial_health = target.health ?? undefined
    task.started_tick = game.tick
    task.last_progress_tick = game.tick
    task.last_distance = distance(actor.position, target.position)
    const result = record(actor, task, true, false, 'started')
    log(`[AUTORIO] Combat target acquired: ${result.target_name} unit=${result.target_unit_number ?? 'n/a'}`)
    return true
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_attack_nearest_enemy
    if (!task || manager.player_state.task_state !== TaskStates.ATTACKING) {
      return
    }
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }
    if (!task.target && !acquire(actor, task)) {
      return
    }
    const target = task.target
    if (!target || !target.valid || (target.health !== undefined && target.health !== null && target.health <= 0)) {
      complete(actor, task)
      return
    }
    const character = actor.character
    if (!character || !has_selected_weapon_and_ammo(character)) {
      fail(actor, task, 'no_weapon_or_ammo')
      return
    }
    const started_tick = task.started_tick ?? game.tick
    if (game.tick - started_tick > MAX_COMBAT_TICKS) {
      fail(actor, task, 'timeout')
      return
    }

    const current_distance = distance(actor.position, target.position)
    const previous_distance = task.last_distance ?? current_distance
    if (current_distance + DISTANCE_PROGRESS_EPSILON < previous_distance) {
      task.last_distance = current_distance
      task.last_progress_tick = game.tick
    }

    if (character.can_shoot(target, target.position)) {
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
      actor.update_selected_entity(target.position)
      actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
      // Damage/target invalidation is the proof of progress while engaged.
      task.last_progress_tick = game.tick
      return
    }

    actor.set_shooting_state({ state: defines.shooting.not_shooting, position: target.position })
    if (game.tick - (task.last_progress_tick ?? started_tick) > STUCK_TICKS) {
      fail(actor, task, 'stuck')
      return
    }
    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, target.position) })
  }

  function status() {
    const actor = get_actor()
    const task = manager.player_state.parameters_attack_nearest_enemy
    const target = task?.target
    return {
      task_active: manager.player_state.task_state === TaskStates.ATTACKING,
      actor: actor?.status_snapshot(),
      target: target && target.valid
        ? {
            name: target.name,
            unit_number: target.unit_number,
            position: target.position,
            health: target.health,
            distance: actor ? distance(actor.position, target.position) : undefined,
          }
        : undefined,
      last_result: storage.airi_last_combat_result,
    }
  }

  return { submit, tick, status }
}
