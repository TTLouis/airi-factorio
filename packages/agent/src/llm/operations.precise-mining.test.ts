import { describe, expect, it } from 'vitest'
import { parseStructuredOperations, renderStructuredOperation } from './operations'

describe('precise mining structured operations', () => {
  it('validates and renders exact entity mining', () => {
    const [operation] = parseStructuredOperations([
      { name: 'mine_entity_exact', args: { unit_number: 4242 } },
    ])

    expect(operation).toEqual({ name: 'mine_entity_exact', args: { unit_number: 4242 } })
    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'mine_entity_exact', 4242)")
    expect(() => parseStructuredOperations([{ name: 'mine_entity_exact', args: { unit_number: 0 } }])).toThrow()
  })

  it('validates and renders exact resource-position mining', () => {
    const [operation] = parseStructuredOperations([
      { name: 'mine_resource_at', args: { resource_name: 'coal', x: 23.5, y: 68.5 } },
    ])

    expect(operation).toEqual({
      name: 'mine_resource_at',
      args: { resource_name: 'coal', x: 23.5, y: 68.5, count: 1 },
    })
    expect(renderStructuredOperation(operation)).toBe("remote.call('autorio_operations', 'mine_resource_at', 'coal', 23.5, 68.5, 1)")
    expect(() => parseStructuredOperations([{ name: 'mine_resource_at', args: { resource_name: 'coal', x: 1000001, y: 0 } }])).toThrow()
    expect(() => parseStructuredOperations([{ name: 'mine_resource_at', args: { resource_name: 'coal', x: 0, y: 0, count: 1001 } }])).toThrow()
  })
})
