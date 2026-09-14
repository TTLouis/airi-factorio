import { describe, expect, it } from 'vitest'
import { create_work } from './blackboard'
import { validate_work_dependency_graph } from './graphs'
import { create_empty_swarm_storage } from './storage'

describe('dependency graph validation', () => {
  it('detects cycles and missing dependencies before runtime scheduling', () => {
    const swarm = create_empty_swarm_storage()
    const a = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'a' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    const b = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'b' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    a.dependencies = [b.id, 'work-missing']
    b.dependencies = [a.id]
    const issues = validate_work_dependency_graph(swarm)
    expect(issues.some(issue => issue.code === 'cycle')).toBe(true)
    expect(issues.some(issue => issue.code === 'missing_dependency')).toBe(true)
  })
})
