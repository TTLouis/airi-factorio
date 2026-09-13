import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { state_moving_items, task_manager } from './control'
import { get_handler } from './test-event-registry'
import { TaskStates } from './types'

beforeEach(() => {
  task_manager.cancel_all_tasks()
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).storage.airi_actor_mode = 'player'
})

describe('Bug 3 (fixed): state_moving_items reports the actually-moved amount on pickup', () => {
  it('reports exactly what was moved when pulling items from a nearby entity', () => {
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

    expect(removed_from_entity).toHaveBeenCalledTimes(1)
    expect(inserted_into_player).toHaveBeenCalledTimes(1)
    // Previously reported 10 (double-counted); state_moving_items no longer
    // adds `removed` a second time unconditionally after the if/else.
    expect(moved_total).toBe(5)
  })

  it('reports only what was actually inserted when the actor inventory can only take part of it', () => {
    const fake_inventory = {
      remove: vi.fn(() => 5),
      insert: vi.fn(),
    }
    const fake_entity = {
      get_max_inventory_index: () => 1,
      get_inventory: (_index: number) => fake_inventory,
    }
    const fake_actor_inventory = {
      can_insert: () => true,
      insert: vi.fn(() => 3), // only 3 of the 5 removed items actually fit
    }
    const fake_actor = {
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => [fake_entity] },
      force: {},
      get_main_inventory: () => fake_actor_inventory,
    } as unknown as ControlledActor

    task_manager.add_task({
      type: TaskStates.MOVING_ITEMS,
      item_name: 'iron-plate',
      entity_name: 'iron-chest',
      max_count: 5,
      to_entity: false,
    })

    const moved_total = state_moving_items(fake_actor)

    // The 2 that didn't fit are moved back into the entity's inventory...
    expect(fake_inventory.insert).toHaveBeenCalledWith({ name: 'iron-plate', count: 2 })
    // ...and moved_total reflects only the 3 that actually ended up with the actor.
    expect(moved_total).toBe(3)
  })
})

describe('Player-sourced completion events are gated by actor identity', () => {
  function connect_controlled_actor(index: number) {
    ;(globalThis as any).game.connected_players = [
      {
        valid: true,
        index,
        name: 'AIRI',
        character: {},
        begin_crafting: () => {},
      },
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

  it('ignores a mined-entity event from another player', () => {
    connect_controlled_actor(1)

    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name: 'iron-ore',
      count: 3,
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 2 })

    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(3)
  })

  it('counts a mined-entity event from the controlled player', () => {
    connect_controlled_actor(1)

    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name: 'iron-ore',
      count: 3,
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 1 })

    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(2)
  })

  it('does not let any LuaPlayer mining event advance an NPC task', () => {
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    const force = {
      name: 'player',
      get_spawn_position: () => ({ x: 0, y: 0 }),
    }
    const character: Record<string, any> = {
      valid: true,
      unit_number: 42,
      position: { x: 0, y: 0 },
      force,
      mining_state: { mining: false },
      get_main_inventory: vi.fn(),
      begin_crafting: vi.fn(),
    }
    const surface = {
      name: 'nauvis',
      find_entities_filtered: vi.fn(() => []),
      find_non_colliding_position: vi.fn(() => ({ x: 0, y: 0 })),
      create_entity: vi.fn(() => character),
    }
    character.surface = surface
    ;(globalThis as any).game.surfaces[1] = surface
    ;(globalThis as any).game.forces = { player: force }

    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name: 'iron-ore',
      count: 3,
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 1 })

    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(3)
  })
})

describe('Bug 4 (fixed): ATTACKING now has an on_tick dispatch case', () => {
  function connect_player_seeing(entities: unknown[]) {
    const fake_player = {
      valid: true,
      index: 1,
      name: 'AIRI',
      character: {},
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => entities },
      force: {},
    }
    ;(globalThis as any).game.connected_players = [fake_player]
    return fake_player as any
  }

  it('completes the attack task instead of hanging when no enemy is found', () => {
    const on_tick = get_handler('on_tick')
    connect_player_seeing([])

    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius: 50,
      target: null,
    })
    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('shoots an enemy that is already within engage range', () => {
    const on_tick = get_handler('on_tick')
    const fake_player = connect_player_seeing([{ valid: true, position: { x: 5, y: 0 } }])

    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius: 50,
      target: null,
    })

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(fake_player.shooting_state).toEqual({ state: 'shooting_enemies', position: { x: 5, y: 0 } })
    expect(fake_player.walking_state).toBeUndefined()
  })

  it('walks toward a distant enemy instead of shooting when out of engage range', () => {
    const on_tick = get_handler('on_tick')
    const fake_player = connect_player_seeing([{ valid: true, position: { x: 100, y: 0 } }])

    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius: 200,
      target: null,
    })

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(fake_player.walking_state).toBeDefined()
    expect(fake_player.shooting_state).toBeUndefined()
  })

  it('re-acquires a new target once the current one is no longer valid', () => {
    const on_tick = get_handler('on_tick')
    connect_player_seeing([])

    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius: 50,
      // Already has a target locked from a previous tick, but it died —
      // state_attacking must re-search rather than keep aiming at it.
      target: { valid: false, position: { x: 5, y: 0 } } as any,
    })

    on_tick({})

    // No replacement enemy found either, so the task completes.
    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })
})
