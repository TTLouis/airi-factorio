import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import {
  execute_validated_construction_plan,
  validate_construction_execution_plan,
} from './construction_execution'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture(items: Record<string, number> = { 'stone-furnace': 2 }) {
  const surface: any = {
    index: 1,
    can_place_entity: vi.fn(() => true),
  }
  const inventory: any = {
    get_contents: vi.fn(() => Object.entries(items).map(([name, count]) => ({ name, quality: 'normal', count }))),
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1, name: 'player' },
    get_main_inventory: vi.fn(() => inventory),
    status_snapshot: vi.fn(() => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'AIRI',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
  const get_actor = () => actor
  const manager = new_task_manager(get_actor)
  const basic = new_basic_operation_controller(get_actor, manager)
  return { actor, surface, inventory, manager, basic }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.entity['stone-furnace'] = {
    collision_box: { left_top: { x: -0.7, y: -0.7 }, right_bottom: { x: 0.7, y: 0.7 } },
  }
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    collision_box: { left_top: { x: -1.4, y: -1.4 }, right_bottom: { x: 1.4, y: 1.4 } },
  }
})

describe('validated construction execution', () => {
  it('validates a bounded collision-free batch and queues exact placement tasks without another model turn', () => {
    const f = fixture()
    const validation: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'two-furnaces',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0, direction: 0 },
        { entity_name: 'stone-furnace', x: 2, y: 0, direction: 4 },
      ],
    })

    expect(validation).toMatchObject({
      ok: true,
      validation_id: 1,
      plan_id: 'two-furnaces',
      placement_count: 2,
      created_tick: 100,
    })
    expect(f.surface.can_place_entity).toHaveBeenCalledTimes(2)

    expect(execute_validated_construction_plan(
      f.actor,
      validation.validation_id,
      validation.placement_count,
      f.basic,
      f.manager,
    )).toEqual([true, 'Validated construction plan started'])

    expect(f.manager.player_state.task_state).toBe(TaskStates.PLACING)
    expect(f.manager.player_state.parameters_place_entity).toMatchObject({
      entity_name: 'stone-furnace',
      position: { x: -2, y: 0 },
      direction: 0,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.PLACING],
      active_batch: {
        task_count: 2,
        task_types: [TaskStates.PLACING, TaskStates.PLACING],
      },
    })
  })

  it('rejects collisions between planned placements even when the live world says each coordinate is individually placeable', () => {
    const f = fixture()
    const result: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'overlap',
      placements: [
        { entity_name: 'stone-furnace', x: 1, y: 1 },
        { entity_name: 'stone-furnace', x: 1.5, y: 1 },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PLANNED_COLLISION', indices: [0, 1] },
    })
    expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)
  })

  it('rejects missing inventory and live world collisions before creating a validation token', () => {
    const missing = fixture({ 'stone-furnace': 1 })
    const inventoryResult: any = validate_construction_execution_plan(missing.actor, {
      plan_id: 'missing-items',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0 },
        { entity_name: 'stone-furnace', x: 2, y: 0 },
      ],
    })
    expect(inventoryResult).toMatchObject({
      ok: false,
      error: { code: 'ITEMS_MISSING', item_name: 'stone-furnace', required_count: 2, available_count: 1 },
    })

    const blocked = fixture()
    blocked.surface.can_place_entity.mockReturnValueOnce(false)
    const worldResult: any = validate_construction_execution_plan(blocked.actor, {
      plan_id: 'blocked',
      placements: [{ entity_name: 'stone-furnace', x: 2, y: 0 }],
    })
    expect(worldResult).toMatchObject({
      ok: false,
      error: { code: 'WORLD_COLLISION', index: 0 },
    })
  })

  it('fails closed when a validation is expired, superseded, or has the wrong placement count', () => {
    const f = fixture()
    const first: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'first',
      placements: [{ entity_name: 'stone-furnace', x: -2, y: 0 }],
    })
    const second: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'second',
      placements: [{ entity_name: 'stone-furnace', x: 2, y: 0 }],
    })

    expect(execute_validated_construction_plan(f.actor, first.validation_id, 1, f.basic, f.manager)[0]).toBe(false)
    expect(execute_validated_construction_plan(f.actor, second.validation_id, 2, f.basic, f.manager)[0]).toBe(false)

    ;(globalThis as any).game.tick = second.created_tick + 3601
    expect(execute_validated_construction_plan(f.actor, second.validation_id, 1, f.basic, f.manager)).toEqual([
      false,
      'validated construction plan expired; validate the live world again',
    ])
    expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)
  })
})
