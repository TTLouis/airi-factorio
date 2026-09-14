import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get_load_handler } from '../test-event-registry'
import {
  get_actor_mode,
  get_controlled_actor,
  get_load_reconciliation_status,
  get_npc_recovery_status,
  register_npc_recovery_handler,
  set_actor_mode,
} from './actor_controller'

function fake_character(unit_number: number, valid = true) {
  return {
    valid,
    unit_number,
    position: { x: 4, y: 5 },
    surface: undefined as any,
    force: undefined as any,
    mining_state: { mining: false },
    walking_state: { walking: false, direction: 'north' },
    shooting_state: { state: 'not_shooting', position: { x: 4, y: 5 } },
    get_main_inventory: vi.fn(),
    begin_crafting: vi.fn(),
  }
}

function make_world() {
  const force = {
    name: 'player',
    index: 1,
    get_spawn_position: vi.fn(() => ({ x: 0, y: 0 })),
  }
  const surface = {
    name: 'nauvis',
    find_entities_filtered: vi.fn(() => [] as any[]),
    find_non_colliding_position: vi.fn(() => ({ x: 1, y: 2 })),
    create_entity: vi.fn(),
  }
  return { force, surface }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  const { force, surface } = make_world()
  ;(globalThis as any).game = {
    connected_players: [],
    surfaces: { 1: surface },
    forces: { player: force },
    print: vi.fn(),
    tick: 123,
  }
  ;(globalThis as any).rendering = { clear: vi.fn() }
  register_npc_recovery_handler(undefined)
  set_actor_mode('player')
})

describe('actor mode', () => {
  it('defaults to the legacy connected-player mode', () => {
    ;(globalThis as any).storage = {}
    expect(get_actor_mode()).toBe('player')
  })

  it('resolves the first connected player in player mode', () => {
    const player = {
      valid: true,
      index: 1,
      name: 'Louis',
      position: { x: 0, y: 0 },
      surface: { name: 'nauvis' },
      force: { name: 'player' },
      character: { valid: true },
      get_main_inventory: vi.fn(),
      update_selected_entity: vi.fn(),
      begin_crafting: vi.fn(),
    }
    ;(globalThis as any).game.connected_players = [player]

    const actor = get_controlled_actor()

    expect(actor?.status_snapshot().kind).toBe('connected_player')
    expect(actor?.status_snapshot().name).toBe('Louis')
  })

  it('creates a standalone character in npc mode and persists its identity', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    surface.create_entity.mockReturnValue(character)

    set_actor_mode('npc')
    const actor = get_controlled_actor()

    expect(surface.create_entity).toHaveBeenCalledWith({
      name: 'character',
      position: { x: 1, y: 2 },
      force,
    })
    expect(actor?.status_snapshot().kind).toBe('standalone_character')
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(42)
    expect(get_npc_recovery_status().last_result).toBeUndefined()
  })

  it('reacquires a persisted standalone character instead of creating a duplicate', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.standalone_character_unit_number = 42

    set_actor_mode('npc')
    const actor = get_controlled_actor()

    expect(actor?.character).toBe(character)
    expect(surface.create_entity).not.toHaveBeenCalled()
    expect(get_npc_recovery_status().last_result).toBeUndefined()
  })

  it('invalidates stale work before replacing a missing standalone character', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const first = fake_character(42)
    const replacement = fake_character(99)
    first.surface = surface
    first.force = force
    replacement.surface = surface
    replacement.force = force
    surface.create_entity.mockReturnValueOnce(first)
    const recovery_handler = vi.fn()
    register_npc_recovery_handler(recovery_handler)

    set_actor_mode('npc')
    const actor = get_controlled_actor()
    expect(actor?.character).toBe(first)

    first.valid = false
    surface.find_entities_filtered.mockReturnValue([])
    surface.create_entity.mockImplementationOnce(() => {
      expect(recovery_handler).toHaveBeenCalledWith({ previous_actor_id: 42 })
      return replacement
    })
    const recovered = get_controlled_actor()

    expect(recovered?.character).toBe(replacement)
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(99)
    expect(recovery_handler).toHaveBeenCalledTimes(1)
    expect((globalThis as any).rendering.clear).toHaveBeenCalledTimes(1)
    expect(get_npc_recovery_status()).toEqual({
      policy: 'discard_autorio_tasks_and_create_empty_replacement',
      pending_from_actor_id: undefined,
      last_result: {
        reason: 'missing_persisted_actor',
        previous_actor_id: 42,
        replacement_actor_id: 99,
        force_index: 1,
        tick: 123,
        inventory_policy: 'no_transfer',
      },
    })
  })

  it('does not repeatedly invalidate work when replacement creation temporarily fails', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const first = fake_character(42)
    first.surface = surface
    first.force = force
    surface.create_entity.mockReturnValueOnce(first)
    const recovery_handler = vi.fn()
    register_npc_recovery_handler(recovery_handler)

    set_actor_mode('npc')
    get_controlled_actor()
    first.valid = false
    surface.find_entities_filtered.mockReturnValue([])
    surface.create_entity.mockReturnValue(undefined)

    expect(get_controlled_actor()).toBeUndefined()
    expect(get_controlled_actor()).toBeUndefined()
    expect(recovery_handler).toHaveBeenCalledTimes(1)
    expect(get_npc_recovery_status().pending_from_actor_id).toBe(42)
  })

  it('reacquires the same saved npc and clears stale physical inputs after on_load', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    character.walking_state = { walking: true, direction: 'east' }
    character.mining_state = { mining: true, position: { x: 5, y: 5 } } as any
    character.shooting_state = { state: 'shooting_selected', position: { x: 6, y: 5 } }
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    ;(globalThis as any).storage.standalone_character_unit_number = 42

    get_load_handler()()
    expect(get_load_reconciliation_status().pending).toBe(true)

    const actor = get_controlled_actor()

    expect(actor?.character).toBe(character)
    expect(surface.create_entity).not.toHaveBeenCalled()
    expect(character.walking_state).toEqual({ walking: false, direction: 'north' })
    expect(character.mining_state).toEqual({ mining: false })
    expect(character.shooting_state).toEqual({ state: 'not_shooting', position: character.position })
    expect((globalThis as any).rendering.clear).toHaveBeenCalledTimes(1)
    expect(get_load_reconciliation_status()).toEqual({
      policy: 'discard_autorio_tasks_and_stop_npc_controls_on_load',
      pending: false,
      last_actor_id: 42,
      last_tick: 123,
    })
  })

  it('does not clear a connected player control state merely because a save loaded', () => {
    const player = {
      valid: true,
      index: 1,
      name: 'Louis',
      position: { x: 0, y: 0 },
      surface: { name: 'nauvis' },
      force: { name: 'player' },
      character: { valid: true },
      walking_state: { walking: true, direction: 'east' },
      mining_state: { mining: false },
      shooting_state: { state: 'not_shooting' },
      get_main_inventory: vi.fn(),
      update_selected_entity: vi.fn(),
      begin_crafting: vi.fn(),
    }
    ;(globalThis as any).game.connected_players = [player]
    ;(globalThis as any).storage.airi_actor_mode = 'player'

    get_load_handler()()
    const actor = get_controlled_actor()

    expect(actor?.status_snapshot().kind).toBe('connected_player')
    expect(player.walking_state).toEqual({ walking: true, direction: 'east' })
    expect((globalThis as any).rendering.clear).not.toHaveBeenCalled()
    expect(get_load_reconciliation_status().pending).toBe(true)
  })
})
