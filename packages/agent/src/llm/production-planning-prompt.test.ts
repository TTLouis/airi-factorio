import { describe, expect, it } from 'vitest'
import prompt from './production-planning-prompt.md?raw'

describe('production planning prompt contract', () => {
  it('requires deterministic solving and forbids unvalidated transport throughput guesses', () => {
    expect(prompt).toContain('Use `solveProduction` for production-rate planning')
    expect(prompt).toContain('Do not replace a rejected deterministic result with guessed arithmetic')
    expect(prompt).toContain('Use `getTransportCapacity` when a production design depends on belt transport')
    expect(prompt).toContain('stacked-belt result is only the belt\'s transport ceiling')
    expect(prompt).toContain('prefer `kind: "inserter_instance"` with its exact Factorio `unit_number`')
    expect(prompt).toContain('Both inserter forms deliberately keep `transfer_rate.validated` false')
    expect(prompt).toContain('Never turn hand size, target pickup count, rotation speed, or extension speed into a guessed fixed throughput')
  })
})
