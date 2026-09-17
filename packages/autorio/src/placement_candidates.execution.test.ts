import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_placement_candidate_set, execute_placement_candidate } from './placement_candidates'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

describe('placement candidate execution', () => {
  const originalPairs = (globalThis as any).pairs
  const originalStorage = (globalThis as any).storage
  const originalGame = (globalThis as any).game
  const originalEntityPrototypes = (globalThis as any).prototypes.entity

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game = { tick: 100 }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).storage = originalStorage
    ;(globalThis as any).game = originalGame
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
  })

  function actor(canPlace: () => boolean = () => true) {
    return {
      position: { x: 0, y: 0 },
      force: { index: 2 },
      surface: {
        index: 7,
        can_place_entity: canPlace,
        find_entities_filtered: () => [],
      },
    } as any
  }

  it('executes by candidate identity and reuses the stored coordinates', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    const controlled = actor(({ position }: any) => position.x === 0.5 && position.y === 0.5)
    const generated = create_placement_candidate_set(controlled, {
      entity_name: 'modded-building',
      center: { x: 0, y: 0 },
      radius: 1,
      limit: 1,
    }) as any

    const submitted: any[] = []
    const result = execute_placement_candidate(
      controlled,
      generated.candidate_set_id,
      generated.candidates[0].id,
      (entity_name, x, y, direction) => {
        submitted.push({ entity_name, x, y, direction })
        return true
      },
    )

    expect(result[0]).toBe(true)
    expect(submitted).toEqual([{
      entity_name: 'modded-building',
      x: 0.5,
      y: 0.5,
      direction: generated.candidates[0].direction,
    }])
  })

  it('rejects a candidate that became unplaceable before execution', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    let placeable = true
    const controlled = actor(() => placeable)
    const generated = create_placement_candidate_set(controlled, {
      entity_name: 'modded-building',
      radius: 1,
      limit: 1,
    }) as any
    placeable = false

    let submitted = false
    const result = execute_placement_candidate(
      controlled,
      generated.candidate_set_id,
      generated.candidates[0].id,
      () => {
        submitted = true
        return true
      },
    )

    expect(result).toEqual([false, 'placement candidate is no longer placeable'])
    expect(submitted).toBe(false)
  })

  it('rejects expired candidate sets', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    const controlled = actor()
    const generated = create_placement_candidate_set(controlled, {
      entity_name: 'modded-building',
      radius: 1,
      limit: 1,
    }) as any
    ;(globalThis as any).game.tick = generated.expires_tick + 1

    const result = execute_placement_candidate(
      controlled,
      generated.candidate_set_id,
      generated.candidates[0].id,
      () => true,
    )

    expect(result).toEqual([false, 'placement candidate set expired'])
  })
})
