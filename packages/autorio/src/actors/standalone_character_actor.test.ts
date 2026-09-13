import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StandaloneCharacterActor } from './standalone_character_actor'

function fake_character(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    unit_number: 42,
    position: { x: 10, y: 20 },
    surface: { name: 'nauvis' },
    force: { name: 'player' },
    selected: undefined,
    mining_state: { mining: false },
    mining_progress: 0,
    update_selected_entity: vi.fn(),
    get_main_inventory: vi.fn(() => 'main-inventory'),
    begin_crafting: vi.fn(),
    ...overrides,
  }
}

function fake_surface(entities_by_query: Record<string, unknown[]> = {}) {
  return {
    create_entity: vi.fn(),
    find_entities_filtered: vi.fn((query: { name?: string }) => entities_by_query[query.name ?? ''] ?? []),
  } as any
}

beforeEach(() => {
  (globalThis as any).storage = {}
})

describe('StandaloneCharacterActor.create', () => {
  it('creates a character entity and persists its unit_number in storage', () => {
    const character = fake_character()
    const surface = fake_surface()
    surface.create_entity.mockReturnValue(character)
    const force = { name: 'player' } as any

    const actor = StandaloneCharacterActor.create(surface, force, { x: 10, y: 20 })

    expect(surface.create_entity).toHaveBeenCalledWith({ name: 'character', position: { x: 10, y: 20 }, force })
    expect(actor).toBeDefined()
    expect(actor!.character).toBe(character)
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(42)
  })

  it('returns undefined when the engine refuses to create the entity', () => {
    const surface = fake_surface()
    surface.create_entity.mockReturnValue(undefined)

    const actor = StandaloneCharacterActor.create(surface, {} as any, { x: 0, y: 0 })

    expect(actor).toBeUndefined()
    expect((globalThis as any).storage.standalone_character_unit_number).toBeUndefined()
  })
})

describe('StandaloneCharacterActor.reacquire', () => {
  it('returns undefined when nothing was ever created', () => {
    const surface = fake_surface()

    expect(StandaloneCharacterActor.reacquire(surface)).toBeUndefined()
  })

  it('finds the persisted character by unit_number among same-named entities', () => {
    (globalThis as any).storage.standalone_character_unit_number = 42
    const character = fake_character({ unit_number: 42 })
    const other = fake_character({ unit_number: 99 })
    const surface = fake_surface({ character: [other, character] })

    const actor = StandaloneCharacterActor.reacquire(surface)

    expect(actor).toBeDefined()
    expect(actor!.character).toBe(character)
  })

  it('returns undefined when the persisted unit_number no longer exists (e.g. it died)', () => {
    (globalThis as any).storage.standalone_character_unit_number = 42
    const surface = fake_surface({ character: [] })

    expect(StandaloneCharacterActor.reacquire(surface)).toBeUndefined()
  })
})

describe('StandaloneCharacterActor as a ControlledActor', () => {
  function create_actor(overrides: Record<string, unknown> = {}) {
    const character = fake_character(overrides)
    const surface = fake_surface()
    surface.create_entity.mockReturnValue(character)
    const actor = StandaloneCharacterActor.create(surface, {} as any, { x: 0, y: 0 })!
    return { actor, character }
  }

  it('reads identity/position/force/surface/character straight through from the character entity', () => {
    const { actor, character } = create_actor()

    expect(actor.is_valid).toBe(true)
    expect(actor.character).toBe(character)
    expect(actor.surface).toBe(character.surface)
    expect(actor.force).toBe(character.force)
    expect(actor.position).toBe(character.position)
  })

  it('delegates get_main_inventory and begin_crafting to the character entity', () => {
    const { actor, character } = create_actor()

    expect(actor.get_main_inventory()).toBe('main-inventory')

    actor.begin_crafting({ count: 2, recipe: 'iron-gear-wheel' })
    expect(character.begin_crafting).toHaveBeenCalledWith({ count: 2, recipe: 'iron-gear-wheel' })
  })

  it('gets and sets mining/walking/shooting state directly on the character entity while mining is progressing', () => {
    const selected = { name: 'iron-ore' }
    const { actor, character } = create_actor({
      selected,
      mining_progress: 0.5,
      mining_state: { mining: true, position: { x: 1, y: 1 } },
    })

    expect(actor.get_mining_state()).toEqual({ mining: true, position: { x: 1, y: 1 } })

    actor.set_mining_state({ mining: false })
    expect((character as any).mining_state).toEqual({ mining: false })

    actor.set_walking_state({ walking: true, direction: 4 as any })
    expect((character as any).walking_state).toEqual({ walking: true, direction: 4 })

    actor.set_shooting_state({ state: 'shooting_enemies' as any, position: { x: 5, y: 5 } })
    expect((character as any).shooting_state).toEqual({ state: 'shooting_enemies', position: { x: 5, y: 5 } })
  })

  it('reports mining as effectively stopped when Factorio clears the selected entity', () => {
    const { actor } = create_actor({
      selected: undefined,
      mining_progress: 0.5,
      mining_state: { mining: true, position: { x: 1, y: 1 } },
    })

    expect(actor.get_mining_state()).toEqual({ mining: false })
  })

  it('reports mining as effectively stopped when character mining progress returns to zero', () => {
    const { actor } = create_actor({
      selected: { name: 'iron-ore' },
      mining_progress: 0,
      mining_state: { mining: true, position: { x: 1, y: 1 } },
    })

    expect(actor.get_mining_state()).toEqual({ mining: false })
  })

  it('never claims a LuaPlayer-sourced event, since it has no LuaPlayer behind it', () => {
    const { actor } = create_actor()

    expect(actor.owns_player_index(1)).toBe(false)
    expect(actor.owns_player_index(0)).toBe(false)
  })

  it('builds entity_build_args with only a force, unlike ConnectedPlayerActor', () => {
    const { actor, character } = create_actor()

    expect(actor.entity_build_args()).toEqual({ force: character.force })
  })

  it('produces a status snapshot identifying itself as a standalone_character with bounded mining diagnostics', () => {
    const { actor } = create_actor()

    expect(actor.status_snapshot()).toEqual({
      kind: 'standalone_character',
      valid: true,
      name: 'AIRI',
      position: { x: 10, y: 20 },
      has_character: true,
      actor_id: 42,
      selected_entity: undefined,
      mining_state: { mining: false },
      mining_progress: 0,
    })
  })
})
