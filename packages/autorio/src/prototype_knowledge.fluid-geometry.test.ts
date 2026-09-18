import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prototype_details } from './prototype_knowledge'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function runtimeCollection<T>(values: T[]) {
  const result: Record<number, T> = {}
  for (let index = 0; index < values.length; index++) result[index + 1] = values[index]
  return result
}

describe('prototype fluid connection geometry', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    const boiler = {
      name: 'boiler',
      type: 'boiler',
      is_building: true,
      tile_width: 3,
      tile_height: 2,
      collision_box: {},
      selection_box: {},
      items_to_place_this: [{ name: 'boiler', count: 1 }],
      fluidbox_prototypes: [
        {
          index: 1,
          production_type: 'input-output',
          filter: { name: 'water' },
          pipe_connections: [
            {
              connection_type: 'normal',
              flow_direction: 'input-output',
              direction: 12,
              positions: [
                { x: -2, y: 0.5 },
                { x: -0.5, y: -2 },
                { x: 2, y: -0.5 },
                { x: 0.5, y: 2 },
              ],
              connection_category: ['default'],
            },
          ],
        },
      ],
    }

    ;(globalThis as any).prototypes = {
      entity: { boiler },
      item: { boiler: { name: 'boiler', stack_size: 50, place_result: boiler } },
      fluid: {},
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes = originalPrototypes
  })

  it('exposes bounded Factorio-native pipe connection geometry without inventing world connectivity', () => {
    const result = prototype_details('boiler') as any
    expect(result.entity.fluidboxes).toHaveLength(1)
    expect(result.entity.fluidboxes[0]).toMatchObject({
      index: 1,
      production_type: 'input-output',
      filter: 'water',
      pipe_connection_count: 1,
      pipe_connections_truncated: false,
      pipe_connections: [
        {
          connection_type: 'normal',
          flow_direction: 'input-output',
          direction: 12,
          positions: [
            { x: -2, y: 0.5 },
            { x: -0.5, y: -2 },
            { x: 2, y: -0.5 },
            { x: 0.5, y: 2 },
          ],
          positions_truncated: false,
          connection_categories: ['default'],
          connection_categories_truncated: false,
        },
      ],
    })
  })

  it('reads runtime-shaped fluidbox, connection, position, and category collections without JS array methods or length', () => {
    const boiler = (globalThis as any).prototypes.entity.boiler
    boiler.items_to_place_this = runtimeCollection([{ name: 'boiler', count: 1 }])
    boiler.fluidbox_prototypes = runtimeCollection([
      {
        index: 1,
        production_type: 'input-output',
        filter: { name: 'water' },
        pipe_connections: runtimeCollection([
          {
            connection_type: 'normal',
            flow_direction: 'input-output',
            direction: 12,
            positions: runtimeCollection([
              { x: -2, y: 0.5 },
              { x: -0.5, y: -2 },
              { x: 2, y: -0.5 },
              { x: 0.5, y: 2 },
              { x: 99, y: 99 },
            ]),
            connection_category: runtimeCollection(['default', 'water', 'steam', 'modded', 'overflow']),
          },
        ]),
      },
    ])

    const result = prototype_details('boiler') as any
    expect(result.entity.place_items).toEqual([{ name: 'boiler', count: 1 }])
    expect(result.entity.fluidboxes).toHaveLength(1)
    expect(result.entity.fluidboxes[0]).toMatchObject({
      pipe_connection_count: 1,
      pipe_connections_truncated: false,
      pipe_connections: [{
        positions: [
          { x: -2, y: 0.5 },
          { x: -0.5, y: -2 },
          { x: 2, y: -0.5 },
          { x: 0.5, y: 2 },
        ],
        positions_truncated: true,
        connection_categories: ['default', 'water', 'steam', 'modded'],
        connection_categories_truncated: true,
      }],
    })
  })

  it('bounds pathological modded pipe connection counts instead of dumping prototype state', () => {
    const fluidbox = (globalThis as any).prototypes.entity.boiler.fluidbox_prototypes[0]
    fluidbox.pipe_connections = Array.from({ length: 20 }, (_, index) => ({
      connection_type: 'normal',
      flow_direction: 'input-output',
      direction: 0,
      positions: [{ x: index, y: -1 }],
      connection_category: ['default'],
    }))

    const result = prototype_details('boiler') as any
    expect(result.entity.fluidboxes[0].pipe_connection_count).toBe(20)
    expect(result.entity.fluidboxes[0].pipe_connections_truncated).toBe(true)
    expect(result.entity.fluidboxes[0].pipe_connections).toHaveLength(8)
  })
})
