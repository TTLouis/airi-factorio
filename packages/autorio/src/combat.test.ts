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

function world() {
  const target: any = {
    valid: true,
    name: 'small-biter',
    unit_number: 88,
    position: { x: 20, y: 0 },
    health: 15,
  }
  const gun = { valid_for_read: true }
  const ammo = { valid_for_read: true }
  const guns: any = { 1: gun }
  const magazines: any = { 1: ammo }
  const character: any = {
    selected_gun_index: 1,
    can_shoot: vi.fn(() => false),
    get_inventory: vi.fn((index: unknown) => {
      if (index === (globalThis as any).defines.inventory.character_guns) return guns
      if (index === (globalThis as any).defines.inventory.character_ammo) return magazines
      return undefined
    }),
  }
  const surface: any = {
    find_entities_filtered: vi.fn(() => [target]),
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
  }
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_combat_controller(get_actor, manager)
  return { actor, target, character, gun, ammo, surface, identity, get_actor, manager, controller }
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

  it('fails a no-target task and cancels dependent work', () => {
    const { actor, surface, manager, controller } = world()
    surface.find_entities_filtered.mockReturnValue([])
    controller.submit(40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.tick(actor)
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
    expect(controller.status()).toMatchObject({ last_result: { code: 'no_target', accepted: false } })
  })

  it('walks while out of range, then stops walking and shoots the selected target', () => {
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
    expect(actor.set_walking_state).toHaveBeenLastCalledWith({ walking: false, direction: 'north' })
    expect(actor.set_shooting_state).toHaveBeenLastCalledWith({ state: 'shooting_selected', position: target.position })
  })

  it('completes only after the acquired target is gone instead of retargeting forever', () => {
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

  it('bounds the entire combat task to one simulation minute', () => {
    const { actor, character, controller } = world()
    character.can_shoot.mockReturnValue(true)
    controller.submit(40)
    controller.tick(actor)
    ;(globalThis as any).game.tick += 3601
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_result: { code: 'timeout' } })
  })
})
