import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get_actor_mode, get_controlled_actor, set_actor_mode } from './actor_controller'

function fake_character(unit_number: number, valid = true) {
  return {
    valid,
    unit_number,
    position: { x: 4, y: 5 },
    surface: undefined as any,
    force: undefined as any,
    mining_state: { mining: false },
    get_main_inventory: vi.fn(),
    begin_crafting: vi.fn(),
  }
}

function make_world() {
  const force = {
    name: 'player',
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
  }
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
  })

  it('recreates the npc when the cached standalone character becomes invalid', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const first = fake_character(42)
    const replacement = fake_character(99)
    first.surface = surface
    first.force = force
    replacement.surface = surface
    replacement.force = force
    surface.create_entity.mockReturnValueOnce(first).mockReturnValueOnce(replacement)

    set_actor_mode('npc')
    const actor = get_controlled_actor()
    expect(actor?.character).toBe(first)

    first.valid = false
    surface.find_entities_filtered.mockReturnValue([])
    const recovered = get_controlled_actor()

    expect(recovered?.character).toBe(replacement)
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(99)
  })
})
