import type {
  AgentId,
  BlackboardEvent,
  EvidenceRef,
  ObservationRecord,
  RequestRecord,
  RequestStatus,
  SimulationTick,
  SwarmStorage,
  WarningRecord,
  WorkGoal,
  WorkItem,
  WorkRequirements,
  WorkResult,
  WorldLocation,
} from './types'
import { clear_agent_commitment_for_work } from './agents'
import { allocate_swarm_id } from './storage'

export const MAX_BLACKBOARD_EVENTS = 512

export function record_blackboard_event(swarm: SwarmStorage, event: Omit<BlackboardEvent, 'id'>) {
  const record: BlackboardEvent = {
    id: allocate_swarm_id('event', swarm),
    ...event,
  }
  swarm.board.events.push(record)
  if (swarm.board.events.length > MAX_BLACKBOARD_EVENTS) swarm.board.events.shift()
  return record
}

function dependencies_satisfied(swarm: SwarmStorage, work: WorkItem) {
  for (const dependencyId of work.dependencies) if (swarm.board.work[dependencyId]?.status !== 'completed') return false
  return true
}

function blockers_satisfied(swarm: SwarmStorage, work: WorkItem) {
  for (const requestId of work.blockingRequests) if (swarm.board.requests[requestId]?.status !== 'satisfied') return false
  return true
}

export function refresh_work_eligibility(swarm: SwarmStorage, workId: string, tick: SimulationTick) {
  const work = swarm.board.work[workId]
  if (!work || work.status === 'completed' || work.status === 'cancelled' || work.status === 'claimed' || work.status === 'active') return work
  let next = work.status
  if (!dependencies_satisfied(swarm, work)) next = 'pending_dependency'
  else if (!blockers_satisfied(swarm, work)) next = 'blocked'
  else next = 'open'
  if (next !== work.status) {
    work.status = next
    work.updatedTick = tick
    work.revision += 1
    record_blackboard_event(swarm, { recordId: work.id, event: next === 'blocked' ? 'blocked' : 'updated', tick, revision: work.revision })
  }
  return work
}

export interface CreateWorkInput {
  missionId?: string
  objectiveId?: string
  projectId?: string
  createdBy: AgentId | 'mission-tracker' | 'system'
  goal: WorkGoal
  requirements: WorkRequirements
  location?: WorldLocation
  priority: number
  dependencies?: string[]
  createdTick: SimulationTick
}

export function create_work(swarm: SwarmStorage, input: CreateWorkInput): WorkItem {
  const id = allocate_swarm_id('work', swarm)
  const dependencies = input.dependencies ? [...input.dependencies] : []
  let initialStatus: WorkItem['status'] = 'open'
  for (const dependencyId of dependencies) if (swarm.board.work[dependencyId]?.status !== 'completed') initialStatus = 'pending_dependency'
  const work: WorkItem = {
    id,
    kind: 'work',
    missionId: input.missionId,
    objectiveId: input.objectiveId,
    projectId: input.projectId,
    createdBy: input.createdBy,
    goal: input.goal,
    requirements: input.requirements,
    location: input.location,
    priority: input.priority,
    status: initialStatus,
    dependencies,
    blockingRequests: [],
    evidence: [],
    createdTick: input.createdTick,
    updatedTick: input.createdTick,
    revision: 1,
  }
  swarm.board.work[id] = work
  record_blackboard_event(swarm, { recordId: id, event: 'created', tick: input.createdTick, revision: work.revision })
  return work
}

export interface CreateRequestInput {
  kind: RequestRecord['kind']
  requester: RequestRecord['requester']
  missionId?: string
  objectiveId?: string
  projectId?: string
  priority: number
  description: string
  itemName?: string
  count?: number
  ratePerSecond?: number
  destination?: WorldLocation
  blocksWorkIds?: string[]
  satisfyingWorkIds?: string[]
  createdTick: SimulationTick
}

export function create_request(swarm: SwarmStorage, input: CreateRequestInput): RequestRecord {
  const id = allocate_swarm_id('request', swarm)
  const request: RequestRecord = {
    id,
    kind: input.kind,
    requester: input.requester,
    missionId: input.missionId,
    objectiveId: input.objectiveId,
    projectId: input.projectId,
    priority: input.priority,
    status: 'open',
    description: input.description,
    itemName: input.itemName,
    count: input.count,
    ratePerSecond: input.ratePerSecond,
    destination: input.destination,
    blocksWorkIds: input.blocksWorkIds ? [...input.blocksWorkIds] : [],
    satisfyingWorkIds: input.satisfyingWorkIds ? [...input.satisfyingWorkIds] : [],
    evidence: [],
    createdTick: input.createdTick,
    updatedTick: input.createdTick,
    revision: 1,
  }
  swarm.board.requests[id] = request
  for (const workId of request.blocksWorkIds) {
    const work = swarm.board.work[workId]
    if (!work) continue
    let seen = false
    for (const existing of work.blockingRequests) if (existing === id) seen = true
    if (!seen) work.blockingRequests.push(id)
    refresh_work_eligibility(swarm, workId, input.createdTick)
  }
  record_blackboard_event(swarm, { recordId: id, event: 'created', tick: input.createdTick, revision: request.revision })
  return request
}

