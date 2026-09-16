import { describe, expect, it } from 'vitest'
import { parseStructuredOperations, renderStructuredOperation } from './operations'

describe('entity rotation structured operation', () => {
  it('defaults to clockwise and renders the exact entity identity', () => {
    const [operation] = parseStructuredOperations([
      { name: 'rotate_entity', args: { unit_number: 543 } },
    ])

    expect(operation).toEqual({
      name: 'rotate_entity',
      args: { unit_number: 543, reverse: false },
    })
    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'rotate_entity', 543, false)")
  })

  it('supports counter-clockwise rotation and rejects invalid identities', () => {
    const [operation] = parseStructuredOperations([
      { name: 'rotate_entity', args: { unit_number: 544, reverse: true } },
    ])

    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'rotate_entity', 544, true)")
    expect(() => parseStructuredOperations([{ name: 'rotate_entity', args: { unit_number: 0 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'rotate_entity', args: { unit_number: 1.5 } }])).toThrow()
  })
})
