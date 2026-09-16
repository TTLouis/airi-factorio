import { describe, expect, it } from 'vitest'
import productionPlanningPrompt from './production-planning-prompt.md?raw'

describe('direction and orientation prompt contract', () => {
  it('exposes low-level orientation primitives without encoding a layout solver', () => {
    expect(productionPlanningPrompt).toContain('`direction`, `supports_direction`, and `rotatable`')
    expect(productionPlanningPrompt).toContain('"direction"?: integer')
    expect(productionPlanningPrompt).toContain('`rotate_entity`')
    expect(productionPlanningPrompt).toContain('"unit_number": integer, "reverse": boolean')
    expect(productionPlanningPrompt).toContain('runtime `drop_position`, `drop_target`, `pickup_position`, and `pickup_target`')
    expect(productionPlanningPrompt).toContain('not layout solvers')
    expect(productionPlanningPrompt).not.toContain('solveMutualBurnerMinerPlacement')
  })
})
