import type { LuaPlayer } from 'factorio:runtime'
import { describe, expect, it, vi } from 'vitest'
import { ConnectedPlayerActor } from './connected_player_actor'

function fake_player(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    name: 'Louis',
    index: 1,
    position: { x: 1, y: 2 },
    character: { unit_number: 7 },
    surface: { name: 'nauvis' },
    force: { name: 'player' },
    mining_state: { mining: false },
    get_main_inventory: vi.fn(() => 'main-inventory'),
    update_selected_entity: vi.fn(),
    begin_crafting: vi.fn(),
    ...overrides,
  } as unknown as LuaPlayer
}

describe('ConnectedPlayerActor', () => {
  it('reads identity/position/force/surface/character straight through from the player', () => {
    const player = fake_player()
    const actor = new ConnectedPlayerActor(player)

    expect(actor.is_valid).toBe(true)
    expect(actor.character).toBe(player.character)
    expect(actor.surface).toBe(player.surface)
    expect(actor.force).toBe(player.force)
    expect(actor.position).toBe(player.position)
  })

  it('delegates get_main_inventory and update_selected_entity without altering args/results', () => {
    const player = fake_player()
    const actor = new ConnectedPlayerActor(player)

    expect(actor.get_main_inventory()).toBe('main-inventory')

    actor.update_selected_entity({ x: 5, y: 6 })
    expect(player.update_selected_entity).toHaveBeenCalledWith({ x: 5, y: 6 })
  })

  it('gets and sets mining_state through the same property the rest of the mod uses', () => {
    const player = fake_player({ mining_state: { mining: true, position: { x: 1, y: 1 } } })
    const actor = new ConnectedPlayerActor(player)

    expect(actor.get_mining_state()).toEqual({ mining: true, position: { x: 1, y: 1 } })

    actor.set_mining_state({ mining: false })
    expect(player.mining_state).toEqual({ mining: false })
  })

  it('sets walking_state through the same property the rest of the mod uses', () => {
    const player = fake_player()
    const actor = new ConnectedPlayerActor(player)

    actor.set_walking_state({ walking: true, direction: 4 as any })
    expect(player.walking_state).toEqual({ walking: true, direction: 4 })
  })

  it('forwards begin_crafting args unchanged', () => {
    const player = fake_player()
    const actor = new ConnectedPlayerActor(player)

    actor.begin_crafting({ count: 3, recipe: 'iron-gear-wheel' })
    expect(player.begin_crafting).toHaveBeenCalledWith({ count: 3, recipe: 'iron-gear-wheel' })
  })

  it('builds entity_build_args from the wrapped player, matching current placement attribution', () => {
    const player = fake_player()
    const actor = new ConnectedPlayerActor(player)

    expect(actor.entity_build_args()).toEqual({ force: player.force, player })
  })

  it('produces a status snapshot reflecting the wrapped player', () => {
    const player = fake_player()
    const actor = new ConnectedPlayerActor(player)

    expect(actor.status_snapshot()).toEqual({
      kind: 'connected_player',
      valid: true,
      name: 'Louis',
      position: { x: 1, y: 2 },
      has_character: true,
      actor_id: 1,
    })
  })

  it('reflects a missing character in status_snapshot', () => {
    const player = fake_player({ character: undefined })
    const actor = new ConnectedPlayerActor(player)

    expect(actor.status_snapshot().has_character).toBe(false)
  })

  it('owns_player_index matches only the wrapped player\'s own index', () => {
    const player = fake_player({ index: 3 })
    const actor = new ConnectedPlayerActor(player)

    expect(actor.owns_player_index(3)).toBe(true)
    expect(actor.owns_player_index(1)).toBe(false)
  })
})
