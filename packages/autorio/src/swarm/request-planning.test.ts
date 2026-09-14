import { describe, expect, it } from 'vitest'
import { create_request } from './blackboard'
import { derive_request_work_proposal } from './request-planning'
import { create_empty_swarm_storage } from './storage'

describe('request work proposal derivation', () => {
  it('derives deterministic observation work from structured destination data', () => {
    const swarm = create_empty_swarm_storage()
    const destination = { surfaceIndex: 1, position: { x: 4, y: -2 }, radius: 3 }
    const request = create_request(swarm, {
      kind: 'observation_request',
      requester: 'system',
      priority: 70,
      description: 'inspect blocked route',
      destination,
      createdTick: 1,
    })

    expect(derive_request_work_proposal(request)).toEqual({
      kind: 'proposal',
      proposal: {
        sourceRequestId: request.id,
        missionId: undefined,
        objectiveId: undefined,
        projectId: undefined,
        goal: { kind: 'survey_area', subject: 'inspect blocked route', area: destination },
        requirements: { capabilities: ['move', 'survey'] },
        location: destination,
        priority: 70,
      },
    })
  })

  it('does not invent a capacity remedy', () => {
    const swarm = create_empty_swarm_storage()
    const request = create_request(swarm, {
      kind: 'capacity_request',
      requester: 'system',
      priority: 70,
      description: 'need +15 iron/s',
      itemName: 'iron-plate',
      ratePerSecond: 15,
      createdTick: 1,
    })
    expect(derive_request_work_proposal(request)).toEqual({ kind: 'planner_required', reason: 'ambiguous_remedy' })
  })
})
