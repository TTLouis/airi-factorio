import { create_work, record_blackboard_event, set_request_status } from './blackboard'
import { derive_request_work_proposal } from './request-planning'
import type { RequestId, SimulationTick, SwarmStorage, WorkId } from './types'

function has_live_satisfying_work(swarm: SwarmStorage, requestId: RequestId) {
  const request = swarm.board.requests[requestId]
  if (request === undefined) return false
  for (const workId of request.satisfyingWorkIds) {
    const work = swarm.board.work[workId]
    if (work !== undefined && work.status !== 'completed' && work.status !== 'cancelled') return true
  }
  return false
}

function completed_satisfying_work(swarm: SwarmStorage, requestId: RequestId) {
  const request = swarm.board.requests[requestId]
  if (request === undefined) return undefined
  for (const workId of request.satisfyingWorkIds) {
    const work = swarm.board.work[workId]
    if (work !== undefined && work.status === 'completed' && work.evidence.length > 0) return work
  }
  return undefined
}

export function new_request_coordinator(swarm: SwarmStorage) {
  function satisfy_completed_requests(tick: SimulationTick) {
    const satisfied: RequestId[] = []
    const ids: RequestId[] = []
    for (const id in swarm.board.requests) ids.push(id)
    ids.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)

    for (const requestId of ids) {
      const request = swarm.board.requests[requestId]
      if (request.status !== 'open') continue
      const work = completed_satisfying_work(swarm, requestId)
      if (work === undefined) continue
      const result = set_request_status(
        swarm,
        request.id,
        request.revision,
        'satisfied',
        tick,
        [...work.evidence],
      )
      if (result.ok) satisfied.push(request.id)
    }
    return satisfied
  }

  function plan_open_requests(tick: SimulationTick) {
    const plannedWorkIds: WorkId[] = []
    const plannerRequiredRequestIds: RequestId[] = []
    const invalidRequestIds: RequestId[] = []
    const ids: RequestId[] = []
    for (const id in swarm.board.requests) ids.push(id)
    ids.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)

    for (const requestId of ids) {
      const request = swarm.board.requests[requestId]
      if (request.status !== 'open') continue
      if (completed_satisfying_work(swarm, requestId) !== undefined) continue
      if (has_live_satisfying_work(swarm, requestId)) continue

      const planning = derive_request_work_proposal(request)
      if (planning.kind === 'planner_required') {
        plannerRequiredRequestIds.push(request.id)
        continue
      }
      if (planning.kind === 'invalid_request') {
        invalidRequestIds.push(request.id)
        continue
      }
      if (planning.kind !== 'proposal') continue

      const work = create_work(swarm, {
        missionId: planning.proposal.missionId,
        objectiveId: planning.proposal.objectiveId,
        projectId: planning.proposal.projectId,
        createdBy: 'system',
        goal: planning.proposal.goal,
        requirements: planning.proposal.requirements,
        location: planning.proposal.location,
        priority: planning.proposal.priority,
        createdTick: tick,
      })
      request.satisfyingWorkIds.push(work.id)
      request.updatedTick = tick
      request.revision += 1
      record_blackboard_event(swarm, {
        recordId: request.id,
        event: 'updated',
        tick,
        revision: request.revision,
        details: { satisfyingWorkId: work.id },
      })
      plannedWorkIds.push(work.id)
    }

    return { plannedWorkIds, plannerRequiredRequestIds, invalidRequestIds }
  }

  function tick(tick: SimulationTick) {
    const satisfiedRequestIds = satisfy_completed_requests(tick)
    const planned = plan_open_requests(tick)
    return {
      satisfiedRequestIds,
      ...planned,
    }
  }

  return {
    tick,
    satisfy_completed_requests,
    plan_open_requests,
  }
}
