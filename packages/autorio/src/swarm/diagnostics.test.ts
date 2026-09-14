import { describe, expect, it } from 'vitest'
import { create_work } from './blackboard'
import { audit_swarm_invariants } from './diagnostics'
import { create_empty_swarm_storage } from './storage'

describe('swarm invariant audit', () => {
  it('reports active work without a reciprocal claim', () => {
    const swarm = create_empty_swarm_storage()
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'x' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    work.status = 'active'
    expect(audit_swarm_invariants(swarm).some(issue => issue.code === 'executing_work_without_claim')).toBe(true)
  })

  it('reports duplicate logical agent and actor claim ownership', () => {
    const swarm = create_empty_swarm_storage()
    const first = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'a' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    const second = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'b' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    first.status = 'claimed'
    first.claimId = 'claim-1'
    second.status = 'claimed'
    second.claimId = 'claim-2'
    swarm.board.claims['claim-1'] = { id: 'claim-1', workId: first.id, agentId: 'agent-1', actorId: 'actor-1', actorBodyRevision: 1, acquiredTick: 1, leaseUntilTick: 100, lastProgressTick: 1, workRevision: first.revision, state: 'claimed' }
    swarm.board.claims['claim-2'] = { id: 'claim-2', workId: second.id, agentId: 'agent-1', actorId: 'actor-1', actorBodyRevision: 1, acquiredTick: 1, leaseUntilTick: 100, lastProgressTick: 1, workRevision: second.revision, state: 'claimed' }
    const issues = audit_swarm_invariants(swarm)
    expect(issues.some(issue => issue.code === 'agent_multiple_claims')).toBe(true)
    expect(issues.some(issue => issue.code === 'actor_multiple_claims')).toBe(true)
  })
})
