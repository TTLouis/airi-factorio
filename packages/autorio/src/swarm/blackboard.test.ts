import { describe, expect, it } from 'vitest'
import { allocate_logical_actor_id, create_agent } from './agents'
import { complete_work_from_result, create_request, create_work, post_observation, post_result, set_request_status } from './blackboard'
import { activate_claim, claim_work, release_claim } from './claims'
import { create_empty_swarm_storage } from './storage'

describe('blackboard deterministic transitions', () => {
  it('keeps dependent work pending until its dependency completes', () => {
    const swarm = create_empty_swarm_storage()
    const first = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'first' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const second = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'second' }, requirements: { capabilities: ['move'] }, priority: 10, dependencies: [first.id], createdTick: 1 })
    expect(first.status).toBe('open')
    expect(second.status).toBe('pending_dependency')
  })

  it('reopens blocked work only after an evidenced request satisfaction', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const actor = { actorId, agentId: agent.id, available: true, capabilities: ['move'] as const, bodyRevision: 1 }
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor, tick: 2, leaseTicks: 30 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    activate_claim(swarm, claimed.claim.id, 3)
    const request = create_request(swarm, { kind: 'material_request', requester: agent.id, priority: 20, description: 'need iron', itemName: 'iron-plate', count: 5, blocksWorkIds: [work.id], createdTick: 4 })
    release_claim(swarm, { claimId: claimed.claim.id, tick: 5, reason: 'supply_shortage', blockerRequestId: request.id })
    expect(swarm.board.work[work.id].status).toBe('blocked')
    expect(set_request_status(swarm, request.id, request.revision, 'satisfied', 6)).toMatchObject({ ok: false, code: 'insufficient_evidence' })
    const observation = post_observation(swarm, { observer: agent.id, subject: 'iron delivered', evidenceClass: 'engine_read', data: { count: 5 }, observedTick: 7 })
    const evidence = [{ kind: 'observation' as const, id: observation.id, tick: 7 }]
    expect(set_request_status(swarm, request.id, request.revision, 'satisfied', 7, evidence).ok).toBe(true)
    expect(swarm.board.work[work.id].status).toBe('open')
  })

  it('requires evidence from the current claim owner to complete work and clears the commitment', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const actor = { actorId, agentId: agent.id, available: true, capabilities: ['move'] as const, bodyRevision: 1 }
    const work = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'work' }, requirements: { capabilities: ['move'] }, priority: 10, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor, tick: 2, leaseTicks: 30 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    activate_claim(swarm, claimed.claim.id, 3)
    const foreignObservation = post_observation(swarm, { observer: 'agent-2', subject: 'done', evidenceClass: 'engine_read', data: { done: true }, observedTick: 4 })
    const foreignResult = post_result(swarm, { workId: work.id, agentId: 'agent-2', status: 'success', evidence: [{ kind: 'observation', id: foreignObservation.id, tick: 4 }], summary: 'foreign result', tick: 4 })
    expect(complete_work_from_result(swarm, work.id, work.revision, foreignResult.id, 4)).toMatchObject({ ok: false, code: 'claim_owner_mismatch' })
    const ownObservation = post_observation(swarm, { observer: agent.id, subject: 'done', evidenceClass: 'engine_read', data: { done: true }, observedTick: 5 })
    const ownResult = post_result(swarm, { workId: work.id, agentId: agent.id, status: 'success', evidence: [{ kind: 'observation', id: ownObservation.id, tick: 5 }], summary: 'done', tick: 5 })
    expect(complete_work_from_result(swarm, work.id, work.revision, ownResult.id, 5).ok).toBe(true)
    expect(agent).toMatchObject({ state: 'available', currentWorkId: undefined })
  })
})
