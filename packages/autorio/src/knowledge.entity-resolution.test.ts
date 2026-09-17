import { afterEach, describe, expect, it } from 'vitest'
import { remember_entity_reference } from './entity_reference'
import { entity_geometry_for_actor, logistics_topology_for_actor } from './knowledge'

describe('knowledge exact entity resolution', () => {
  const originalLookup = (globalThis as any).game.get_entity_by_unit_number

  afterEach(() => {
    ;(globalThis as any).game.get_entity_by_unit_number = originalLookup
  })

  it('uses an observed entity reference when direct unit lookup later fails', () => {
    const drill = {
      valid: true,
      name: 'modded-miner',
      type: 'mining-drill',
      unit_number: 744,
      position: { x: 62, y: 88 },
      direction: 0,
      force: { index: 1, name: 'player' },
      surface: {
        index: 1,
        find_entities_filtered: () => [drill],
      },
      fluids_count: 0,
      fluidbox: { length: 0 },
      drop_position: { x: 62.5, y: 89.5 },
      drop_target: undefined,
    } as any

    const actor = {
      is_valid: true,
      position: { x: 61, y: 88 },
      force: { index: 1, name: 'player' },
      surface: drill.surface,
    } as any

    remember_entity_reference(drill)
    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined

    const result = entity_geometry_for_actor(actor, 744) as any
    expect(result).toMatchObject({
      found: true,
      entity: { unit_number: 744, name: 'modded-miner' },
      item_io: { drop_position: { x: 62.5, y: 89.5 } },
    })
  })

  it('uses the same resilient resolver for logistics topology', () => {
    const chest = {
      valid: true,
      name: 'iron-chest',
      type: 'container',
      unit_number: 745,
      position: { x: 62.5, y: 89.5 },
      direction: 0,
      force: { index: 1, name: 'player' },
    } as any
    const surface: any = { index: 1 }
    const drill = {
      valid: true,
      name: 'modded-miner',
      type: 'mining-drill',
      unit_number: 744,
      position: { x: 62, y: 88 },
      direction: 0,
      force: { index: 1, name: 'player' },
      surface,
      drop_position: { x: 62.5, y: 89.5 },
      drop_target: chest,
      fluidbox: { length: 0 },
    } as any
    surface.find_entities_filtered = (filter: any) => filter?.type === 'inserter' ? [] : [drill]

    const actor = {
      is_valid: true,
      position: { x: 61, y: 88 },
      force: { index: 1, name: 'player' },
      surface,
    } as any

    remember_entity_reference(drill)
    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined

    const result = logistics_topology_for_actor(actor, 744, 8) as any
    expect(result.found).toBe(true)
    expect(result.relations).toEqual([
      expect.objectContaining({
        kind: 'direct_item_output',
        from: expect.objectContaining({ unit_number: 744 }),
        to: expect.objectContaining({ unit_number: 745 }),
        drop_position: { x: 62.5, y: 89.5 },
      }),
    ])
  })
})
