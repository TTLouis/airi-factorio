import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
})

function itemStack(name?: string, count = 0) {
  return { valid_for_read: !!name, name, count }
}

function inventory(items: any[] = []) {
  const value: any = items
  value.find_item_stack = vi.fn((name: string) => {
    const index = items.findIndex(item => item.valid_for_read && item.name === name)
    return index >= 0 ? [items[index], index + 1] : [undefined, undefined]
  })
  value.remove = vi.fn(({ name, count }: { name: string, count: number }) => {
    const item = items.find(candidate => candidate.valid_for_read && candidate.name === name)
    if (!item) return 0
    const removed = Math.min(item.count, count)
    item.count -= removed
    if (item.count <= 0) item.valid_for_read = false
    return removed
  })
  value.insert = vi.fn(({ count }: { count: number }) => count)
  return value
}

function world() {
  const target: any = {
    valid: true,
    name: 'small-biter',
    type: 'unit',
    unit_number: 88,
    position: { x: 20, y: 0 },
    health: 15,
  }
  const enemies: any[] = [target]
  const gun = { valid_for_read: true }
  const ammo = { valid_for_read: true }
  const guns: any = [gun]
  const magazines: any = [ammo]
  const main = inventory([])
  const character: any = {
    health: 250,
    max_health: 250,
    selected_gun_index: 1,
    can_shoot: vi.fn(() => false),
    get_inventory: vi.fn((index: unknown) => {
      if (index === (globalThis as any).defines.inventory.character_guns) return guns
      if (index === (globalThis as any).defines.inventory.character_ammo) return magazines
      return undefined
    }),
  }
  const surface: any = {
    find_entities_filtered: vi.fn(() => enemies.filter(entity => entity.valid !== false && (entity.health === undefined || entity.health > 0))),
    find_non_colliding_position: vi.fn(() => ({ x: 0, y: 0 })),
    create_entity: vi.fn(),
  }
  const identity = { kind: 'standalone_character', actor_id: 42 }
  const actor: any = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    status_snapshot: () => identity,
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    update_selected_entity: vi.fn(),
    get_main_inventory: () => main,
    entity_build_args: () => ({ force: actor.force }),
  }
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_combat_controller(get_actor, manager)
  return { actor, target, enemies, character, gun, ammo, guns, magazines, main, surface, identity, get_actor, manager, controller }
}

describe('bounded combat controller', () => {
  it('queues combat without selecting or damaging a target at admission', () => {
    const { surface, manager, controller } = world()
    expect(controller.submit(40)).toEqual([true, 'Combat task queued'])
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
    expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)
  })

  it('rejects malformed radius and missing actor without queueing work', () => {
    const { get_actor, manager, controller } = world()
    expect(controller.submit(0)).toEqual([false, 'invalid_radius'])
    expect(controller.submit(257)).toEqual([false, 'invalid_radius'])
    get_actor.mockReturnValue(undefined)
    expect(controller.submit(40)).toEqual([false, 'no_actor'])
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('fails a no-target one-shot task and cancels dependent work', () => {
    const { actor, enemies, manager, controller } = world()
    enemies.length = 0
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_target', accepted: false } })
  })

  it('converts the 1-based Factorio selected gun slot to the 0-based typed-factorio inventory view', () => {
    const { actor, manager, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    expect(manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(controller.status()).toMatchObject({ last_result: { code: 'started', accepted: true } })
  })

  it('kites a mobile enemy while shooting instead of stopping in melee range', () => {
    const { actor, target, character, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'not_shooting' }))

    actor.position = { x: 15, y: 0 }
    character.can_shoot.mockReturnValue(true)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(actor.update_selected_entity).toHaveBeenCalledWith(target.position)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith({ state: 'shooting_selected', position: target.position })
  })

  it('does not advance onto a nest once the selected weapon can fire at it', () => {
    const { actor, target, character, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    character.can_shoot.mockReturnValue(true)
    controller.submit(40)
    controller.tick(actor)
    expect(actor.set_walking_state).toHaveBeenLastCalledWith({ walking: false, direction: 'north' })
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith({ state: 'shooting_selected', position: target.position })
  })

  it('completes a one-shot task only after the acquired target is gone instead of retargeting forever', () => {
    const { actor, target, surface, manager, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    target.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    expect(controller.status()).toMatchObject({ last_result: { code: 'target_destroyed', completed: true } })
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('fails safely when weapon/ammo disappears and stops queued dependent work', () => {
    const { actor, ammo, manager, controller } = world()
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    ammo.valid_for_read = false
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_weapon_or_ammo' } })
    expect(manager.get_status_snapshot().queue_length).toBe(0)
    expect(actor.set_walking_state).toHaveBeenCalledWith({ walking: false, direction: 'north' })
    expect(actor.set_shooting_state).toHaveBeenCalledWith({ state: 'not_shooting', position: actor.position })
  })

  it('fails if Factorio selects another slot that has no gun or matching ammo stack', () => {
    const { actor, character, manager, controller } = world()
    character.selected_gun_index = 2
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_weapon_or_ammo' } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
  })

  it.each(['actor', 'kind', 'force'] as const)('does not let a changed %s inherit combat', (change) => {
    const { actor, identity, controller } = world()
    controller.submit(40)
    if (change === 'actor') identity.actor_id = 99
    if (change === 'kind') identity.kind = 'connected_player'
    if (change === 'force') actor.force.index = 2
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'actor_changed', accepted: false } })
  })

  it('fails a chase that makes no positional progress for ten simulation seconds', () => {
    const { actor, controller } = world()
    controller.submit(40)
    controller.tick(actor)
    ;(globalThis as any).game.tick += 601
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'stuck' } })
  })

  it('bounds a one-shot combat task to one simulation minute', () => {
    const { actor, character, controller } = world()
    character.can_shoot.mockReturnValue(true)
    controller.submit(40)
    controller.tick(actor)
    ;(globalThis as any).game.tick += 3601
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'timeout' } })
  })
})

