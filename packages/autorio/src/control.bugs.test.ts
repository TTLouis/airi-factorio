import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { event_handlers } from './test-event-registry'
import { task_manager } from './control'
import { TaskStates } from './types'

function get_handler(event_key: string) {
  const handler = event_handlers.get(event_key)
  if (!handler) throw new Error(`Missing handler: ${event_key}`)
  return handler
}

function stack(name?: string, count = 0) {
  return {
    valid_for_read: !!name,
    name,
    count,
  } as any
}

function inventory(slots: any[] = []) {
  const value: any = slots
  value.get_item_count = vi.fn((name: string) => slots.reduce((sum, item) => sum + (item.valid_for_read && item.name === name ? item.count : 0), 0))
  value.find_item_stack = vi.fn((name: string) => {
    const found = slots.find(item => item.valid_for_read && item.name === name)
    return found ? [found, 1] : [undefined, undefined]
  })
  value.insert = vi.fn(({ name, count }: { name: string, count: number }) => {
    const found = slots.find(item => item.valid_for_read && item.name === name)
    if (found) found.count += count
    else slots.push(stack(name, count))
    return count
  })
  value.remove = vi.fn(({ name, count }: { name: string, count: number }) => {
    const found = slots.find(item => item.valid_for_read && item.name === name)
    if (!found) return 0
    const removed = Math.min(found.count, count)
    found.count -= removed
    if (found.count === 0) found.valid_for_read = false
    return removed
  })
  return value
}

function entity(name: string, position = { x: 4, y: 0 }) {
  return {
    name,
    type: 'container',
    position,
    valid: true,
    health: 100,
    unit_number: 10,
    get_inventory: vi.fn(),
  } as any
}

function enemy(x = 5) {
  return {
    name: 'small-biter',
    type: 'unit',
    position: { x, y: 0 },
    valid: true,
    health: 15,
    unit_number: 77,
  } as any
}

function connect_player_seeing(entities: any[], can_shoot = true) {
  const main_inventory = inventory([])
  const guns = inventory([stack('pistol', 1)])
  const ammo = inventory([stack('firearm-magazine', 10)])
  const character: any = {
    valid: true,
    position: { x: 0, y: 0 },
    health: 250,
    max_health: 250,
    selected_gun_index: 1,
    can_shoot: vi.fn(() => can_shoot),
    get_inventory: vi.fn((kind: unknown) => {
      if (kind === (globalThis as any).defines.inventory.character_guns) return guns
      if (kind === (globalThis as any).defines.inventory.character_ammo) return ammo
      return undefined
    }),
  }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    daytime: 0.5,
    wind_speed: 0,
    wind_orientation: 0,
    find_entities_filtered: vi.fn(() => entities),
    request_to_generate_chunks: vi.fn(),
  }
  const force: any = {
    index: 1,
    name: 'player',
    technologies: {},
    recipes: {},
    current_research: undefined,
    research_progress: 0,
    chart: vi.fn(),
  }
  const fake_player: any = {
    valid: true,
    index: 1,
    name: 'Louis',
    character,
    surface,
    force,
    position: character.position,
    mining_state: { mining: false, position: { x: 0, y: 0 } },
    walking_state: { walking: false, direction: 'north' },
    shooting_state: { state: 'not_shooting', position: { x: 0, y: 0 } },
    crafting_queue: undefined,
    get_main_inventory: () => main_inventory,
    update_selected_entity: vi.fn(),
    get_craftable_count: vi.fn(() => 0),
    begin_crafting: vi.fn(() => 0),
    cancel_crafting: vi.fn(),
  }
  character.player = fake_player
  ;(globalThis as any).game.connected_players = [fake_player]
  ;(globalThis as any).game.players = { 1: fake_player, Louis: fake_player }
  ;(globalThis as any).game.surfaces = { 1: surface }
  return fake_player
}

function make_actor(main_inventory: any) {
  const actor: any = {
    is_valid: true,
    position: { x: 0, y: 0 },
    surface: {
      index: 1,
      find_entities_filtered: vi.fn(),
    },
    force: { index: 1 },
    get_main_inventory: () => main_inventory,
    status_snapshot: () => ({ kind: 'connected_player', actor_id: 1, valid: true, name: 'Louis', position: { x: 0, y: 0 }, has_character: true }),
    owns_player_index: (player_index: number) => player_index === 1,
  }
  return actor as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).game.players = {}
  task_manager.cancel_all_tasks()
})

