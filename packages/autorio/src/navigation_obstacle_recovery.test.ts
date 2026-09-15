import type { ControlledActor } from './actors/types'
import type { PlayerParametersWalkToEntity } from './types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { is_natural_navigation_obstacle, new_navigation_obstacle_recovery } from './navigation_obstacle_recovery'
import { TaskStates } from './types'

function fixture() {
  const position = { x: 0, y: 0 }
  const tree: any = { valid: true, type: 'tree', name: 'tree-01', position: { x: 1, y: 0 } }
  const surface: any = {
    find_entities_filtered: vi.fn(() => [tree]),
  }
  let miningState: any = { mining: false }
  const actor = {
    is_valid: true,
    character: { valid: true },
    position,
    surface,
    status_snapshot: () => ({ actor_id: 1, kind: 'standalone_character' }),
    set_walking_state: vi.fn(),
    update_selected_entity: vi.fn(),
    set_mining_state: vi.fn((state: any) => { miningState = state }),
    get_mining_state: vi.fn(() => miningState),
  } as unknown as ControlledActor
  const task = {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: 'steel-chest',
    search_radius: 40,
    path: [{ position: { x: 10, y: 0 }, needs_destroy_to_reach: false }],
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: 20, y: 0 },
    target_unit_number: 80,
    owner_actor_id: 1,
    owner_actor_kind: 'standalone_character',
    owner_force_index: 1,
    started_tick: 1,
  } as unknown as PlayerParametersWalkToEntity
  const recovery = new_navigation_obstacle_recovery()
  return { actor, task, tree, recovery }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
  ;(globalThis as any).log = vi.fn()
})

describe('natural navigation obstacle recovery', () => {
  it('only classifies natural trees and simple rock entities as auto-clearable', () => {
    expect(is_natural_navigation_obstacle({ type: 'tree', name: 'tree-01' } as any)).toBe(true)
    expect(is_natural_navigation_obstacle({ type: 'simple-entity', name: 'rock-big' } as any)).toBe(true)
    expect(is_natural_navigation_obstacle({ type: 'simple-entity', name: 'sand-rock-big' } as any)).toBe(true)
    expect(is_natural_navigation_obstacle({ type: 'simple-entity-with-owner', name: 'owned-rock' } as any)).toBe(false)
    expect(is_natural_navigation_obstacle({ type: 'transport-belt', name: 'transport-belt' } as any)).toBe(false)
    expect(is_natural_navigation_obstacle({ type: 'container', name: 'wooden-chest' } as any)).toBe(false)
  })

  it('defaults to clearing a nearby tree after bounded physical no-progress', () => {
    const f = fixture()
    expect(f.recovery.enabled()).toBe(true)
    f.recovery.tick(f.actor, f.task)
    for (const tick of [30, 60, 90]) {
      ;(globalThis as any).game.tick = tick
      f.recovery.tick(f.actor, f.task)
    }
    expect(f.actor.update_selected_entity).toHaveBeenCalledWith(f.tree.position)
    expect(f.actor.set_mining_state).toHaveBeenCalledWith({ mining: true, position: f.tree.position })
    expect(f.recovery.status()).toMatchObject({ clear_obstacles: true, clearing: true, obstacle: { name: 'tree-01' } })

    f.tree.valid = false
    ;(globalThis as any).game.tick = 91
    expect(f.recovery.tick(f.actor, f.task)).toBe(false)
    expect(f.actor.set_mining_state).toHaveBeenLastCalledWith({ mining: false })
    expect((f.task as any).last_recovery_reason).toBe('natural_obstacle_cleared')
  })

  it('does not clear trees or rocks when the request policy disables automatic clearing', () => {
    const f = fixture()
    f.recovery.set_enabled(false)
    for (const tick of [0, 30, 60, 90, 120]) {
      ;(globalThis as any).game.tick = tick
      f.recovery.tick(f.actor, f.task)
    }
    expect(f.actor.update_selected_entity).not.toHaveBeenCalled()
    expect(f.recovery.status()).toMatchObject({ clear_obstacles: false, clearing: false })
  })
})
