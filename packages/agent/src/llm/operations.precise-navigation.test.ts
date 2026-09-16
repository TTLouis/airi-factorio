import { describe, expect, it } from 'vitest'
import { parseStructuredOperations, renderStructuredOperation } from './operations'

describe('precise navigation structured operations', () => {
  it('renders exact unit-number navigation with a bounded arrival distance', () => {
    const [operation] = parseStructuredOperations([{
      name: 'walk_to_entity_exact',
      args: { unit_number: 4242, reach_distance: 1.5 },
    }])

    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'walk_to_entity_exact', 4242, 1.5)")
  })

  it('renders coordinate navigation and supplies the default arrival distance', () => {
    const [operation] = parseStructuredOperations([{
      name: 'walk_to_position',
      args: { x: 24, y: 47 },
    }])

    expect(operation.args).toEqual({ x: 24, y: 47, reach_distance: 0.75 })
    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'walk_to_position', 24, 47, 0.75)")
  })

  it('rejects unsafe coordinate and arrival bounds', () => {
    expect(() => parseStructuredOperations([{
      name: 'walk_to_position',
      args: { x: 1000001, y: 0, reach_distance: 0.75 },
    }])).toThrow()
    expect(() => parseStructuredOperations([{
      name: 'walk_to_entity_exact',
      args: { unit_number: 1, reach_distance: 0.1 },
    }])).toThrow()
  })
})
