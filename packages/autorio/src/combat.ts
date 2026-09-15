import type { LuaEntity, LuaInventory, LuaItemStack } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersAttackNearestEnemy } from './types'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MAX_SEARCH_RADIUS = 256
const MAX_SINGLE_COMBAT_TICKS = 60 * 60
const MAX_CLEAR_AREA_TICKS = 10 * 60 * 60
const STUCK_TICKS = 10 * 60
const DISTANCE_PROGRESS_EPSILON = 0.25
const MOBILE_THREAT_PRIORITY_RADIUS = 28
const KITE_DISTANCE = 12
const PANIC_DISTANCE = 7
const LOW_HEALTH_RATIO = 0.35
const TURRET_DANGER_DISTANCE = 10
const TURRET_STAGING_DISTANCE = 24
const TURRET_MIN_ADVANCE_DISTANCE = 6
const TURRET_BEHIND_ACTOR_DISTANCE = 3.5
const TURRET_LATERAL_SPACING = 2.5
const TURRET_ACTOR_CLEARANCE = 2.5
const TURRET_LOAD_COUNT = 20
const MAX_SUPPORT_TURRETS = 4
const TURRET_AMMO_PRIORITY = ['uranium-rounds-magazine', 'piercing-rounds-magazine', 'firearm-magazine']

type CombatCode = 'started' | 'target_destroyed' | 'area_cleared' | 'no_actor' | 'invalid_radius'
  | 'no_target' | 'no_weapon_or_ammo' | 'actor_changed' | 'low_health' | 'stuck' | 'timeout'

interface CombatResult {
  accepted: boolean
  completed: boolean
  code: CombatCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  mode?: 'single' | 'clear_area'
  target_name?: string
  target_unit_number?: number
  target_initial_health?: number
  targets_destroyed?: number
  turrets_placed?: number
  initial_static_threats?: number
  support_turret_budget?: number
  support_stage_started?: boolean
  last_turret_position?: { x: number, y: number }
  last_turret_unit_number?: number
  turret_ammo_name?: string
  last_turret_ammo_loaded?: number
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

function preferred_target(actor: ControlledActor, entities: LuaEntity[]) {
  let nearest_mobile: LuaEntity | undefined
  let mobile_distance = math.huge
  for (const entity of entities) {
    if (entity.type !== 'unit') continue
    const candidate = distance(actor.position, entity.position)
    if (candidate <= MOBILE_THREAT_PRIORITY_RADIUS && candidate < mobile_distance) {
      nearest_mobile = entity
      mobile_distance = candidate
    }
  }
  return nearest_mobile ?? nearest(actor, entities)
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

  const typescriptIndex = factorioIndex - 1
  const gun = guns[typescriptIndex]
  const magazine = ammo[typescriptIndex]
  return gun?.valid_for_read === true && magazine?.valid_for_read === true
}

function is_alive(entity: LuaEntity | null | undefined) {
  return !!entity && entity.valid && !(entity.health !== undefined && entity.health !== null && entity.health <= 0)
}

function is_static_enemy(entity: LuaEntity) {
  return entity.type === 'unit-spawner' || entity.type === 'turret'
}

function support_turret_budget(static_threats: number) {
  if (static_threats <= 0) return 0
  if (static_threats === 1) return 1
  if (static_threats <= 3) return 2
  if (static_threats <= 6) return 3
  return MAX_SUPPORT_TURRETS
}

function retreat_position(actor: ControlledActor, threat: LuaEntity) {
  const dx = actor.position.x - threat.position.x
  const dy = actor.position.y - threat.position.y
  return {
    x: actor.position.x + dx,
    y: actor.position.y + dy,
  }
}

function selected_support_ammo(inventory: LuaInventory): { name: string, stack: LuaItemStack } | undefined {
  for (const name of TURRET_AMMO_PRIORITY) {
    const [stack] = inventory.find_item_stack(name)
    if (stack?.valid_for_read === true && stack.count > 0) return { name, stack }
  }
  return undefined
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
    mode: task?.combat_mode,
    target_name: task?.target_name,
    target_unit_number: task?.target_unit_number,
    target_initial_health: task?.target_initial_health,
    targets_destroyed: task?.targets_destroyed,
    turrets_placed: task?.turrets_placed,
    initial_static_threats: task?.initial_static_threats,
    support_turret_budget: task?.support_turret_budget,
    support_stage_started: task?.support_stage_started,
    last_turret_position: task?.last_turret_position,
    last_turret_unit_number: task?.last_turret_unit_number,
    turret_ammo_name: task?.turret_ammo_name,
    last_turret_ammo_loaded: task?.last_turret_ammo_loaded,
  }
  storage.airi_last_combat_result = result
  return result
}