describe('item movement accounting', () => {
  it('reports exactly what was moved when pulling items from a nearby entity', async () => {
    const source_inventory = inventory([stack('iron-plate', 10)])
    const actor_inventory = inventory([])
    const chest = entity('wooden-chest')
    chest.get_inventory = vi.fn(() => source_inventory)
    const actor = make_actor(actor_inventory) as any
    actor.surface.find_entities_filtered = vi.fn(() => [chest])

    const { new_basic_operation_controller } = await import('./basic_operations')
    const controller = new_basic_operation_controller(() => actor, task_manager)
    expect(controller.submit_move('iron-plate', 'wooden-chest', 6, false)[0]).toBe(true)
    const [source] = source_inventory.find_item_stack('iron-plate')
    actor_inventory.insert({ name: 'iron-plate', count: 6 })
    source.count -= 6
    controller.complete_move(actor, task_manager.player_state.parameters_moving_items!)

    expect(controller.status().last_result).toMatchObject({ completed: true, moved_count: 6 })
  })

  it('reports only what was actually inserted when the actor inventory can only take part of it', async () => {
    const source_inventory = inventory([stack('iron-plate', 10)])
    const actor_inventory = inventory([])
    actor_inventory.insert = vi.fn(() => 3)
    const chest = entity('wooden-chest')
    chest.get_inventory = vi.fn(() => source_inventory)
    const actor = make_actor(actor_inventory) as any
    actor.surface.find_entities_filtered = vi.fn(() => [chest])

    const { new_basic_operation_controller } = await import('./basic_operations')
    const controller = new_basic_operation_controller(() => actor, task_manager)
    expect(controller.submit_move('iron-plate', 'wooden-chest', 6, false)[0]).toBe(true)
    controller.complete_move(actor, task_manager.player_state.parameters_moving_items!)

    expect(controller.status().last_result).toMatchObject({ completed: true, moved_count: 3 })
  })
})

describe('player event ownership', () => {
  it('ignores a crafted-item event from a player_index that is not the controlled actor', () => {
    const handler = get_handler('on_player_crafted_item')
    connect_player_seeing([])
    expect(() => handler({ player_index: 2, item_stack: { name: 'iron-gear-wheel' } })).not.toThrow()
  })

  it('does not let a controlled-player craft event bypass native queue/output verification', () => {
    const handler = get_handler('on_player_crafted_item')
    connect_player_seeing([])
    expect(() => handler({ player_index: 1, item_stack: { name: 'iron-gear-wheel' } })).not.toThrow()
  })

  it('ignores a mined-entity event from another player', () => {
    const handler = get_handler('on_player_mined_entity')
    connect_player_seeing([])
    task_manager.add_task({ type: TaskStates.MINING, entity_name: 'iron-ore', count: 1, owner_actor_id: 1, owner_actor_kind: 'connected_player', owner_force_index: 1 })
    handler({ player_index: 2 })
    expect(task_manager.player_state.task_state).toBe(TaskStates.MINING)
  })

  it('counts a mined-entity event from the controlled player', () => {
    const handler = get_handler('on_player_mined_entity')
    connect_player_seeing([])
    task_manager.add_task({ type: TaskStates.MINING, entity_name: 'iron-ore', count: 1, owner_actor_id: 1, owner_actor_kind: 'connected_player', owner_force_index: 1 })
    handler({ player_index: 1 })
    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('does not let any LuaPlayer mining event advance an NPC task', () => {
    const handler = get_handler('on_player_mined_entity')
    const fake_player = connect_player_seeing([])
    task_manager.add_task({ type: TaskStates.MINING, entity_name: 'iron-ore', count: 1, owner_actor_id: 999, owner_actor_kind: 'standalone_character', owner_force_index: 1 })
    handler({ player_index: fake_player.index })
    expect(task_manager.player_state.task_state).toBe(TaskStates.MINING)
  })
})

describe('Bug 4 (fixed): ATTACKING is dispatched through the bounded combat controller', () => {
  function add_owned_attack(search_radius: number, target: any = null) {
    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius,
      target,
      owner_actor_id: 1,
      owner_actor_kind: 'connected_player',
      owner_force_index: 1,
    })
  }

  it('completes the attack task instead of hanging when no enemy is found', () => {
    const on_tick = get_handler('on_tick')
    connect_player_seeing([])
    add_owned_attack(50)
    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('shoots while kiting a mobile enemy that is already in range', () => {
    const on_tick = get_handler('on_tick')
    const target = enemy(5)
    const fake_player = connect_player_seeing([target], true)
    add_owned_attack(50)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(fake_player.character.can_shoot).toHaveBeenCalledWith(target, target.position)
    expect(fake_player.shooting_state).toEqual({ state: 'shooting_selected', position: target.position })
    expect(fake_player.walking_state).toEqual({ walking: true, direction: 'west' })
    expect(fake_player.update_selected_entity).toHaveBeenCalledWith(target.position)
  })

  it('walks toward a distant bound enemy without pretending to shoot it', () => {
    const on_tick = get_handler('on_tick')
    const target = enemy(100)
    const fake_player = connect_player_seeing([target], false)
    add_owned_attack(200)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.ATTACKING)
    expect(fake_player.character.can_shoot).toHaveBeenCalledWith(target, target.position)
    expect(fake_player.walking_state).toEqual({ walking: true, direction: 'east' })
    expect(fake_player.shooting_state).toEqual({ state: 'not_shooting', position: fake_player.position })
  })

  it('completes the single-target task once its bound target is no longer valid', () => {
    const on_tick = get_handler('on_tick')
    const replacement = enemy(6)
    replacement.unit_number = 99
    const fake_player = connect_player_seeing([replacement])
    const dead_target = { ...enemy(5), valid: false }
    add_owned_attack(50, dead_target)

    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(fake_player.surface.find_entities_filtered).not.toHaveBeenCalled()
  })
})
