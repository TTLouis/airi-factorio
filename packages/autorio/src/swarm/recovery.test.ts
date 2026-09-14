import { describe, expect, it } from 'vitest'
import { create_agent } from './agents'
import { create_work } from './blackboard'
import { claim_work } from './claims'
import { plan_swarm_reconciliation } from './recovery'
import { create_empty_swarm_storage } from './storage'

describe('swarm recovery planning', () => {
  it('plans release when the physical body generation changed without mutating storage', () => {
    const swarm = create_empty_swarm_storage()
    create_agent(swarm, 'actor-1')
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'x' }, requirements: { capabilities: ['move'] }, priority: 1, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { agentId: 'agent-1', actorId: 'actor-1', bodyRevision: 2, available: true, capabilities: ['move'] }, tick: 2, leaseTicks: 100 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    const actions = plan_swarm_reconciliation(swarm, [{ agentId: 'agent-1', actorId: 'actor-1', bodyRevision: 3, available: true }], 3)
    expect(actions.some(action => action.kind === 'release_claim' && action.reason === 'body_revision_changed')).toBe(true)
    expect(swarm.board.claims[claimed.claim.id]).toBe(claimed.claim)
  })
})
