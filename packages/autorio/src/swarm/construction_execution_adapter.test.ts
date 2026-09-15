import type { ControlledActor } from '../actors/types'
import { new_basic_operation_controller } from '../basic_operations'
import { new_task_manager } from '../task_manager'
import { TaskStates } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_actor_scoped_construction_execution } from './construction_execution_adapter'

function fixture(actorId: number, x: number) {
  const surface: any = {
    index: 1,
    can_place_entity: vi.fn(() => true),
  }
  const inventory: any = {
    get_contents: vi.fn(() => [{ name: 'stone-furnace', quality: 'normal', count: 2 }]),
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x, y: 0 },
    surface,
    force: { index: 1, name: 'player' },
    get_main_inventory: vi.fn(() => inventory),
    status_snapshot: vi.fn(() => ({
      actor_id: actorId,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: `AIRI-${actorId}`,
      position: { x, y: 0 },
    })),
  } as unknown as ControlledActor
  const get_actor = () => actor
  const manager = new_task_manager(get_actor, { bindGlobalActorLifecycle: false })
  const basic = new_basic_operation_controller(get_actor, manager, { persistenceKey: `actor-${actorId}` })
  const construction = new_actor_scoped_construction_execution(`actor-${actorId}`, get_actor, basic, manager)
  return { actor, surface, manager, basic, construction }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.entity['stone-furnace'] = {
    collision_box: { left_top: { x: -0.7, y: -0.7 }, right_bottom: { x: 0.7, y: 0.7 } },
  }
})

describe('actor-scoped construction execution', () => {
  it('keeps validated construction slots independent for two logical actors and restores primary storage', () => {
    const primaryPlan = { validation_id: 77, plan_id: 'primary-plan' }
    ;(globalThis as any).storage.airi_validated_construction_plan = primaryPlan
    ;(globalThis as any).storage.airi_next_construction_validation_id = 77

    const first = fixture(101, 0)
    const second = fixture(202, 20)

    const firstValidation: any = first.construction.validate({
      plan_id: 'first-plan',
      placements: [{ entity_name: 'stone-furnace', x: 2, y: 0 }],
    })
    const secondValidation: any = second.construction.validate({
      plan_id: 'second-plan',
      placements: [{ entity_name: 'stone-furnace', x: 22, y: 0 }],
    })

    expect(firstValidation).toMatchObject({ ok: true, validation_id: 1, plan_id: 'first-plan' })
    expect(secondValidation).toMatchObject({ ok: true, validation_id: 1, plan_id: 'second-plan' })
    expect(first.construction.status()).toMatchObject({ validated: true, validation_id: 1, plan_id: 'first-plan' })
    expect(second.construction.status()).toMatchObject({ validated: true, validation_id: 1, plan_id: 'second-plan' })
    expect((globalThis as any).storage.airi_validated_construction_plan).toBe(primaryPlan)
    expect((globalThis as any).storage.airi_next_construction_validation_id).toBe(77)

    expect(first.construction.execute(firstValidation.validation_id, firstValidation.placement_count)).toEqual([
      true,
      'Validated construction plan started',
    ])
    expect(first.manager.player_state.task_state).toBe(TaskStates.PLACING)
    expect(second.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(first.construction.status().validated).toBe(false)
    expect(second.construction.status()).toMatchObject({ validated: true, plan_id: 'second-plan' })

    expect(second.construction.execute(secondValidation.validation_id, secondValidation.placement_count)).toEqual([
      true,
      'Validated construction plan started',
    ])
    expect(second.manager.player_state.task_state).toBe(TaskStates.PLACING)
    expect((globalThis as any).storage.airi_validated_construction_plan).toBe(primaryPlan)
    expect((globalThis as any).storage.airi_next_construction_validation_id).toBe(77)
  })

  it('supersedes validation only inside the same actor scope', () => {
    const first = fixture(301, 0)
    const second = fixture(302, 20)

    const firstOld: any = first.construction.validate({
      plan_id: 'first-old',
      placements: [{ entity_name: 'stone-furnace', x: 2, y: 0 }],
    })
    const secondOnly: any = second.construction.validate({
      plan_id: 'second-only',
      placements: [{ entity_name: 'stone-furnace', x: 22, y: 0 }],
    })
    const firstNew: any = first.construction.validate({
      plan_id: 'first-new',
      placements: [{ entity_name: 'stone-furnace', x: -2, y: 0 }],
    })

    expect(firstOld.validation_id).toBe(1)
    expect(firstNew.validation_id).toBe(2)
    expect(secondOnly.validation_id).toBe(1)
    expect(first.construction.execute(firstOld.validation_id, 1)[0]).toBe(false)
    expect(second.construction.status()).toMatchObject({ validated: true, validation_id: 1, plan_id: 'second-only' })
  })
})
