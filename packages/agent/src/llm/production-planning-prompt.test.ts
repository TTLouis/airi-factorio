import { describe, expect, it } from 'vitest'
import prompt from './production-planning-prompt.md?raw'

describe('production planning prompt contract', () => {
  it('requires deterministic solving and forbids unvalidated transport throughput guesses', () => {
    expect(prompt).toContain('Use `solveProduction` for production-rate planning')
    expect(prompt).toContain('Do not replace a rejected deterministic result with guessed arithmetic')
    expect(prompt).toContain('does **not** yet validate inserter throughput, belt-lane capacity, stacked-belt capacity')
    expect(prompt).toContain('report transport throughput as unverified rather than guessing it')
  })
})
