export type AgentId = string
export type ActorId = string

export type WorkId = string
export type RequestId = string
export type ClaimId = string
export type MissionId = string
export type ObjectiveId = string
export type ProjectId = string
export type ObservationId = string
export type WarningId = string
export type ResultId = string
export type ReservationId = string
export type EventId = string

export type SimulationTick = number

export type ActorCapability
  = | 'move'
    | 'mine'
    | 'craft'
    | 'build'
    | 'transfer'
    | 'combat'
    | 'repair'
    | 'inspect'
    | 'survey'

export interface WorldPosition {
  x: number
  y: number
}

export interface WorldLocation {
  surfaceIndex: number
  position: WorldPosition
  radius?: number
}

export type EvidenceClass = 'engine_read' | 'measured' | 'estimated' | 'operation_receipt'

export interface EvidenceRef {
  kind: 'observation' | 'result' | 'operation_receipt'
  id: string
  tick: SimulationTick
  revision?: number
}

export interface ActorAdmissionSnapshot {
  actorId: ActorId
  agentId: AgentId
  available: boolean
  capabilities: ActorCapability[]
  bodyRevision: number
}

export type ActorRuntimeState = 'unbound' | 'online' | 'missing'

export interface PhysicalActorIdentity {
  physicalActorId: number
  kind: string
  forceIndex: number
  surfaceIndex: number
}

export interface PersistedActorState {
  id: ActorId
  state: ActorRuntimeState
  bodyRevision: number
  physical?: PhysicalActorIdentity
  lastSeenTick?: SimulationTick
  missingSinceTick?: SimulationTick
  revision: number
}

export type AgentAvailabilityState = 'available' | 'working' | 'blocked' | 'recovering' | 'disabled'

export interface PersistedAgentState {
  id: AgentId
  actorId?: ActorId
  state: AgentAvailabilityState
  currentWorkId?: WorkId
  currentProjectId?: ProjectId
  currentMissionId?: MissionId
  focus?: {
    description: string
    sinceTick: SimulationTick
  }
  activeRequestIds: RequestId[]
  lastDecisionTick?: SimulationTick
  revision: number
}

export type WorkStatus
  = | 'pending_dependency'
    | 'open'
    | 'claimed'
    | 'active'
    | 'blocked'
    | 'completed'
    | 'cancelled'

export type WorkGoal
  = | { kind: 'acquire_items', itemName: string, count: number }
    | { kind: 'deliver_items', itemName: string, count: number, destination: WorldLocation }
    | { kind: 'construct_design', designId: string, designRevision: number }
    | { kind: 'survey_area', subject: string, area: WorldLocation }
    | { kind: 'increase_capacity', itemName: string, additionalRatePerSecond: number }
    | { kind: 'defend_area', area: WorldLocation }
    | { kind: 'repair_area', area: WorldLocation }
    | { kind: 'verify_condition', description: string }
    | { kind: 'custom', description: string }

export interface WorkRequirements {
  capabilities: ActorCapability[]
  authorityTags?: string[]
}

export interface WorkItem {
  id: WorkId
  kind: 'work'
  missionId?: MissionId
  objectiveId?: ObjectiveId
  projectId?: ProjectId
  createdBy: AgentId | 'mission-tracker' | 'system'
  goal: WorkGoal
  requirements: WorkRequirements
  location?: WorldLocation
  priority: number
  status: WorkStatus
  dependencies: WorkId[]
  blockingRequests: RequestId[]
  claimId?: ClaimId
  evidence: EvidenceRef[]
  createdTick: SimulationTick
  updatedTick: SimulationTick
  revision: number
}

export type RequestKind
  = | 'material_request'
    | 'observation_request'
    | 'construction_request'
    | 'assistance_request'
    | 'decision_request'
    | 'defense_request'
    | 'transport_request'
    | 'capacity_request'
    | 'custom'

export type RequestStatus = 'open' | 'claimed' | 'satisfied' | 'cancelled'

export interface RequestRecord {
  id: RequestId
  kind: RequestKind
  requester: AgentId | 'mission-tracker' | 'system'
  missionId?: MissionId
  objectiveId?: ObjectiveId
  projectId?: ProjectId
  priority: number
  status: RequestStatus
  description: string
  itemName?: string
  count?: number
  ratePerSecond?: number
  destination?: WorldLocation
  blocksWorkIds: WorkId[]
  satisfyingWorkIds: WorkId[]
  evidence: EvidenceRef[]
  createdTick: SimulationTick
  updatedTick: SimulationTick
  revision: number
}

export interface ObservationRecord {
  id: ObservationId
  observer: AgentId | 'system'
  subject: string
  location?: WorldLocation
  evidenceClass: EvidenceClass
  data: Record<string, string | number | boolean>
  observedTick: SimulationTick
  expiresTick?: SimulationTick
  supersedesObservationId?: ObservationId
}

export type WarningKind
  = | 'attack'
    | 'actor_stuck'
    | 'supply_shortage'
    | 'project_conflict'
    | 'stale_assumption'
    | 'actor_recovery'
    | 'repeated_failure'
    | 'custom'

export interface WarningRecord {
  id: WarningId
  kind: WarningKind
  source: AgentId | 'system'
  severity: number
  description: string
  missionId?: MissionId
  projectId?: ProjectId
  workId?: WorkId
  location?: WorldLocation
  active: boolean
  createdTick: SimulationTick
  resolvedTick?: SimulationTick
  evidence: EvidenceRef[]
}

