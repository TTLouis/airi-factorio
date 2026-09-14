import { describe, expect, it } from 'vitest'
import { create_agent } from './agents'
import { create_request, create_work } from './blackboard'
import { cancel_mission, cancel_project } from './cancellation'
import { claim_work } from './claims'
import { create_mission, create_objective, create_project } from './missions'
import { create_empty_swarm_storage } from './storage'

describe('scope cancellation', () => {
  it('releases claims, clears the agent commitment, and cancels mission scope without a model turn', () => {
    const swarm = create_empty_swarm_storage()
    const agent = create_agent(swarm, 'actor-1')
    const mission = create_mission(swarm, { title: 'm', priority: 50, goal: 'g', createdBy: 'human', tick: 1 })
    const work = create_work(swarm, { missionId: mission.id, createdBy: 'system', goal: { kind: 'custom', description: 'x' }, requirements: { capabilities: ['move'] }, priority: 50, createdTick: 1 })
    const claimed = claim_work(swarm, { workId: work.id, expectedRevision: work.revision, actor: { agentId: agent.id, actorId: 'actor-1', bodyRevision: 1, available: true, capabilities: ['move'] }, tick: 2, leaseTicks: 100 })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(cancel_mission(swarm, mission.id, mission.revision, 3).ok).toBe(true)
    expect(work.status).toBe('cancelled')
    expect(swarm.board.claims[claimed.claim.id]).toBe(undefined)
    expect(agent).toMatchObject({ state: 'available', currentWorkId: undefined })
  })

  it('cancels only the selected project scope and preserves unrelated project work', () => {
    const swarm = create_empty_swarm_storage()
    const mission = create_mission(swarm, { title: 'm', priority: 50, goal: 'g', createdBy: 'human', tick: 1 })
    const objective = create_objective(swarm, { missionId: mission.id, description: 'o' })
    expect(objective.ok).toBe(true)
    if (!objective.ok) return
    const first = create_project(swarm, { missionId: mission.id, objectiveId: objective.objective.id, title: 'first', scope: { description: 'a' } })
    const second = create_project(swarm, { missionId: mission.id, objectiveId: objective.objective.id, title: 'second', scope: { description: 'b' } })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const firstWork = create_work(swarm, { missionId: mission.id, projectId: first.project.id, createdBy: 'system', goal: { kind: 'custom', description: 'first' }, requirements: { capabilities: [] }, priority: 50, createdTick: 1 })
    const secondWork = create_work(swarm, { missionId: mission.id, projectId: second.project.id, createdBy: 'system', goal: { kind: 'custom', description: 'second' }, requirements: { capabilities: [] }, priority: 50, createdTick: 1 })
    create_request(swarm, { kind: 'material_request', requester: 'system', missionId: mission.id, projectId: first.project.id, priority: 50, description: 'parts', blocksWorkIds: [firstWork.id], createdTick: 2 })
    expect(cancel_project(swarm, first.project.id, first.project.revision, 3).ok).toBe(true)
    expect(firstWork.status).toBe('cancelled')
    expect(secondWork.status).toBe('open')
  })
})
