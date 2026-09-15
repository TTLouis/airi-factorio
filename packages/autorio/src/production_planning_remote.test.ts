import type { ControlledActor } from './actors/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create_production_planning_remote_interface } from './production_planning_remote'

const originalRemote = (globalThis as any).remote
const originalPairs = (globalThis as any).pairs
const originalPrototypes = (globalThis as any).prototypes

afterEach(() => {
  ;(globalThis as any).remote = originalRemote
  ;(globalThis as any).pairs = originalPairs
  ;(globalThis as any).prototypes = originalPrototypes
})

describe('autorio_planning remote contract', () => {
  it('registers solve and delegates a live recipe request through the controlled actor', () => {
    let planning: { solve: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: vi.fn((name: string, methods: any) => {
        if (name === 'autorio_planning') planning = methods
      }),
    }
    ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value)
    ;(globalThis as any).prototypes = { entity: {} }

    const recipe = {
      name: 'iron-gear-wheel',
      enabled: true,
      hidden: false,
      energy: 0.5,
      ingredients: [{ type: 'item', name: 'iron-plate', amount: 2 }],
      products: [{ type: 'item', name: 'iron-gear-wheel', amount: 1, probability: 1 }],
    }
    const actor = {
      is_valid: true,
      force: { recipes: { 'iron-gear-wheel': recipe } },
    } as unknown as ControlledActor

    create_production_planning_remote_interface(() => actor)

    expect((globalThis as any).remote.add_interface).toHaveBeenCalledOnce()
    expect(planning).toBeDefined()
    const result = planning!.solve({
      calculation_id: 'gear-rate',
      target: { type: 'item', name: 'iron-gear-wheel', rate_per_second: 2 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calculation_id).toBe('gear-rate')
    expect(result.external_inputs).toEqual([
      { type: 'item', name: 'iron-plate', rate_per_second: 4 },
    ])
  })

  it('fails closed when there is no controlled actor', () => {
    let planning: { solve: (request: any) => any } | undefined
    ;(globalThis as any).remote = {
      add_interface: (_name: string, methods: any) => {
        planning = methods
      },
    }

    create_production_planning_remote_interface(() => undefined)
    const result = planning!.solve({
      calculation_id: 'missing-actor',
      target: { type: 'item', name: 'iron-gear-wheel', rate_per_second: 1 },
    })

    expect(result).toEqual({
      ok: false,
      calculation_id: 'missing-actor',
      error: {
        code: 'INVALID_REQUEST',
        message: 'controlled actor is unavailable',
      },
    })
  })
})