export interface WorkResult {
  id: ResultId
  workId: WorkId
  agentId: AgentId
  status: 'success' | 'partial' | 'failure'
  evidence: EvidenceRef[]
  summary: string
  tick: SimulationTick
}

export type ClaimState = 'claimed' | 'active' | 'releasing'

export interface WorkClaim {
  id: ClaimId
  workId: WorkId
  agentId: AgentId
  actorId: ActorId
  /** Logical body generation captured when the claim is acquired. */
  actorBodyRevision: number
  acquiredTick: SimulationTick
  leaseUntilTick: SimulationTick
  lastProgressTick: SimulationTick
  workRevision: number
  state: ClaimState
  progress?: {
    summary: string
    evidence?: EvidenceRef[]
  }
}

export interface ReservationRecord {
  id: ReservationId
  kind: 'items' | 'area' | 'entity'
  projectId: ProjectId
  workId?: WorkId
  ownerAgentId?: AgentId
  description: string
  createdTick: SimulationTick
  expiresTick?: SimulationTick
}

export interface BlackboardEvent {
  id: EventId
  recordId: string
  event:
    | 'created'
    | 'updated'
    | 'claimed'
    | 'released'
    | 'started'
    | 'blocked'
    | 'completed'
    | 'cancelled'
    | 'expired'
    | 'satisfied'
  agentId?: AgentId
  tick: SimulationTick
  revision: number
  details?: Record<string, string | number | boolean>
}

export type MissionStatus = 'proposed' | 'active' | 'blocked' | 'satisfied' | 'failed' | 'cancelled'
export type ObjectiveStatus = 'pending' | 'ready' | 'active' | 'blocked' | 'satisfied' | 'cancelled'
export type ProjectStatus = 'planning' | 'ready' | 'executing' | 'blocked' | 'verifying' | 'complete' | 'cancelled'

export interface AcceptanceCondition {
  id: string
  kind: 'custom' | 'item_rate' | 'inventory_count' | 'world_state'
  description: string
  itemName?: string
  threshold?: number
  durationTicks?: number
  location?: WorldLocation
}

export interface AcceptanceEvaluation {
  conditionId: string
  satisfied: boolean
  evidence: EvidenceRef[]
  tick: SimulationTick
}

export type BlockerRef
  = { kind: 'request', id: RequestId }
    | { kind: 'warning', id: WarningId }
    | { kind: 'work', id: WorkId }
    | { kind: 'custom', description: string }

export interface Mission {
  id: MissionId
  title: string
  status: MissionStatus
  priority: number
  goal: string
  acceptance: AcceptanceCondition[]
  acceptanceState: Record<string, AcceptanceEvaluation>
  objectiveIds: ObjectiveId[]
  blockers: BlockerRef[]
  createdBy: 'human' | AgentId
  createdTick: SimulationTick
  updatedTick: SimulationTick
  revision: number
}

export interface Objective {
  id: ObjectiveId
  missionId: MissionId
  description: string
  status: ObjectiveStatus
  dependencies: ObjectiveId[]
  acceptance: AcceptanceCondition[]
  acceptanceState: Record<string, AcceptanceEvaluation>
  evidence: EvidenceRef[]
  projectIds: ProjectId[]
  priority: number
  revision: number
}

export interface ProjectScope {
  description: string
  allowedArea?: WorldLocation
  authorityTags?: string[]
}

export interface Project {
  id: ProjectId
  missionId: MissionId
  objectiveId?: ObjectiveId
  title: string
  status: ProjectStatus
  scope: ProjectScope
  revision: number
  workItemIds: WorkId[]
  reservationIds: ReservationId[]
  evidence: EvidenceRef[]
  blockers: BlockerRef[]
}

export interface SwarmBoardStorage {
  work: Record<WorkId, WorkItem>
  requests: Record<RequestId, RequestRecord>
  observations: Record<ObservationId, ObservationRecord>
  warnings: Record<WarningId, WarningRecord>
  claims: Record<ClaimId, WorkClaim>
  results: Record<ResultId, WorkResult>
  reservations: Record<ReservationId, ReservationRecord>
  events: BlackboardEvent[]
}

export interface SwarmStorage {
  version: number
  agents: Record<AgentId, PersistedAgentState>
  actors: Record<ActorId, PersistedActorState>
  board: SwarmBoardStorage
  missions: Record<MissionId, Mission>
  objectives: Record<ObjectiveId, Objective>
  projects: Record<ProjectId, Project>
  counters: Record<string, number>
}

export type SwarmIdKind
  = | 'agent'
    | 'actor'
    | 'work'
    | 'request'
    | 'claim'
    | 'mission'
    | 'objective'
    | 'project'
    | 'observation'
    | 'warning'
    | 'result'
    | 'reservation'
    | 'event'

export interface SwarmIdByKind {
  agent: AgentId
  actor: ActorId
  work: WorkId
  request: RequestId
  claim: ClaimId
  mission: MissionId
  objective: ObjectiveId
  project: ProjectId
  observation: ObservationId
  warning: WarningId
  result: ResultId
  reservation: ReservationId
  event: EventId
}
