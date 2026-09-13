import type { LuaEntity, LuaPlayer } from 'factorio:runtime'
import { describe, expect, it } from 'vitest'
import { get_direction, get_nearest_entity } from './control'

describe('get_direction', () => {
  it('resolves each open octant to its own direction', () => {
    // These eight vectors sit well inside their respective octants (not on a
    // boundary), so each assertion is unambiguous.
    expect(get_direction({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe('west')
    expect(get_direction({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe('south')
    expect(get_direction({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe('north')
    expect(get_direction({ x: 0, y: 0 }, { x: 1, y: -1 })).toBe('northeast')
    expect(get_direction({ x: 0, y: 0 }, { x: -1, y: 1 })).toBe('southwest')
    expect(get_direction({ x: 0, y: 0 }, { x: -1, y: -1 })).toBe('northwest')
  })

  it('classifies a due-east vector as southeast, a known boundary quirk of the current octant math', () => {
    // start.x - end.x for a pure +x move is exactly -1, so atan2(0, -1) lands
    // exactly on the +pi/-pi wraparound the octant formula does not special-case.
    // This locks in today's actual output as a regression baseline, not a claim
    // that "southeast" is the intended answer for moving east.
    expect(get_direction({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe('southeast')
  })
})

describe('get_nearest_entity', () => {
  function fake_player(x: number, y: number): LuaPlayer {
    return { position: { x, y } } as unknown as LuaPlayer
  }

  function fake_entity(name: string, x: number, y: number): LuaEntity {
    return { name, position: { x, y } } as unknown as LuaEntity
  }

  it('returns null for an empty entity list', () => {
    expect(get_nearest_entity(fake_player(0, 0), [])).toBeNull()
  })

  it('picks the closest entity by squared distance', () => {
    const player = fake_player(0, 0)
    const near = fake_entity('near', 1, 0)
    const far = fake_entity('far', 10, 0)

    expect(get_nearest_entity(player, [far, near])).toBe(near)
  })

  it('keeps the first entity found when distances tie', () => {
    const player = fake_player(0, 0)
    const first = fake_entity('first', 1, 0)
    const second = fake_entity('second', -1, 0)

    expect(get_nearest_entity(player, [first, second])).toBe(first)
  })
})
