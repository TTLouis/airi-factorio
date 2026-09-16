import type { LuaEntity, LuaEntityPrototype, LuaLogisticNetwork, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancel_remote_upgrade, inspect_remote_upgrade, mark_remote_upgrade } from './map_upgrade'

function make_network(item_count = 2, robots = 2) {
  return {
    valid: true,
    network_id: 9,
    all_construction_robots: robots,
    available_construction_robots: robots,
    get_item_count: vi.fn(() => item_count),
  } as unknown as LuaLogisticNetwork
}

function make_surface(networks: LuaLogisticNetwork[] = []) {
  return {
    index: 1,
    name: 'nauvis',
    valid: true,
    find_logistic_networks_by_construction_area: vi.fn(() => networks),
  } as unknown as LuaSurface
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

function make_entity(surface: LuaSurface, source: LuaEntityPrototype, target: LuaEntityPrototype) {
  let current_target: LuaEntityPrototype | undefined
  return {
    valid: true,
    unit_number: 42,
    name: source.name,
    type: 'transport-belt',
    prototype: source,
    position: { x: 64, y: 64 },
    surface,
    force: { index: 1, name: 'player' },
    to_be_upgraded: vi.fn(() => current_target !== undefined),
    get_upgrade_target: vi.fn(() => [current_target, undefined]),
    order_upgrade: vi.fn((request: { target: string }) => {
      if (request.target !== target.name) return false
      current_target = target
      return true
    }),
    cancel_upgrade: vi.fn(() => {
      const was_marked = current_target !== undefined
      current_target = undefined
      return was_marked
    }),
  } as unknown as LuaEntity
}

beforeEach(() => {
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn()
  const target = {
    name: 'fast-transport-belt',
    fast_replaceable_group: 'transport-belt',
    items_to_place_this: [{ name: 'fast-transport-belt', count: 1 }],
  }
  const source = {
    name: 'transport-belt',
    fast_replaceable_group: 'transport-belt',
    next_upgrade: target,
    items_to_place_this: [{ name: 'transport-belt', count: 1 }],
  }
  ;(globalThis as any).prototypes.entity['transport-belt'] = source
  ;(globalThis as any).prototypes.entity['fast-transport-belt'] = target
})

describe('map remote upgrade', () => {
  it('refuses upgrade inspection outside charted map space', () => {
    const surface = make_surface()
    const actor = make_actor(surface, false)
    const source = (globalThis as any).prototypes.entity['transport-belt'] as LuaEntityPrototype
    const target = (globalThis as any).prototypes.entity['fast-transport-belt'] as LuaEntityPrototype
    const entity = make_entity(surface, source, target)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    expect(inspect_remote_upgrade(actor, 42)).toEqual({ ok: false, code: 'area_uncharted', unit_number: 42 })
  })

  it('derives the normal next_upgrade and validates robot/item fulfillment', () => {
    const network = make_network(3, 2)
    const surface = make_surface([network])
    const actor = make_actor(surface)
    const source = (globalThis as any).prototypes.entity['transport-belt'] as LuaEntityPrototype
    const target = (globalThis as any).prototypes.entity['fast-transport-belt'] as LuaEntityPrototype
    const entity = make_entity(surface, source, target)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = inspect_remote_upgrade(actor, 42)

    expect(result).toMatchObject({
      ok: true,
      execution_mode: 'remote',
      target: { name: 'fast-transport-belt', item: { name: 'fast-transport-belt', count: 1 } },
      construction: {
        fulfillment: 'ready',
        remotely_fulfillable: true,
        completion_guaranteed: false,
      },
    })
    expect(network.get_item_count).toHaveBeenCalledWith('fast-transport-belt')
  })

  it('marks a charted entity for robot upgrade without replacing it directly', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface)
    const source = (globalThis as any).prototypes.entity['transport-belt'] as LuaEntityPrototype
    const target = (globalThis as any).prototypes.entity['fast-transport-belt'] as LuaEntityPrototype
    const entity = make_entity(surface, source, target)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = mark_remote_upgrade(actor, 42)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'upgrade_marked',
      target_name: 'fast-transport-belt',
      world_completion: 'pending_robot_fulfillment',
    })
    expect(entity.order_upgrade).toHaveBeenCalledWith({ target: 'fast-transport-belt', force: actor.force })
  })

  it('reports missing upgrade items instead of claiming remote completion', () => {
    const surface = make_surface([make_network(0, 2)])
    const actor = make_actor(surface)
    const source = (globalThis as any).prototypes.entity['transport-belt'] as LuaEntityPrototype
    const target = (globalThis as any).prototypes.entity['fast-transport-belt'] as LuaEntityPrototype
    const entity = make_entity(surface, source, target)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = mark_remote_upgrade(actor, 42)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'upgrade_marked',
      world_completion: 'blocked',
      construction: { fulfillment: 'blocked_upgrade_item_missing' },
    })
  })

  it('cancels an existing upgrade marker', () => {
    const surface = make_surface([make_network()])
    const actor = make_actor(surface)
    const source = (globalThis as any).prototypes.entity['transport-belt'] as LuaEntityPrototype
    const target = (globalThis as any).prototypes.entity['fast-transport-belt'] as LuaEntityPrototype
    const entity = make_entity(surface, source, target)
    ;(entity.order_upgrade as any)({ target: target.name, force: actor.force })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = cancel_remote_upgrade(actor, 42)

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution_mode: 'remote',
      code: 'upgrade_cancelled',
      unit_number: 42,
    })
    expect(entity.cancel_upgrade).toHaveBeenCalledWith(actor.force)
  })
})
