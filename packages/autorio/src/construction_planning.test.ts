import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { local_spatial_observation, plan_placement, select_navigation_escape_point } from './construction_planning'

function fixture() {
  const actorCharacter: any = {
    valid: true,
    name: 'character',
    type: 'character',
    unit_number: 1,
    position: { x: 0.5, y: 0.5 },
    bounding_box: { left_top: { x: 0.2, y: 0.2 }, right_bottom: { x: 0.8, y: 0.8 } },
    force: { name: 'player' },
  }
  const cliff: any = {
    valid: true,
    name: 'cliff',
    type: 'cliff',
    position: { x: 2.5, y: 0.5 },
    bounding_box: { left_top: { x: 2, y: 0 }, right_bottom: { x: 3, y: 1 } },
    force: { name: 'neutral' },
  }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    find_entities_filtered: vi.fn((args: any) => args.area ? [actorCharacter, cliff] : [cliff]),
    get_tile: vi.fn((x: number, y: number) => ({ name: x === -1 && y === 0 ? 'water' : 'grass-1' })),
    can_place_entity: vi.fn((args: any) => args.position.x >= 1.5 && args.position.y >= -1.5),
    find_non_colliding_position: vi.fn((_name: string, desired: any) => desired.x < 0 ? undefined : desired),
  }
  const actor = {
    is_valid: true,
    character: actorCharacter,
    position: actorCharacter.position,
    surface,
    force: { index: 1, name: 'player' },
  } as unknown as ControlledActor
  return { actor, surface, actorCharacter, cliff }
}

beforeEach(() => {
  ;(globalThis as any).game.tick = 120
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    collision_box: { left_top: { x: -1.4, y: -1.4 }, right_bottom: { x: 1.4, y: 1.4 } },
    selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
  }
})

describe('shared local spatial observation', () => {
  it('reports bounded terrain, structures and the NPC footprint', () => {
    const { actor } = fixture()
    const result: any = local_spatial_observation(actor, { position: { x: 0.5, y: 0.5 }, half_size: 4, requested_entity_name: 'assembling-machine-1' })
    expect(result).toMatchObject({
      ok: true,
      tick: 120,
      size: { width: 8, height: 8 },
      actor: { position: { x: 0.5, y: 0.5 } },
      requested_entity: { name: 'assembling-machine-1', exists: true },
      entity_count: 2,
    })
    expect(result.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'character', category: 'character', is_npc: true }),
      expect.objectContaining({ name: 'cliff', category: 'cliff' }),
    ]))
    expect(result.blocking_terrain.tiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'water', position: { x: -1, y: 0 } }),
    ]))
  })

  it('chooses a deterministic valid side-biased placement and exposes rejected collision causes', () => {
    const { actor } = fixture()
    const result: any = plan_placement(actor, {
      entity_name: 'assembling-machine-1',
      position: { x: 0.5, y: 0.5 },
      side: 'east',
      search_radius: 4,
      max_candidates: 3,
      reserve_input: true,
      reserve_output: true,
      reserve_power: true,
      extension_direction: 'east',
    })
    expect(result.ok).toBe(true)
    expect(result.best.position.x).toBeGreaterThanOrEqual(1.5)
    expect(result.candidates.length).toBeLessThanOrEqual(3)
    expect(result.corridors).toMatchObject({ input: { reserved: true }, output: { reserved: true }, power: { reserved: true } })
    expect(result.rejected.length).toBeGreaterThan(0)
  })

  it('reuses the same collision-aware backend to select a local navigation escape point', () => {
    const { actor } = fixture()
    const result: any = select_navigation_escape_point(actor, { x: 20, y: 0 }, 6)
    expect(result.ok).toBe(true)
    expect(result.best.position.x).toBeGreaterThanOrEqual(0)
    expect(result.spatial_observation.ok).toBe(true)
  })
})
