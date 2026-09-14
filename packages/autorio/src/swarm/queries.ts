import type {
  AgentId,
  BlackboardEvent,
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
