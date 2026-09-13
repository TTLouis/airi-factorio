import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { state_moving_items, task_manager } from './control'
import { get_handler } from './test-event-registry'
import { TaskStates } from './types'

beforeEach(() => {
  task_manager.cancel_all_tasks()
  ;(globalThis as any).game.connected_players = []
})

describe('Bug 3: state_moving_items double-counts moved_total on pickup', () => {
  it('reports twice the actually-moved amount when pulling items from a nearby entity', () => {
    const removed_from_entity = vi.fn(() => 5)
    const inserted_into_player = vi.fn(() => 5) // full insert: inserted === removed

    const fake_inventory = {
      remove: removed_from_entity,
      insert: vi.fn(),
    }
    const fake_entity = {
      get_max_inventory_index: () => 1,
      get_inventory: (_index: number) => fake_inventory,
    }
    const fake_player_inventory = {
      can_insert: () => true,
      insert: inserted_into_player,
    }
    const fake_actor = {
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => [fake_entity] },
      force: {},
      get_main_inventory: () => fake_player_inventory,
    } as unknown as ControlledActor

    task_manager.add_task({
      type: TaskStates.MOVING_ITEMS,
      item_name: 'iron-plate',
      entity_name: 'iron-chest',
      max_count: 5,
      to_entity: false,
    })

    const moved_total = state_moving_items(fake_actor)

    // Only 5 items actually moved (one remove + one matching insert)...
    expect(removed_from_entity).toHaveBeenCalledTimes(1)
    expect(inserted_into_player).toHaveBeenCalledTimes(1)
    // ...but state_moving_items reports 10: `moved_total += removed` runs both
    // inside the `inserted < removed ? ... : moved_total += removed` branch and
    // again unconditionally right after it (control.ts, state_moving_items).
    expect(moved_total).toBe(10)
  })
})

describe('Bug 1 (fixed): craft completion is gated by actor identity', () => {
  function connect_controlled_actor(index: number) {
    (globalThis as any).game.connected_players = [
      { index, name: 'AIRI', character: {}, begin_crafting: () => {} },
    ]
  }

  it('ignores a crafted-item event from a player_index that is not the controlled actor', () => {
    connect_controlled_actor(1)

    task_manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 5,
      crafted: 0,
    })

    const on_player_crafted_item = get_handler('on_player_crafted_item')
    on_player_crafted_item({ player_index: 2, item_stack: { name: 'iron-gear-wheel', count: 1 } })

    expect(task_manager.player_state.parameters_craft_item?.crafted).toBe(0)
  })

  it('counts a crafted-item event from the controlled actor\'s own player_index', () => {
    connect_controlled_actor(1)

    task_manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 5,
      crafted: 0,
    })

    const on_player_crafted_item = get_handler('on_player_crafted_item')
    on_player_crafted_item({ player_index: 1, item_stack: { name: 'iron-gear-wheel', count: 1 } })

    expect(task_manager.player_state.parameters_craft_item?.crafted).toBe(1)
  })
})

describe('Bug 4: ATTACKING has no on_tick dispatch case', () => {
  it('leaves a queued attack task stuck forever instead of running or erroring', () => {
    const on_tick = get_handler('on_tick')

    ;(globalThis as any).game.connected_players = [{ character: {} }]

    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius: 50,
      target: null,
    })
    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    on_tick({})
    on_tick({})

    // No dispatch branch handles ATTACKING, so on_tick is a no-op for it every
    // tick: the task never completes and never falls back to IDLE.
    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
  })
})
