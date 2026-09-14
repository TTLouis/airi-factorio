import { describe, expect, it } from 'vitest'
import { create_request, create_work, post_observation } from './blackboard'
import { new_request_coordinator } from './request_coordinator'
import { create_empty_swarm_storage } from './storage'

describe('request coordinator', () => {
  it('creates deterministic remedy work and reopens blocked work after evidence-backed satisfaction', () => {
    const swarm = create_empty_swarm_storage()
    const originalArea = { surfaceIndex: 1, position: { x: 10, y: 0 }, radius: 1.5 }
    const original = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'survey_area', subject: 'original target', area: originalArea },
      requirements: { capabilities: ['move', 'survey'] },
      location: originalArea,
      priority: 60,
      createdTick: 1,
    })
    const remedyArea = { surfaceIndex: 1, position: { x: -5, y: 0 }, radius: 1.5 }
    const request = create_request(swarm, {
      kind: 'observation_request',
      requester: 'system',
      priority: 80,
      description: 'inspect route blocker',
      destination: remedyArea,
      blocksWorkIds: [original.id],
      createdTick: 2,
    })
    expect(swarm.board.work[original.id].status).toBe('blocked')

    const coordinator = new_request_coordinator(swarm)
    const firstTick = coordinator.tick(3)
    expect(firstTick.plannedWorkIds).toHaveLength(1)
    expect(request.satisfyingWorkIds).toEqual(firstTick.plannedWorkIds)

    const remedy = swarm.board.work[firstTick.plannedWorkIds[0]]
    expect(remedy).toMatchObject({
      createdBy: 'system',
      status: 'open',
      goal: { kind: 'survey_area' },
      location: remedyArea,
    })

    const observation = post_observation(swarm, {
      observer: 'system',
      subject: 'route inspected',
      location: remedyArea,
      evidenceClass: 'measured',
      data: { clear: true },
      observedTick: 4,
    })
    remedy.status = 'completed'
    remedy.updatedTick = 4
    remedy.revision += 1
    remedy.evidence.push({ kind: 'observation', id: observation.id, tick: 4 })

    const secondTick = coordinator.tick(5)
    expect(secondTick.satisfiedRequestIds).toEqual([request.id])
    expect(swarm.board.requests[request.id].status).toBe('satisfied')
    expect(swarm.board.requests[request.id].evidence).toHaveLength(1)
    expect(swarm.board.work[original.id].status).toBe('open')
  })
})