export function set_request_status(swarm: SwarmStorage, requestId: string, expectedRevision: number, status: RequestStatus, tick: SimulationTick, evidence: EvidenceRef[] = []) {
  const request = swarm.board.requests[requestId]
  if (!request) return { ok: false as const, code: 'not_found' as const }
  if (request.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: request.revision }
  if (status === 'satisfied' && evidence.length === 0) return { ok: false as const, code: 'insufficient_evidence' as const }
  request.status = status
  request.updatedTick = tick
  request.revision += 1
  for (const ref of evidence) request.evidence.push(ref)
  record_blackboard_event(swarm, { recordId: request.id, event: status === 'satisfied' ? 'satisfied' : status === 'cancelled' ? 'cancelled' : 'updated', tick, revision: request.revision })
  for (const workId of request.blocksWorkIds) refresh_work_eligibility(swarm, workId, tick)
  return { ok: true as const, request }
}

export interface PostObservationInput {
  observer: ObservationRecord['observer']
  subject: string
  location?: WorldLocation
  evidenceClass: ObservationRecord['evidenceClass']
  data: ObservationRecord['data']
  observedTick: SimulationTick
  expiresTick?: SimulationTick
  supersedesObservationId?: string
}

export function post_observation(swarm: SwarmStorage, input: PostObservationInput) {
  const id = allocate_swarm_id('observation', swarm)
  const observation: ObservationRecord = { id, ...input }
  swarm.board.observations[id] = observation
  record_blackboard_event(swarm, { recordId: id, event: 'created', tick: input.observedTick, revision: 1 })
  return observation
}

export interface PostWarningInput {
  kind: WarningRecord['kind']
  source: WarningRecord['source']
  severity: number
  description: string
  missionId?: string
  projectId?: string
  workId?: string
  location?: WorldLocation
  createdTick: SimulationTick
  evidence?: EvidenceRef[]
}

export function post_warning(swarm: SwarmStorage, input: PostWarningInput) {
  const id = allocate_swarm_id('warning', swarm)
  const warning: WarningRecord = {
    id,
    kind: input.kind,
    source: input.source,
    severity: input.severity,
    description: input.description,
    missionId: input.missionId,
    projectId: input.projectId,
    workId: input.workId,
    location: input.location,
    active: true,
    createdTick: input.createdTick,
    evidence: input.evidence ? [...input.evidence] : [],
  }
  swarm.board.warnings[id] = warning
  record_blackboard_event(swarm, { recordId: id, event: 'created', tick: input.createdTick, revision: 1 })
  return warning
}

export function resolve_warning(swarm: SwarmStorage, warningId: string, tick: SimulationTick) {
  const warning = swarm.board.warnings[warningId]
  if (!warning || !warning.active) return false
  warning.active = false
  warning.resolvedTick = tick
  record_blackboard_event(swarm, { recordId: warningId, event: 'updated', tick, revision: 1 })
  return true
}

export interface PostResultInput {
  workId: string
  agentId: AgentId
  status: WorkResult['status']
  evidence: EvidenceRef[]
  summary: string
  tick: SimulationTick
}

export function post_result(swarm: SwarmStorage, input: PostResultInput) {
  const id = allocate_swarm_id('result', swarm)
  const result: WorkResult = { id, ...input }
  swarm.board.results[id] = result
  const work = swarm.board.work[input.workId]
  if (work) for (const ref of input.evidence) work.evidence.push(ref)
  record_blackboard_event(swarm, { recordId: id, event: 'created', agentId: input.agentId, tick: input.tick, revision: 1 })
  return result
}

export function complete_work_from_result(swarm: SwarmStorage, workId: string, expectedRevision: number, resultId: string, tick: SimulationTick) {
  const work = swarm.board.work[workId]
  const result = swarm.board.results[resultId]
  if (!work || !result || result.workId !== workId) return { ok: false as const, code: 'not_found' as const }
  if (work.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: work.revision }
  if (work.status !== 'claimed' && work.status !== 'active') return { ok: false as const, code: 'not_active' as const }
  const claim = work.claimId ? swarm.board.claims[work.claimId] : undefined
  if (!claim || claim.agentId !== result.agentId) return { ok: false as const, code: 'claim_owner_mismatch' as const }
  if (result.status !== 'success' || result.evidence.length === 0) return { ok: false as const, code: 'insufficient_evidence' as const }
  delete swarm.board.claims[claim.id]
  clear_agent_commitment_for_work(swarm, claim.agentId, work.id, tick)
  work.claimId = undefined
  work.status = 'completed'
  work.updatedTick = tick
  work.revision += 1
  record_blackboard_event(swarm, { recordId: workId, event: 'completed', agentId: result.agentId, tick, revision: work.revision })
  for (const id in swarm.board.work) {
    const candidate = swarm.board.work[id]
    for (const dependencyId of candidate.dependencies) if (dependencyId === workId) refresh_work_eligibility(swarm, candidate.id, tick)
  }
  return { ok: true as const, work }
}

export function list_open_work(swarm: SwarmStorage) {
  const result: WorkItem[] = []
  for (const id in swarm.board.work) {
    const work = swarm.board.work[id]
    if (work.status === 'open') result.push(work)
  }
  result.sort((a, b) => b.priority - a.priority || a.createdTick - b.createdTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result
}
