import { describe, expect, it } from 'vitest'
import { create_work } from './blackboard'
import { activate_claim, claim_work, expire_claims, heartbeat_claim } from './claims'
import { create_empty_swarm_storage } from './storage'

describe('claim leases', () => {
  it('admits only one compare-and-swap winner', () => {
    const swarm = create_empty_swarm_storage()
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const revision = work.revision
    const first = claim_work(swarm, { workId: work.id, expectedRevision: revision, actor: { actorId: 'actor-1', agentId: 'agent-1', available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 30 })
    const second = claim_work(swarm, { workId: work.id, expectedRevision: revision, actor: { actorId: 'actor-2', agentId: 'agent-2', available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 30 })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, code: 'revision_mismatch' })
  })

  it('prevents one agent from holding two simultaneous work claims', () => {
    const swarm = create_empty_swarm_storage()
    const first = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'first' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const second = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'second' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const actor = { actorId: 'actor-1', agentId: 'agent-1', available: true, capabilities: ['move'] as const, bodyRevision: 1 }
    expect(claim_work(swarm, { workId: first.id, expectedRevision: first.revision, actor: { ...actor, capabilities: ['move'] }, tick: 2, leaseTicks: 30 }).ok).toBe(true)
    expect(claim_work(swarm, { workId: second.id, expectedRevision: second.revision, actor: { ...actor, capabilities: ['move'] }, tick: 3, leaseTicks: 30 })).toMatchObject({ ok: false, code: 'agent_already_committed' })
  })

  it('renews only on useful progress from the claimed body generation', () => {
    const swarm = create_empty_swarm_storage()
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { actorId: 'actor-1', agentId: 'agent-1', available: true, capabilities: ['move'], bodyRevision: 4 }, tick: 2, leaseTicks: 20 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    const lease = claimed.claim.leaseUntilTick
    expect(heartbeat_claim(swarm, { claimId: claimed.claim.id, tick: 3, leaseTicks: 50, bodyRevision: 4, usefulProgress: false })).toMatchObject({ ok: false, code: 'no_useful_progress' })
    expect(heartbeat_claim(swarm, { claimId: claimed.claim.id, tick: 3, leaseTicks: 50, bodyRevision: 5, usefulProgress: true })).toMatchObject({ ok: false, code: 'stale_actor_body' })
    expect(claimed.claim.leaseUntilTick).toBe(lease)
    expect(heartbeat_claim(swarm, { claimId: claimed.claim.id, tick: 4, leaseTicks: 50, bodyRevision: 4, usefulProgress: true }).ok).toBe(true)
  })

  it('returns expired unblocked work to the pool', () => {
    const swarm = create_empty_swarm_storage()
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { actorId: 'actor-1', agentId: 'agent-1', available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 5 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    activate_claim(swarm, claimed.claim.id, 3)
    expect(expire_claims(swarm, 7)).toEqual([claimed.claim.id])
    expect(swarm.board.work[work.id].status).toBe('open')
  })
})
