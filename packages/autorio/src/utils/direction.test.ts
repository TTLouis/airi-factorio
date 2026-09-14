import { describe, expect, it } from 'vitest'
import { direction_towards } from './direction'

describe('direction_towards', () => {
  it.each([
    [{ x: 1, y: 0 }, 'east'],
    [{ x: 1, y: 1 }, 'southeast'],
    [{ x: 0, y: 1 }, 'south'],
    [{ x: -1, y: 1 }, 'southwest'],
    [{ x: -1, y: 0 }, 'west'],
    [{ x: -1, y: -1 }, 'northwest'],
    [{ x: 0, y: -1 }, 'north'],
    [{ x: 1, y: -1 }, 'northeast'],
  ] as const)('maps vector %j to %s', (offset, expected) => {
    expect(direction_towards({ x: 0, y: 0 }, offset)).toBe(expected)
  })

  it('returns a stable direction for a zero-length vector', () => {
    expect(direction_towards({ x: 5, y: -3 }, { x: 5, y: -3 })).toBe('north')
  })
})
