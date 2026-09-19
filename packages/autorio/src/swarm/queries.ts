import type {
  AgentId,
  BlackboardEvent,
  EvidenceRef,
  MissionId,
  ProjectId,
  RequestRecord,
  SwarmStorage,
  WarningRecord,
  WorkItem,
  WorkStatus,
} from './types'

export const MAX_BOARD_QUERY_ITEMS = 128

function bounded_limit(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback
  if (value < 1) return 1
  if (value > MAX_BOARD_QUERY_ITEMS) return MAX_BOARD_QUERY_ITEMS
  return value
}

export interface WorkQuery {
  statuses?: WorkStatus[]
  missionId?: MissionId
  projectId?: ProjectId
  limit?: number
}

function status_matches(statuses: WorkStatus[] | undefined, status: WorkStatus) {
  if (!statuses || statuses.length === 0) return true
  for (const candidate of statuses) if (candidate === status) return true
  return false
}

export function query_work(swarm: SwarmStorage, query: WorkQuery = {}) {
  const result: WorkItem[] = []
  for (const id in swarm.board.work) {
    const work = swarm.board.work[id]
    if (!status_matches(query.statuses, work.status)) continue
    if (query.missionId && work.missionId !== query.missionId) continue
    if (query.projectId && work.projectId !== query.projectId) continue
    result.push(work)
  }
  result.sort((a, b) => b.priority - a.priority || a.createdTick - b.createdTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result.slice(0, bounded_limit(query.limit, 32))
}

export interface RequestQuery {
  status?: RequestRecord['status']
  missionId?: MissionId
  projectId?: ProjectId
  limit?: number
}

export function query_requests(swarm: SwarmStorage, query: RequestQuery = {}) {
  const result: RequestRecord[] = []
  for (const id in swarm.board.requests) {
    const request = swarm.board.requests[id]
    if (query.status && request.status !== query.status) continue
    if (query.missionId && request.missionId !== query.missionId) continue
    if (query.projectId && request.projectId !== query.projectId) continue
    result.push(request)
  }
  result.sort((a, b) => b.priority - a.priority || a.createdTick - b.createdTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result.slice(0, bounded_limit(query.limit, 32))
}

export interface WarningQuery {
  activeOnly?: boolean
  missionId?: MissionId
  projectId?: ProjectId
  minimumSeverity?: number
  limit?: number
}

export function query_warnings(swarm: SwarmStorage, query: WarningQuery = {}) {
  const result: WarningRecord[] = []
  for (const id in swarm.board.warnings) {
    const warning = swarm.board.warnings[id]
    if (query.activeOnly !== false && !warning.active) continue
    if (query.missionId && warning.missionId !== query.missionId) continue
    if (query.projectId && warning.projectId !== query.projectId) continue
    if (query.minimumSeverity !== undefined && warning.severity < query.minimumSeverity) continue
    result.push(warning)
  }
  result.sort((a, b) => b.severity - a.severity || a.createdTick - b.createdTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result.slice(0, bounded_limit(query.limit, 32))
}

export interface EventQuery {
  afterEventId?: string
  recordId?: string
  agentId?: AgentId
  minimumTick?: number
  limit?: number
}

export interface EventQueryResult {
  events: BlackboardEvent[]
  cursorLost: boolean
  oldestRetainedEventId?: string
  newestRetainedEventId?: string
  nextCursor?: string
}

export function query_blackboard_events(swarm: SwarmStorage, query: EventQuery = {}): EventQueryResult {
  const retained = swarm.board.events
  let startIndex = 0
  let cursorLost = false
  if (query.afterEventId) {
    let found = false
    for (let i = 0; i < retained.length; i++) {
      if (retained[i].id === query.afterEventId) {
        startIndex = i + 1
        found = true
        break
      }
    }
    if (!found) cursorLost = true
  }

  const events: BlackboardEvent[] = []
  const limit = bounded_limit(query.limit, 64)
  for (let i = startIndex; i < retained.length && events.length < limit; i++) {
    const event = retained[i]
    if (query.recordId && event.recordId !== query.recordId) continue
    if (query.agentId && event.agentId !== query.agentId) continue
    if (query.minimumTick !== undefined && event.tick < query.minimumTick) continue
    events.push(event)
  }

  return {
    events,
    cursorLost,
    oldestRetainedEventId: retained.length > 0 ? retained[0].id : undefined,
    newestRetainedEventId: retained.length > 0 ? retained[retained.length - 1].id : undefined,
    nextCursor: events.length > 0 ? events[events.length - 1].id : query.afterEventId,
  }
}

export interface MessageBoardSnapshot {
  counts: {
    openWork: number
    executingWork: number
    blockedWork: number
    openRequests: number
    activeWarnings: number
    activeClaims: number
  }
  work: WorkItem[]
  requests: RequestRecord[]
  warnings: WarningRecord[]
  latestEvents: BlackboardEvent[]
}

export function build_message_board_snapshot(swarm: SwarmStorage, limit = 12): MessageBoardSnapshot {
  let openWork = 0
  let executingWork = 0
  let blockedWork = 0
  let openRequests = 0
  let activeWarnings = 0
  let activeClaims = 0

  for (const id in swarm.board.work) {
    const work = swarm.board.work[id]
    if (work.status === 'open') openWork += 1
    else if (work.status === 'claimed' || work.status === 'active') executingWork += 1
    else if (work.status === 'blocked' || work.status === 'pending_dependency') blockedWork += 1
  }
  for (const id in swarm.board.requests) if (swarm.board.requests[id].status === 'open') openRequests += 1
  for (const id in swarm.board.warnings) if (swarm.board.warnings[id].active) activeWarnings += 1
  for (const id in swarm.board.claims) if (swarm.board.claims[id]) activeClaims += 1

  const latestEvents: BlackboardEvent[] = []
  const bounded = bounded_limit(limit, 12)
  const first = swarm.board.events.length > bounded ? swarm.board.events.length - bounded : 0
  for (let i = first; i < swarm.board.events.length; i++) latestEvents.push(swarm.board.events[i])

  return {
    counts: { openWork, executingWork, blockedWork, openRequests, activeWarnings, activeClaims },
    work: query_work(swarm, { statuses: ['open', 'claimed', 'active', 'blocked', 'pending_dependency'], limit: bounded }),
    requests: query_requests(swarm, { status: 'open', limit: bounded }),
    warnings: query_warnings(swarm, { activeOnly: true, limit: bounded }),
    latestEvents,
  }
}


function clone_evidence(refs: EvidenceRef[]) {
  return refs.map(ref => ({
    kind: ref.kind,
    id: ref.id,
    tick: ref.tick,
    revision: ref.revision,
  }))
}


function clone_location(location: { surfaceIndex: number, position: { x: number, y: number }, radius?: number } | undefined) {
  return location
    ? {
        surfaceIndex: location.surfaceIndex,
        position: { x: location.position.x, y: location.position.y },
        radius: location.radius,
      }
    : undefined
}

function clone_acceptance(acceptance: SwarmStorage['missions'][string]['acceptance']) {
  return acceptance.map(condition => ({
    ...condition,
    location: clone_location(condition.location),
  }))
}

function clone_work_goal(goal: SwarmStorage['board']['work'][string]['goal']) {
  if (goal.kind === 'acquire_items') return { ...goal, source: clone_location(goal.source) }
  if (goal.kind === 'deliver_items') return { ...goal, destination: clone_location(goal.destination)! }
  if (goal.kind === 'gather_resource') return { ...goal, source: clone_location(goal.source)! }
  if (goal.kind === 'survey_area') return { ...goal, area: clone_location(goal.area)! }
  if (goal.kind === 'defend_area' || goal.kind === 'repair_area') return { ...goal, area: clone_location(goal.area)! }
  return { ...goal }
}

function bounded_sorted_ids<T extends { id: string }>(records: Record<string, T>, limit: number) {
  const values: T[] = []
  for (const id in records) values.push(records[id])
  values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return values.slice(0, bounded_limit(limit, 12))
}

function clone_acceptance_state(state: Record<string, { conditionId: string, satisfied: boolean, evidence: EvidenceRef[], tick: number }>) {
  const copy: Record<string, { conditionId: string, satisfied: boolean, evidence: ReturnType<typeof clone_evidence>, tick: number }> = {}
  for (const id in state) {
    const evaluation = state[id]
    copy[id] = {
      conditionId: evaluation.conditionId,
      satisfied: evaluation.satisfied,
      evidence: clone_evidence(evaluation.evidence),
      tick: evaluation.tick,
    }
  }
  return copy
}

function clone_blockers(blockers: SwarmStorage['missions'][string]['blockers']) {
  return blockers.map((blocker) => {
    if (blocker.kind === 'custom') return { kind: blocker.kind, description: blocker.description }
    return { kind: blocker.kind, id: blocker.id }
  })
}

/**
 * Bounded canonical projection for external strategic/diagnostic control planes.
 *
 * This is intentionally not a raw SwarmStorage dump. It exposes durable
 * coordination facts while omitting the unbounded event history and volatile
 * runtime-controller internals.
 */
export function build_swarm_coordination_snapshot(swarm: SwarmStorage, tick: number, limit = 12) {
  const bounded = bounded_limit(limit, 12)
  const missions = bounded_sorted_ids(swarm.missions, bounded).map(mission => ({
    id: mission.id,
    title: mission.title,
    status: mission.status,
    priority: mission.priority,
    goal: mission.goal,
    acceptance: clone_acceptance(mission.acceptance),
    acceptanceState: clone_acceptance_state(mission.acceptanceState),
    objectiveIds: [...mission.objectiveIds],
    blockers: clone_blockers(mission.blockers),
    createdTick: mission.createdTick,
    updatedTick: mission.updatedTick,
    revision: mission.revision,
  }))
  const objectives = bounded_sorted_ids(swarm.objectives, bounded).map(objective => ({
    id: objective.id,
    missionId: objective.missionId,
    description: objective.description,
    status: objective.status,
    dependencies: [...objective.dependencies],
    acceptance: clone_acceptance(objective.acceptance),
    acceptanceState: clone_acceptance_state(objective.acceptanceState),
    evidence: clone_evidence(objective.evidence),
    projectIds: [...objective.projectIds],
    priority: objective.priority,
    revision: objective.revision,
  }))
  const projects = bounded_sorted_ids(swarm.projects, bounded).map(project => ({
    id: project.id,
    missionId: project.missionId,
    objectiveId: project.objectiveId,
    title: project.title,
    status: project.status,
    scope: {
      description: project.scope.description,
      allowedArea: clone_location(project.scope.allowedArea),
      authorityTags: project.scope.authorityTags ? [...project.scope.authorityTags] : undefined,
    },
    revision: project.revision,
    workItemIds: [...project.workItemIds],
    reservationIds: [...project.reservationIds],
    evidence: clone_evidence(project.evidence),
    blockers: clone_blockers(project.blockers),
  }))

  const board = build_message_board_snapshot(swarm, bounded)
  const work = board.work.map(item => ({
    id: item.id,
    missionId: item.missionId,
    objectiveId: item.objectiveId,
    projectId: item.projectId,
    goal: clone_work_goal(item.goal),
    priority: item.priority,
    status: item.status,
    dependencies: [...item.dependencies],
    blockingRequests: [...item.blockingRequests],
    claimId: item.claimId,
    evidence: clone_evidence(item.evidence),
    createdTick: item.createdTick,
    updatedTick: item.updatedTick,
    revision: item.revision,
  }))
  const requests = board.requests.map(request => ({
    id: request.id,
    kind: request.kind,
    requester: request.requester,
    missionId: request.missionId,
    objectiveId: request.objectiveId,
    projectId: request.projectId,
    priority: request.priority,
    status: request.status,
    description: request.description,
    itemName: request.itemName,
    count: request.count,
    ratePerSecond: request.ratePerSecond,
    destination: clone_location(request.destination),
    blocksWorkIds: [...request.blocksWorkIds],
    satisfyingWorkIds: [...request.satisfyingWorkIds],
    evidence: clone_evidence(request.evidence),
    createdTick: request.createdTick,
    updatedTick: request.updatedTick,
    revision: request.revision,
  }))
  const warnings = board.warnings.map(warning => ({
    id: warning.id,
    kind: warning.kind,
    source: warning.source,
    severity: warning.severity,
    description: warning.description,
    missionId: warning.missionId,
    projectId: warning.projectId,
    workId: warning.workId,
    location: clone_location(warning.location),
    active: warning.active,
    createdTick: warning.createdTick,
    resolvedTick: warning.resolvedTick,
    evidence: clone_evidence(warning.evidence),
  }))
  const claims = bounded_sorted_ids(swarm.board.claims, bounded).map(claim => ({
    id: claim.id,
    workId: claim.workId,
    agentId: claim.agentId,
    actorId: claim.actorId,
    actorBodyRevision: claim.actorBodyRevision,
    acquiredTick: claim.acquiredTick,
    leaseUntilTick: claim.leaseUntilTick,
    lastProgressTick: claim.lastProgressTick,
    workRevision: claim.workRevision,
    state: claim.state,
    progress: claim.progress
      ? {
          summary: claim.progress.summary,
          evidence: claim.progress.evidence ? clone_evidence(claim.progress.evidence) : undefined,
        }
      : undefined,
  }))

  const results = bounded_sorted_ids(swarm.board.results, bounded).map(result => ({
    id: result.id,
    workId: result.workId,
    agentId: result.agentId,
    status: result.status,
    evidence: clone_evidence(result.evidence),
    summary: result.summary,
    tick: result.tick,
  }))
  const agents = bounded_sorted_ids(swarm.agents, bounded).map(agent => ({
    id: agent.id,
    actorId: agent.actorId,
    state: agent.state,
    currentWorkId: agent.currentWorkId,
    currentProjectId: agent.currentProjectId,
    currentMissionId: agent.currentMissionId,
    activeRequestIds: [...agent.activeRequestIds],
    lastDecisionTick: agent.lastDecisionTick,
    revision: agent.revision,
  }))
  const actors = bounded_sorted_ids(swarm.actors, bounded).map(actor => ({
    id: actor.id,
    state: actor.state,
    bodyRevision: actor.bodyRevision,
    physical: actor.physical
      ? {
          physicalActorId: actor.physical.physicalActorId,
          kind: actor.physical.kind,
          forceIndex: actor.physical.forceIndex,
          surfaceIndex: actor.physical.surfaceIndex,
        }
      : undefined,
    lastSeenTick: actor.lastSeenTick,
    missingSinceTick: actor.missingSinceTick,
    revision: actor.revision,
  }))

  let missionCount = 0
  let objectiveCount = 0
  let projectCount = 0
  let workCount = 0
  let requestCount = 0
  let claimCount = 0
  let resultCount = 0
  let agentCount = 0
  let actorCount = 0
  for (const unused in swarm.missions) missionCount += 1
  for (const unused in swarm.objectives) objectiveCount += 1
  for (const unused in swarm.projects) projectCount += 1
  for (const unused in swarm.board.work) workCount += 1
  for (const unused in swarm.board.requests) requestCount += 1
  for (const unused in swarm.board.claims) claimCount += 1
  for (const unused in swarm.board.results) resultCount += 1
  for (const unused in swarm.agents) agentCount += 1
  for (const unused in swarm.actors) actorCount += 1

  return {
    schema: 'swarm_coordination_snapshot_v1' as const,
    tick,
    limit: bounded,
    counts: {
      missions: missionCount,
      objectives: objectiveCount,
      projects: projectCount,
      work: workCount,
      requests: requestCount,
      claims: claimCount,
      results: resultCount,
      agents: agentCount,
      actors: actorCount,
      activeWarnings: board.counts.activeWarnings,
    },
    missions,
    objectives,
    projects,
    work,
    requests,
    warnings,
    claims,
    results,
    agents,
    actors,
  }
}