export function new_combat_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function submit_task(search_radius: number, combat_mode: 'single' | 'clear_area'): [boolean, string] {
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
      combat_mode,
      origin_position: { x: actor.position.x, y: actor.position.y },
      target: null,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
      targets_destroyed: 0,
      turrets_placed: 0,
      started_tick: game.tick,
    })
    return [true, combat_mode === 'clear_area' ? 'Area-clear combat task queued' : 'Combat task queued']
  }

  function submit(search_radius: number = 50): [boolean, string] {
    return submit_task(search_radius, 'single')
  }

  function submit_clear(search_radius: number = 96): [boolean, string] {
    return submit_task(search_radius, 'clear_area')
  }

  function stop_actor_combat(actor: ControlledActor) {
    actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  }

  function fail(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy, code: CombatCode) {
    stop_actor_combat(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, false, false, code)
    manager.cancel_all_tasks()
    log(`[AUTORIO] [ERROR] Combat task failed: ${code}; queued operations cancelled`)
  }

  function complete_single(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    stop_actor_combat(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'target_destroyed')
    manager.reset_task_state()
    manager.next_task()
    log('[AUTORIO] Combat task complete: target destroyed')
  }

  function complete_area(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    stop_actor_combat(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'area_cleared')
    manager.reset_task_state()
    manager.next_task()
    log(`[AUTORIO] Combat area clear: destroyed ${task.targets_destroyed ?? 0} targets, placed ${task.turrets_placed ?? 0}/${task.support_turret_budget ?? 0} support turrets`)
  }

  function area_enemies(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    const origin = task.origin_position ?? actor.position
    return actor.surface.find_entities_filtered({
      position: origin,
      radius: task.search_radius,
      force: 'enemy',
    })
  }

  function initialize_support_plan(task: PlayerParametersAttackNearestEnemy, enemies: LuaEntity[]) {
    if (task.combat_mode !== 'clear_area' || task.support_turret_budget !== undefined) return
    let static_threats = 0
    for (const entity of enemies) if (is_alive(entity) && is_static_enemy(entity)) static_threats++
    task.initial_static_threats = static_threats
    task.support_turret_budget = support_turret_budget(static_threats)
    log(`[AUTORIO] Combat support plan: static_threats=${static_threats}, turret_budget=${task.support_turret_budget}`)
  }

  function bind_target(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy, target: LuaEntity, reason: 'acquired' | 'preempted') {
    task.target = target
    task.target_name = target.name
    task.target_unit_number = target.unit_number
    task.target_initial_health = target.health ?? undefined
    task.last_progress_tick = game.tick
    task.last_distance = distance(actor.position, target.position)
    const result = record(actor, task, true, false, 'started')
    log(`[AUTORIO] Combat target ${reason}: ${result.target_name} unit=${result.target_unit_number ?? 'n/a'} mode=${task.combat_mode ?? 'single'}`)
  }

  function acquire(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    const enemies = area_enemies(actor, task)
    initialize_support_plan(task, enemies)
    const target = preferred_target(actor, enemies)
    if (!target) {
      if (task.combat_mode === 'clear_area') complete_area(actor, task)
      else fail(actor, task, 'no_target')
      return false
    }
    bind_target(actor, task, target, 'acquired')
    return true
  }

  function nearby_mobile_threat(actor: ControlledActor) {
    let threat: LuaEntity | undefined
    let best = math.huge
    const local_units = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: MOBILE_THREAT_PRIORITY_RADIUS,
      force: 'enemy',
      type: 'unit',
    })
    for (const entity of local_units) {
      if (!is_alive(entity)) continue
      const candidate = distance(actor.position, entity.position)
      if (candidate < best) {
        threat = entity
        best = candidate
      }
    }
    return threat
  }

  function preempt_static_target_for_mobile_threat(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    const target = task.target
    if (task.combat_mode !== 'clear_area' || !target || !is_alive(target) || !is_static_enemy(target)) return false
    const threat = nearby_mobile_threat(actor)
    if (!threat || threat === target) return false
    bind_target(actor, task, threat, 'preempted')
    stop_actor_combat(actor)
    return true
  }

  function clear_bound_target(task: PlayerParametersAttackNearestEnemy) {
    task.target = null
    task.target_name = undefined
    task.target_unit_number = undefined
    task.target_initial_health = undefined
    task.last_distance = undefined
    task.last_progress_tick = game.tick
  }

  function target_destroyed(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
    task.targets_destroyed = (task.targets_destroyed ?? 0) + 1
    if (task.combat_mode !== 'clear_area') {
      complete_single(actor, task)
      return
    }
    clear_bound_target(task)
    stop_actor_combat(actor)
    acquire(actor, task)
  }

  function nearest_mobile_enemy_distance(actor: ControlledActor) {
    let result = math.huge
    const local_units = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: TURRET_DANGER_DISTANCE,
      force: 'enemy',
      type: 'unit',
    })
    for (const entity of local_units) {
      if (!is_alive(entity)) continue
      const candidate = distance(actor.position, entity.position)
      if (candidate < result) result = candidate
    }
    return result
  }

  function should_place_support(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy, target: LuaEntity) {
    if (task.combat_mode !== 'clear_area' || !is_static_enemy(target)) return false
    const budget = task.support_turret_budget ?? 0
    if ((task.turrets_placed ?? 0) >= budget) return false
    if (nearest_mobile_enemy_distance(actor) <= TURRET_DANGER_DISTANCE) return false

    if (!task.support_stage_started) {
      const origin = task.origin_position ?? actor.position
      const advanced = distance(actor.position, origin) >= TURRET_MIN_ADVANCE_DISTANCE
      const staged = distance(actor.position, target.position) <= TURRET_STAGING_DISTANCE
      if (!advanced || !staged) return false
      task.support_stage_started = true
      log(`[AUTORIO] Combat support staging established after advancing ${distance(actor.position, origin)} tiles; budget=${budget}`)
    }
    return true
  }

  function support_anchor(actor: ControlledActor, target: LuaEntity, turret_index: number) {
    let away_x = actor.position.x - target.position.x
    let away_y = actor.position.y - target.position.y
    const magnitude = math.sqrt(away_x * away_x + away_y * away_y)
    if (magnitude > 0.001) {
      away_x /= magnitude
      away_y /= magnitude
    }
    else {
      away_x = -1
      away_y = 0
    }

    const perpendicular_x = -away_y
    const perpendicular_y = away_x
    let lateral = 0
    if (turret_index > 0) {
      const rank = math.floor((turret_index + 1) / 2)
      const side = turret_index % 2 === 1 ? 1 : -1
      lateral = rank * TURRET_LATERAL_SPACING * side
    }

    return {
      x: actor.position.x + away_x * TURRET_BEHIND_ACTOR_DISTANCE + perpendicular_x * lateral,
      y: actor.position.y + away_y * TURRET_BEHIND_ACTOR_DISTANCE + perpendicular_y * lateral,
    }
  }

  function place_support_turret(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy, target: LuaEntity) {
    if (!should_place_support(actor, task, target)) return false
    const inventory = actor.get_main_inventory()
    if (!inventory) return false
    const [turret_stack] = inventory.find_item_stack('gun-turret')
    if (!turret_stack || !turret_stack.valid_for_read || turret_stack.count <= 0) return false
    const ammo = selected_support_ammo(inventory)
    if (!ammo) return false

    const turret_index = task.turrets_placed ?? 0
    const anchor = support_anchor(actor, target, turret_index)
    const position = actor.surface.find_non_colliding_position('gun-turret', anchor, 2, 0.25, false)
    if (!position) return false
    if (distance(position, actor.position) < TURRET_ACTOR_CLEARANCE) {
      log(`[AUTORIO] Refusing support turret position ${serpent.line(position)} inside actor clearance ${TURRET_ACTOR_CLEARANCE}`)
      return false
    }

    const turret = actor.surface.create_entity({
      name: 'gun-turret',
      position,
      raise_built: true,
      ...actor.entity_build_args(),
    })
    if (!turret) return false

    const turret_inventory = turret.get_inventory(defines.inventory.turret_ammo)
    if (!turret_inventory) {
      turret.destroy()
      return false
    }

    const removed_turret = inventory.remove({ name: 'gun-turret', count: 1 })
    if (removed_turret !== 1) {
      turret.destroy()
      return false
    }

    const requested_ammo = math.min(TURRET_LOAD_COUNT, ammo.stack.count)
    const removed_ammo = inventory.remove({ name: ammo.name, count: requested_ammo })
    if (removed_ammo <= 0) {
      inventory.insert({ name: 'gun-turret', count: 1 })
      turret.destroy()
      return false
    }

    const inserted_ammo = turret_inventory.insert({ name: ammo.name, count: removed_ammo })
    if (inserted_ammo < removed_ammo) {
      inventory.insert({ name: ammo.name, count: removed_ammo - inserted_ammo })
    }
    if (inserted_ammo <= 0) {
      inventory.insert({ name: 'gun-turret', count: 1 })
      turret.destroy()
      return false
    }

    task.turrets_placed = turret_index + 1
    task.last_turret_position = { x: position.x, y: position.y }
    task.last_turret_unit_number = turret.unit_number
    task.turret_ammo_name = ammo.name
    task.last_turret_ammo_loaded = inserted_ammo
    log(`[AUTORIO] Combat support turret ${task.turrets_placed}/${task.support_turret_budget ?? 0} placed at ${serpent.line(position)} unit=${turret.unit_number ?? 'n/a'} with ${inserted_ammo} ${ammo.name}`)
    return true
  }

  function health_ratio(character: LuaEntity) {
    if (character.health === undefined || character.health === null || character.max_health <= 0) return 1
    return character.health / character.max_health
  }

  function walk_toward(actor: ControlledActor, position: { x: number, y: number }) {
    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, position) })
  }

  function shoot_while_retreating(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy, target: LuaEntity) {
    actor.update_selected_entity(target.position)
    actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
    if (task.last_turret_position) walk_toward(actor, task.last_turret_position)
    else walk_toward(actor, retreat_position(actor, target))
    task.last_progress_tick = game.tick
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
    if (!task.target && !acquire(actor, task)) return
    if (is_alive(task.target)) preempt_static_target_for_mobile_threat(actor, task)
    const target = task.target
    if (!is_alive(target)) {
      target_destroyed(actor, task)
      return
    }
    if (!target) return

    const character = actor.character
    if (!character || !has_selected_weapon_and_ammo(character)) {
      fail(actor, task, 'no_weapon_or_ammo')
      return
    }
    const started_tick = task.started_tick ?? game.tick
    const max_ticks = task.combat_mode === 'clear_area' ? MAX_CLEAR_AREA_TICKS : MAX_SINGLE_COMBAT_TICKS
    if (game.tick - started_tick > max_ticks) {
      fail(actor, task, 'timeout')
      return
    }

    const can_shoot = character.can_shoot(target, target.position)
    const current_distance = distance(actor.position, target.position)
    const previous_distance = task.last_distance ?? current_distance
    if (current_distance + DISTANCE_PROGRESS_EPSILON < previous_distance) {
      task.last_distance = current_distance
      task.last_progress_tick = game.tick
    }

    if (health_ratio(character) <= LOW_HEALTH_RATIO) {
      if (task.last_turret_position) {
        if (can_shoot) shoot_while_retreating(actor, task, target)
        else {
          stop_actor_combat(actor)
          walk_toward(actor, task.last_turret_position)
        }
        return
      }
      fail(actor, task, 'low_health')
      return
    }

    if (task.combat_mode === 'clear_area') place_support_turret(actor, task, target)

    if (can_shoot) {
      actor.update_selected_entity(target.position)
      actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
      task.last_progress_tick = game.tick

      if (target.type === 'unit' && current_distance <= KITE_DISTANCE) {
        shoot_while_retreating(actor, task, target)
      }
      else if (is_static_enemy(target)) {
        actor.set_walking_state({ walking: false, direction: defines.direction.north })
      }
      else {
        walk_toward(actor, retreat_position(actor, target))
      }
      return
    }

    stop_actor_combat(actor)
    if (target.type === 'unit' && current_distance <= PANIC_DISTANCE) {
      if (task.last_turret_position) walk_toward(actor, task.last_turret_position)
      else walk_toward(actor, retreat_position(actor, target))
      return
    }
    if (game.tick - (task.last_progress_tick ?? started_tick) > STUCK_TICKS) {
      fail(actor, task, 'stuck')
      return
    }
    walk_toward(actor, target.position)
  }

  function status() {
    const actor = get_actor()
    const task = manager.player_state.parameters_attack_nearest_enemy
    const target = task?.target
    return {
      task_active: manager.player_state.task_state === TaskStates.ATTACKING,
      actor: actor?.status_snapshot(),
      mode: task?.combat_mode,
      origin_position: task?.origin_position,
      targets_destroyed: task?.targets_destroyed ?? 0,
      turrets_placed: task?.turrets_placed ?? 0,
      initial_static_threats: task?.initial_static_threats ?? 0,
      support_turret_budget: task?.support_turret_budget ?? 0,
      support_stage_started: task?.support_stage_started ?? false,
      last_turret_position: task?.last_turret_position,
      last_turret_unit_number: task?.last_turret_unit_number,
      turret_ammo_name: task?.turret_ammo_name,
      last_turret_ammo_loaded: task?.last_turret_ammo_loaded,
      target: target && target.valid
        ? {
            name: target.name,
            type: target.type,
            unit_number: target.unit_number,
            position: target.position,
            health: target.health,
            distance: actor ? distance(actor.position, target.position) : undefined,
          }
        : undefined,
      last_result: storage.airi_last_combat_result,
    }
  }

  return { submit, submit_clear, tick, status }
}
