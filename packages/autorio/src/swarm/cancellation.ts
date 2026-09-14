import type { SimulationTick, SwarmStorage, WorkItem } from './types'
import { record_blackboard_event, set_request_status } from './blackboard'
import { release_claim } from './claims'

export type CancellationSource = 'work' | 'project' | 'mission'

export interface CancelledScopeSummary {
  source: CancellationSource
  id: string
  cancelledWorkIds: string[]
  releasedClaimIds: string[]
  cancelledRequestIds: string[]
  cancelledObjectiveIds: string[]
  cancelledProjectIds: string[]
}

function empty_summary(source: CancellationSource, id: string): CancelledScopeSummary {
  return {
    source,
    id,
    cancelledWorkIds: [],
    releasedClaimIds: [],
    cancelledRequestIds: [],
    cancelledObjectiveIds: [],
    cancelledProjectIds: [],
  }
}

function cancel_work_internal(swarm: SwarmStorage, work: WorkItem, tick: SimulationTick, releaseReason: 'mission_cancelled' | 'project_cancelled' | 'voluntary', summary: CancelledScopeSummary) {
  if (work.status === 'cancelled' || work.status === 'completed') return
  if (work.claimId && swarm.board.claims[work.claimId]) {
    const claimId = work.claimId
    const released = release_claim(swarm, { claimId, tick, reason: releaseReason })
    if (released.ok) summary.releasedClaimIds.push(claimId)
  }
  work.status = 'cancelled'
  work.claimId = undefined
  work.updatedTick = tick
  work.revision += 1
  summary.cancelledWorkIds.push(work.id)
  record_blackboard_event(swarm, {
    recordId: work.id,
    event: 'cancelled',
    tick,
    revision: work.revision,
    details: { source: summary.source, sourceId: summary.id },
  })
}

function cancel_request_if_open(swarm: SwarmStorage, requestId: string, tick: SimulationTick, summary: CancelledScopeSummary) {
  const request = swarm.board.requests[requestId]
  if (!request || request.status === 'satisfied' || request.status === 'cancelled') return
  const result = set_request_status(swarm, request.id, request.revision, 'cancelled', tick)
  if (result.ok) summary.cancelledRequestIds.push(request.id)
}

export function cancel_work(swarm: SwarmStorage, workId: string, expectedRevision: number, tick: SimulationTick) {
  const work = swarm.board.work[workId]
  if (!work) return { ok: false as const, code: 'not_found' as const }
  if (work.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: work.revision }
  if (work.status === 'completed') return { ok: false as const, code: 'already_completed' as const }
  if (work.status === 'cancelled') return { ok: true as const, summary: empty_summary('work', work.id) }

  const summary = empty_summary('work', work.id)
  cancel_work_internal(swarm, work, tick, 'voluntary', summary)
  return { ok: true as const, summary }
}

export function cancel_project(swarm: SwarmStorage, projectId: string, expectedRevision: number, tick: SimulationTick) {
  const project = swarm.projects[projectId]
  if (!project) return { ok: false as const, code: 'not_found' as const }
  if (project.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: project.revision }
  if (project.status === 'complete') return { ok: false as const, code: 'already_complete' as const }
  if (project.status === 'cancelled') return { ok: true as const, summary: empty_summary('project', project.id) }

  const summary = empty_summary('project', project.id)
  project.status = 'cancelled'
  project.revision += 1
  summary.cancelledProjectIds.push(project.id)

  for (const workId in swarm.board.work) {
    const work = swarm.board.work[workId]
    if (work.projectId === project.id) cancel_work_internal(swarm, work, tick, 'project_cancelled', summary)
  }
  for (const requestId in swarm.board.requests) {
    const request = swarm.board.requests[requestId]
    if (request.projectId === project.id) cancel_request_if_open(swarm, request.id, tick, summary)
  }
  return { ok: true as const, summary }
}

export function cancel_mission(swarm: SwarmStorage, missionId: string, expectedRevision: number, tick: SimulationTick) {
  const mission = swarm.missions[missionId]
  if (!mission) return { ok: false as const, code: 'not_found' as const }
  if (mission.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: mission.revision }
  if (mission.status === 'satisfied' || mission.status === 'failed') return { ok: false as const, code: 'terminal_mission' as const }
  if (mission.status === 'cancelled') return { ok: true as const, summary: empty_summary('mission', mission.id) }

  const summary = empty_summary('mission', mission.id)
  mission.status = 'cancelled'
  mission.updatedTick = tick
  mission.revision += 1

  for (const objectiveId in swarm.objectives) {
    const objective = swarm.objectives[objectiveId]
    if (objective.missionId !== mission.id || objective.status === 'satisfied' || objective.status === 'cancelled') continue
    objective.status = 'cancelled'
    objective.revision += 1
    summary.cancelledObjectiveIds.push(objective.id)
  }

  for (const projectId in swarm.projects) {
    const project = swarm.projects[projectId]
    if (project.missionId !== mission.id || project.status === 'complete' || project.status === 'cancelled') continue
    project.status = 'cancelled'
    project.revision += 1
    summary.cancelledProjectIds.push(project.id)
  }

  for (const workId in swarm.board.work) {
    const work = swarm.board.work[workId]
    if (work.missionId === mission.id) cancel_work_internal(swarm, work, tick, 'mission_cancelled', summary)
  }
  for (const requestId in swarm.board.requests) {
    const request = swarm.board.requests[requestId]
    if (request.missionId === mission.id) cancel_request_if_open(swarm, request.id, tick, summary)
  }
  return { ok: true as const, summary }
}
