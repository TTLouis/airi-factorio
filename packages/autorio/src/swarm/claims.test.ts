import { describe, expect, it } from 'vitest'
import type { SwarmStorage } from './types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { create_work } from './blackboard'
import { activate_claim, claim_work, expire_claims, heartbeat_claim } from './claims'
import { create_empty_swarm_storage } from './storage'

function create_bound_agent(swarm: SwarmStorage) {
  const actorId = allocate_logical_actor_id(swarm)
  const agent = create_agent(swarm, actorId)
  return { actorId, agent }
}

describe('claim leases', () => {
  it('admits only one compare-and-swap winner', () => {
    const swarm = create_empty_swarm_storage()
    const firstOwner = create_bound_agent(swarm)
    const secondOwner = create_bound_agent(swarm)
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const revision = work.revision
    const first = claim_work(swarm, { workId: work.id, expectedRevision: revision, actor: { actorId: firstOwner.actorId, agentId: firstOwner.agent.id, available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 30 })
    const second = claim_work(swarm, { workId: work.id, expectedRevision: revision, actor: { actorId: secondOwner.actorId, agentId: secondOwner.agent.id, available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 30 })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, code: 'revision_mismatch' })
  })

  it('requires persisted agent identity and logical actor binding', () => {
    const swarm = create_empty_swarm_storage()
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    expect(claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { actorId: 'actor-missing', agentId: 'agent-missing', available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 30 })).toMatchObject({ ok: false, code: 'agent_not_found' })
    const owner = create_bound_agent(swarm)
    expect(claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { actorId: 'actor-other', agentId: owner.agent.id, available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 30 })).toMatchObject({ ok: false, code: 'actor_binding_mismatch' })
  })

  it('synchronizes persisted commitment across claim and expiry', () => {
    const swarm = create_empty_swarm_storage()
    const owner = create_bound_agent(swarm)
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { actorId: owner.actorId, agentId: owner.agent.id, available: true, capabilities: ['move'], bodyRevision: 1 }, tick: 2, leaseTicks: 5 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(owner.agent).toMatchObject({ state: 'working', currentWorkId: work.id })
    activate_claim(swarm, claimed.claim.id, 3)
    expect(expire_claims(swarm, 7)).toEqual([claimed.claim.id])
    expect(work.status).toBe('open')
    expect(owner.agent).toMatchObject({ state: 'available', currentWorkId: undefined })
  })

  it('renews only on useful progress from the claimed body generation', () => {
    const swarm = create_empty_swarm_storage()
    const owner = create_bound_agent(swarm)
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { actorId: owner.actorId, agentId: owner.agent.id, available: true, capabilities: ['move'], bodyRevision: 4 }, tick: 2, leaseTicks: 20 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    const lease = claimed.claim.leaseUntilTick
    expect(heartbeat_claim(swarm, { claimId: claimed.claim.id, tick: 3, leaseTicks: 50, bodyRevision: 4, usefulProgress: false })).toMatchObject({ ok: false, code: 'no_useful_progress' })
    expect(heartbeat_claim(swarm, { claimId: claimed.claim.id, tick: 3, leaseTicks: 50, bodyRevision: 5, usefulProgress: true })).toMatchObject({ ok: false, code: 'stale_actor_body' })
    expect(claimed.claim.leaseUntilTick).toBe(lease)
    expect(heartbeat_claim(swarm, { claimId: claimed.claim.id, tick: 4, leaseTicks: 50, bodyRevision: 4, usefulProgress: true }).ok).toBe(true)
  })
})
