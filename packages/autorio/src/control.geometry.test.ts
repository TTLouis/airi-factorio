import type { LuaEntity } from 'factorio:runtime'
import { describe, expect, it } from 'vitest'
import type { ControlledActor } from './actors/types'
import { get_direction, get_nearest_entity } from './control'

describe('get_direction', () => {
  it.each([
    [{ x: 1, y: 0 }, 'east'],
    [{ x: 1, y: 1 }, 'southeast'],
    [{ x: 0, y: 1 }, 'south'],
    [{ x: -1, y: 1 }, 'southwest'],
    [{ x: -1, y: 0 }, 'west'],
    [{ x: -1, y: -1 }, 'northwest'],
    [{ x: 0, y: -1 }, 'north'],
    [{ x: 1, y: -1 }, 'northeast'],
  ] as const)('resolves vector %j to %s', (offset, expected) => {
    expect(get_direction({ x: 0, y: 0 }, offset)).toBe(expected)
  })

  it('returns a stable value when start and target are identical', () => {
    expect(get_direction({ x: 2, y: 3 }, { x: 2, y: 3 })).toBe('north')
  })
})

describe('get_nearest_entity', () => {
  function fake_actor(x: number, y: number): ControlledActor {
    return { position: { x, y } } as unknown as ControlledActor
  }

  function fake_entity(name: string, x: number, y: number): LuaEntity {
    return { name, position: { x, y } } as unknown as LuaEntity
  }

  it('returns null for an empty entity list', () => {
    expect(get_nearest_entity(fake_actor(0, 0), [])).toBeNull()
  })

  it('picks the closest entity by squared distance', () => {
    const actor = fake_actor(0, 0)
    const near = fake_entity('near', 1, 0)
    const far = fake_entity('far', 10, 0)

    expect(get_nearest_entity(actor, [far, near])).toBe(near)
  })

  it('keeps the first entity found when distances tie', () => {
    const actor = fake_actor(0, 0)
    const first = fake_entity('first', 1, 0)
    const second = fake_entity('second', -1, 0)

    expect(get_nearest_entity(actor, [first, second])).toBe(first)
  })
})
