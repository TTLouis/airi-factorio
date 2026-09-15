import type { ControlledActor } from './actors/types'
import { afterEach, describe, expect, it } from 'vitest'
import { throughput_capacity } from './throughput_capacity'

const originalPrototypes = (globalThis as any).prototypes

function actor(force: Record<string, unknown>) {
  return { is_valid: true, force } as unknown as ControlledActor
}

afterEach(() => {
  ;(globalThis as any).prototypes = originalPrototypes
})

describe('deterministic throughput capacity facts', () => {
  it('derives lane, full-belt, and researched stacking capacity from live belt speed', () => {
    ;(globalThis as any).prototypes = {
      entity: { 'transport-belt': { name: 'transport-belt', type: 'transport-belt', belt_speed: 0.03125 } },
      item: {},
    }

    const result = throughput_capacity(actor({ belt_stack_size_bonus: 2 }), {
      kind: 'belt',
      prototype_name: 'transport-belt',
      required_rate_per_second: 40,
    })

    expect(result).toMatchObject({
      ok: true,
      kind: 'belt',
      scope: 'belt',
      force_belt_stack_size_bonus: 2,
      effective_belt_stack_size: 3,
      capacity: {
        unstacked_lane_items_per_second: 7.5,
        unstacked_belt_items_per_second: 15,
        stacked_lane_items_per_second: 22.5,
        stacked_belt_items_per_second: 45,
      },
      validation: {
        scope: 'belt',
        required_rate_per_second: 40,
        unstacked_capacity_items_per_second: 15,
        stacked_capacity_items_per_second: 45,
        fits_unstacked: false,
        fits_stacked: true,
      },
      semantics: {
        transport_capacity_only: true,
        stacked_capacity_requires_matching_item_stacks: true,
      },
    })
  })

  it('validates a single lane independently from a whole belt', () => {
    ;(globalThis as any).prototypes = {
      entity: { 'transport-belt': { name: 'transport-belt', type: 'transport-belt', belt_speed: 0.03125 } },
      item: {},
    }

    const result = throughput_capacity(actor({ belt_stack_size_bonus: 2 }), {
      kind: 'belt', prototype_name: 'transport-belt', scope: 'lane', required_rate_per_second: 20,
    })
    expect(result).toMatchObject({
      ok: true,
      validation: {
        scope: 'lane',
        unstacked_capacity_items_per_second: 7.5,
        stacked_capacity_items_per_second: 22.5,
        fits_unstacked: false,
        fits_stacked: true,
      },
    })
  })

  it('reports researched inserter hand capacity but refuses to invent a fixed items-per-second rate', () => {
    ;(globalThis as any).prototypes = {
      entity: {
        'bulk-inserter': {
          name: 'bulk-inserter',
          type: 'inserter',
          bulk: true,
          uses_inserter_stack_size_bonus: true,
          inserter_stack_size_bonus: 1,
          inserter_max_belt_stack_size: 1,
          inserter_pickup_position: { x: 0, y: -1 },
          inserter_drop_position: { x: 0, y: 1 },
          get_inserter_rotation_speed: () => 0.1,
          get_inserter_extension_speed: () => 0.05,
        },
      },
      item: { 'iron-plate': { name: 'iron-plate', stack_size: 100 } },
    }

    const result = throughput_capacity(actor({
      belt_stack_size_bonus: 3,
      bulk_inserter_capacity_bonus: 10,
      inserter_stack_size_bonus: 3,
    }), {
      kind: 'inserter',
      prototype_name: 'bulk-inserter',
      item_name: 'iron-plate',
    })

    expect(result).toMatchObject({
      ok: true,
      kind: 'inserter',
      bulk: true,
      built_in_stack_size_bonus: 1,
      force_capacity_bonus: 10,
      hand_capacity_items: 12,
      belt_drop_stack_limit: 1,
      movement: { rotation_speed: 0.1, extension_speed: 0.05 },
      transfer_rate: { validated: false },
    })
  })

  it('caps hand capacity by the selected item stack size', () => {
    ;(globalThis as any).prototypes = {
      entity: {
        'mod-inserter': {
          name: 'mod-inserter',
          type: 'inserter',
          bulk: false,
          uses_inserter_stack_size_bonus: true,
          inserter_stack_size_bonus: 20,
        },
      },
      item: { fish: { name: 'fish', stack_size: 5 } },
    }

    const result = throughput_capacity(actor({ inserter_stack_size_bonus: 20, belt_stack_size_bonus: 0 }), {
      kind: 'inserter', prototype_name: 'mod-inserter', item_name: 'fish',
    })
    expect(result).toMatchObject({ ok: true, hand_capacity_items: 5, item_stack_size: 5 })
  })
})
