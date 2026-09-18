import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { new_area_clearing_controller } from './area_clearing'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function entity(name: string, type: string, x: number, options: { building?: boolean, mineable?: boolean } = {}) {
  return {
    valid: true,
    name,
    type,
    position: { x, y: 0 },
    prototype: {
      name,
      type,
      is_building: options.building ?? false,
      mineable_properties: options.mineable === false ? undefined : { mining_time: 0.5, products: [] },
    },
  } as any
}

function fixture() {
  let mining = false
  const treeA = entity('mod-tree-a', 'tree', 1)
  const treeB = entity('mod-tree-b', 'tree', 2)
  const rock = entity('mod-rock-z', 'simple-entity', 3)
  const resource = entity('iron-resource-x', 'resource', 1.5)
  const machine = entity('existing-machine-x', 'assembling-machine', 2.5, { building: true })
  const treeOutside = entity('mod-tree-outside', 'tree', 8)
  const entities = [treeA, treeB, rock, resource, machine, treeOutside]

  const surface: any = {
    index: 1,
    find_entities_filtered: vi.fn((query: any) => {
      const leftTop = query.area?.left_top
      const rightBottom = query.area?.right_bottom
      return entities
        .filter(item => item.valid)
        .filter(item => !leftTop || !rightBottom
          || (item.position.x >= leftTop.x
            && item.position.x <= rightBottom.x
            && item.position.y >= leftTop.y
            && item.position.y <= rightBottom.y))
    }),
  }
  const actor = {
    is_valid: true,
    character: { valid: true, reach_distance: 10 },
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    update_selected_entity: vi.fn(),
    get_mining_state: vi.fn(() => ({ mining })),
    set_mining_state: vi.fn((state: { mining: boolean }) => { mining = state.mining }),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    owns_player_index: () => true,
    status_snapshot: () => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'AIRI',
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const manager = new_task_manager(() => actor)
  const controller = new_area_clearing_controller(() => actor, manager)
  return { actor, manager, controller, treeA, treeB, rock, resource, machine, treeOutside }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
})

describe('construction-area finite blocker clearing', () => {
  it('clears heterogeneous mineable non-resource blockers until a live rescan verifies the area is clear', () => {
    const f = fixture()
    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)
    f.manager.add_task({
      type: TaskStates.PLACING,
      entity_name: 'future-machine-x',
      position: { x: 2, y: 0 },
    })

    f.controller.tick(f.actor)
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.treeA.position })

    f.treeA.valid = false
    f.controller.on_player_mined_entity(f.actor, 1)
    f.controller.tick(f.actor)
    expect(f.manager.player_state.parameters_clear_construction_area?.target_name).toBe('mod-tree-b')

    f.treeB.valid = false
    f.controller.on_player_mined_entity(f.actor, 1)
    f.controller.tick(f.actor)
    expect(f.manager.player_state.parameters_clear_construction_area?.target_name).toBe('mod-rock-z')

    f.rock.valid = false
    f.controller.on_player_mined_entity(f.actor, 1)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.PLACING)
    expect(f.manager.player_state.parameters_place_entity).toMatchObject({
      entity_name: 'future-machine-x',
      position: { x: 2, y: 0 },
    })
    expect(f.resource.valid).toBe(true)
    expect(f.machine.valid).toBe(true)
    expect(f.treeOutside.valid).toBe(true)
  })

  it('does not treat normal resource patches or placed buildings as finite natural clear targets', () => {
    const f = fixture()
    f.treeA.valid = false
    f.treeB.valid = false
    f.rock.valid = false

    expect(f.controller.submit(2, 0, 8, 4)[0]).toBe(true)
    f.controller.tick(f.actor)

    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(f.resource.valid).toBe(true)
    expect(f.machine.valid).toBe(true)
    expect(f.treeOutside.valid).toBe(true)
  })
})
