import { describe, expect, it } from 'vitest'
import { allocate_logical_actor_id, create_agent } from './agents'
import { create_work } from './blackboard'
import { claim_work } from './claims'
import { rank_work_candidates, should_switch_work } from './selection'
import { create_empty_swarm_storage } from './storage'

describe('deterministic work selection', () => {
  it('filters capability/reachability and exposes score factors', () => {
    const swarm = create_empty_swarm_storage()
    const near = create_work(swarm, { createdBy: 'system', goal: { kind: 'deliver_items', itemName: 'belt', count: 20, destination: { surfaceIndex: 1, position: { x: 5, y: 0 } } }, requirements: { capabilities: ['move', 'transfer'] }, location: { surfaceIndex: 1, position: { x: 5, y: 0 } }, priority: 50, createdTick: 1 })
    const unreachable = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'far' }, requirements: { capabilities: ['move'] }, priority: 80, createdTick: 1 })
    create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'combat' }, requirements: { capabilities: ['combat'] }, priority: 99, createdTick: 1 })
    const scores = rank_work_candidates(swarm, { agentId: 'agent-1', actorId: 'actor-1', capabilities: ['move', 'transfer'], location: { surfaceIndex: 1, position: { x: 0, y: 0 } }, inventory: { belt: 20 } }, { reachable: { [unreachable.id]: false } })
    expect(scores).toHaveLength(1)
    expect(scores[0].workId).toBe(near.id)
    expect(scores[0].factors.inventoryFit).toBeGreaterThan(0)
    expect(scores[0].factors.locality).toBeGreaterThan(0)
  })

  it('scores the actors own active claim for continuity but never another actors claim', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const current = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'current' }, requirements: { capabilities: ['move'] }, priority: 50, createdTick: 1 })
    const other = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'other' }, requirements: { capabilities: ['move'] }, priority: 60, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: current.id, expectedRevision: current.revision, actor: { agentId: agent.id, actorId, bodyRevision: 1, available: true, capabilities: ['move'] }, tick: 2, leaseTicks: 100 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    other.status = 'claimed'
    other.claimId = 'foreign-claim'
    swarm.board.claims['foreign-claim'] = { id: 'foreign-claim', workId: other.id, agentId: 'agent-2', actorId: 'actor-2', actorBodyRevision: 1, acquiredTick: 2, leaseUntilTick: 100, lastProgressTick: 2, workRevision: other.revision, state: 'claimed' }
    const scores = rank_work_candidates(swarm, { agentId: agent.id, actorId, capabilities: ['move'], location: { surfaceIndex: 1, position: { x: 0, y: 0 } }, inventory: {}, currentWorkId: current.id })
    expect(scores).toHaveLength(1)
    expect(scores[0].workId).toBe(current.id)
    expect(scores[0].factors.continuity).toBeGreaterThan(0)
  })

  it('uses hysteresis for voluntary switches but permits emergency priority', () => {
    const candidate = { workId: 'work-2', finalScore: 107, factors: { priority: 70, locality: 10, inventoryFit: 10, continuity: 0, dependencyValue: 5, switchingPenalty: 8, riskPenalty: 0 } }
    expect(should_switch_work(100, candidate, 70)).toBe(false)
    expect(should_switch_work(100, { ...candidate, finalScore: 111 }, 70)).toBe(true)
    expect(should_switch_work(100, { ...candidate, finalScore: 80 }, 95)).toBe(true)
  })
})
