import type { LuaEntity, LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspect_remote_construction, stage_remote_entity_ghost } from './map_construction'

function make_network(overrides: Partial<LuaLogisticNetwork> = {}) {
  return {
    valid: true,
    network_id: 7,
    all_construction_robots: 4,
    available_construction_robots: 2,
    get_item_count: vi.fn(() => 10),
    ...overrides,
  } as unknown as LuaLogisticNetwork
}

function make_surface(networks: LuaLogisticNetwork[] = []) {
  const surface: any = {
    index: 1,
    name: 'nauvis',
    valid: true,
    can_place_entity: vi.fn(() => true),
    find_logistic_networks_by_construction_area: vi.fn(() => networks),
    create_entity: vi.fn(),
  }
  return surface as LuaSurface
}

function make_actor(surface: LuaSurface, charted = true) {
  return {
    is_valid: true,
    surface,
    force: {
      index: 1,
      name: 'player',
      is_chunk_charted: vi.fn(() => charted),
    },
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).game.get_surface = vi.fn()
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    items_to_place_this: [{ name: 'assembling-machine-1', count: 1 }],
  }
})

describe('map remote construction', () => {
  it('refuses construction knowledge outside charted map space', () => {
    const surface = make_surface()
    const actor = make_actor(surface, false)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 320, 320, 'assembling-machine-1')

    expect(result).toMatchObject({ ok: false, code: 'area_uncharted' })
    expect(surface.can_place_entity).not.toHaveBeenCalled()
    expect(surface.find_logistic_networks_by_construction_area).not.toHaveBeenCalled()
  })

  it('reports when a charted ghost is placeable but no construction network can fulfill it', () => {
    const surface = make_surface([])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'assembling-machine-1', 4)

    expect(result).toMatchObject({
      ok: true,
      execution_mode: 'remote',
      can_place_ghost: true,
      fulfillment: 'blocked_no_construction_network',
      remotely_fulfillable: false,
      network_count: 0,
    })
  })

  it('reports robot and item availability from construction networks', () => {
    const network = make_network()
    const surface = make_surface([network])
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = inspect_remote_construction(actor, 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({
      ok: true,
      fulfillment: 'ready',
      remotely_fulfillable: true,
      all_construction_robots: 4,
      available_construction_robots: 2,
      available_construction_items: 10,
    })
    expect(network.get_item_count).toHaveBeenCalledWith('assembling-machine-1')
  })

  it('stages a ghost without pretending the building is already complete', () => {
    const network = make_network()
    const surface = make_surface([network])
    const ghost = {
      valid: true,
      name: 'entity-ghost',
      ghost_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      surface,
      direction: 4,
    } as unknown as LuaEntity
    ;(surface.create_entity as any).mockReturnValue(ghost)
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = stage_remote_entity_ghost(actor, 1, 64, 64, 'assembling-machine-1', 4)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'ghost_staged',
      world_completion: 'pending_robot_fulfillment',
      construction: { remotely_fulfillable: true },
    })
    expect(surface.create_entity).toHaveBeenCalledWith({
      name: 'entity-ghost',
      inner_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      direction: 4,
      force: actor.force,
      raise_built: true,
    })
  })

  it('can stage a ghost even when fulfillment is blocked, and reports the blocker', () => {
    const surface = make_surface([])
    const ghost = {
      valid: true,
      name: 'entity-ghost',
      ghost_name: 'assembling-machine-1',
      position: { x: 64, y: 64 },
      surface,
      direction: 0,
    } as unknown as LuaEntity
    ;(surface.create_entity as any).mockReturnValue(ghost)
    const actor = make_actor(surface)
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = stage_remote_entity_ghost(actor, 1, 64, 64, 'assembling-machine-1')

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'ghost_staged',
      world_completion: 'blocked',
      construction: { fulfillment: 'blocked_no_construction_network' },
    })
  })
})