describe('bounded area-clearing combat', () => {
  it('reacquires enemies until the bounded area is actually clear', () => {
    const { actor, target, enemies, manager, controller } = world()
    const second: any = {
      valid: true,
      name: 'biter-spawner',
      type: 'unit-spawner',
      unit_number: 99,
      position: { x: 30, y: 0 },
      health: 350,
    }
    enemies.push(second)

    expect(controller.submit_clear(80)).toEqual([true, 'Area-clear combat task queued'])
    controller.tick(actor)
    target.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ mode: 'clear_area', targets_destroyed: 1, target: { name: 'biter-spawner' } })

    second.valid = false
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'area_cleared', completed: true, targets_destroyed: 2 } })
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('preempts a locked nest when a nearby mobile threat appears', () => {
    const { actor, target, enemies, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    target.unit_number = 90
    target.position = { x: 30, y: 0 }

    controller.submit_clear(80)
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ target: { name: 'biter-spawner', unit_number: 90 } })

    const spawned: any = {
      valid: true,
      name: 'small-biter',
      type: 'unit',
      unit_number: 91,
      position: { x: 8, y: 0 },
      health: 15,
    }
    enemies.push(spawned)
    ;(globalThis as any).game.tick += 1
    controller.tick(actor)

    expect(controller.status()).toMatchObject({ target: { name: 'small-biter', unit_number: 91 } })
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
  })

  it('places and loads a paid gun turret before advancing when support equipment is available', () => {
    const { actor, target, character, main, surface, controller } = world()
    target.type = 'unit-spawner'
    target.name = 'biter-spawner'
    main.push(itemStack('gun-turret', 2), itemStack('piercing-rounds-magazine', 50))
    const turretAmmo = inventory([])
    const turret: any = {
      valid: true,
      unit_number: 501,
      get_inventory: vi.fn(() => turretAmmo),
      destroy: vi.fn(),
    }
    surface.create_entity.mockReturnValue(turret)
    character.can_shoot.mockReturnValue(false)

    controller.submit_clear(80)
    controller.tick(actor)

    expect(surface.create_entity).toHaveBeenCalledWith(expect.objectContaining({ name: 'gun-turret' }))
    expect(turret.get_inventory).toHaveBeenCalledWith('turret_ammo')
    expect(main.remove).toHaveBeenCalledWith({ name: 'gun-turret', count: 1 })
    expect(main.remove).toHaveBeenCalledWith({ name: 'piercing-rounds-magazine', count: 20 })
    expect(turretAmmo.insert).toHaveBeenCalledWith({ name: 'piercing-rounds-magazine', count: 20 })
    expect(controller.status()).toMatchObject({
      mode: 'clear_area',
      turrets_placed: 1,
      last_turret_unit_number: 501,
      turret_ammo_name: 'piercing-rounds-magazine',
      last_turret_ammo_loaded: 20,
    })
  })

  it('destroys an unpayable scripted turret instead of granting a free support entity', () => {
    const { actor, target, character, main, surface, controller } = world()
    target.type = 'unit-spawner'
    main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 20))
    const turret: any = {
      valid: true,
      unit_number: 502,
      get_inventory: vi.fn(() => inventory([])),
      destroy: vi.fn(),
    }
    surface.create_entity.mockReturnValue(turret)
    character.can_shoot.mockReturnValue(false)
    main.remove.mockImplementation(({ name, count }: { name: string, count: number }) => name === 'gun-turret' ? 0 : count)

    controller.submit_clear(80)
    controller.tick(actor)

    expect(turret.destroy).toHaveBeenCalledTimes(1)
    expect(controller.status()).toMatchObject({ turrets_placed: 0 })
    expect(controller.status().last_turret_unit_number).toBeUndefined()
  })

  it('returns the paid turret item when ammunition cannot be removed', () => {
    const { actor, target, character, main, surface, controller } = world()
    target.type = 'unit-spawner'
    main.push(itemStack('gun-turret', 1), itemStack('firearm-magazine', 20))
    const turret: any = {
      valid: true,
      unit_number: 503,
      get_inventory: vi.fn(() => inventory([])),
      destroy: vi.fn(),
    }
    surface.create_entity.mockReturnValue(turret)
    character.can_shoot.mockReturnValue(false)
    const realRemove = main.remove.getMockImplementation()!
    main.remove.mockImplementation((args: { name: string, count: number }) => args.name === 'firearm-magazine' ? 0 : realRemove(args))

    controller.submit_clear(80)
    controller.tick(actor)

    expect(main.insert).toHaveBeenCalledWith({ name: 'gun-turret', count: 1 })
    expect(turret.destroy).toHaveBeenCalledTimes(1)
    expect(controller.status()).toMatchObject({ turrets_placed: 0 })
  })

  it('returns ammunition the turret could not accept and records only the amount actually loaded', () => {
    const { actor, target, character, main, surface, controller } = world()
    target.type = 'unit-spawner'
    main.push(itemStack('gun-turret', 1), itemStack('piercing-rounds-magazine', 20))
    const turretAmmo = inventory([])
    turretAmmo.insert.mockReturnValue(5)
    const turret: any = {
      valid: true,
      unit_number: 504,
      get_inventory: vi.fn(() => turretAmmo),
      destroy: vi.fn(),
    }
    surface.create_entity.mockReturnValue(turret)
    character.can_shoot.mockReturnValue(false)

    controller.submit_clear(80)
    controller.tick(actor)

    expect(main.insert).toHaveBeenCalledWith({ name: 'piercing-rounds-magazine', count: 15 })
    expect(turret.destroy).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({
      turrets_placed: 1,
      last_turret_unit_number: 504,
      turret_ammo_name: 'piercing-rounds-magazine',
      last_turret_ammo_loaded: 5,
    })
  })

  it('retreats toward the latest support turret while firing at a close mobile threat', () => {
    const { actor, character, manager, controller } = world()
    controller.submit_clear(80)
    const task = manager.player_state.parameters_attack_nearest_enemy!
    task.last_turret_position = { x: -10, y: 0 }
    task.turrets_placed = 1
    character.can_shoot.mockReturnValue(true)
    actor.position = { x: 15, y: 0 }

    controller.tick(actor)
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'shooting_selected' }))
    expect(actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
  })

  it('aborts instead of making a suicidal unsupported push at low health', () => {
    const { actor, character, manager, controller } = world()
    character.health = 50
    character.max_health = 250
    controller.submit_clear(80)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'low_health', accepted: false } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
  })
})