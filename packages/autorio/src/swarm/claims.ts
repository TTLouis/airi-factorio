import type {
  ActorAdmissionSnapshot,
  ClaimId,
  EvidenceRef,
  SimulationTick,
  SwarmStorage,
  WorkClaim,
  WorkItem,
} from './types'
import { post_warning, record_blackboard_event, refresh_work_eligibility } from './blackboard'
import { allocate_swarm_id } from './storage'

function has_capability(actor: ActorAdmissionSnapshot, required: string) {
  for (const capability of actor.capabilities) {
    if (capability === required) return true
  }
  return false
}

function requirements_satisfied(work: WorkItem, actor: ActorAdmissionSnapshot) {
  if (!actor.available) return false
  for (const capability of work.requirements.capabilities) {
    if (!has_capability(actor, capability)) return false
  }
  return true
}

function dependencies_satisfied(swarm: SwarmStorage, work: WorkItem) {
  for (const dependencyId of work.dependencies) {
    if (swarm.board.work[dependencyId]?.status !== 'completed') return false
  }
  return true
}

export interface ClaimWorkInput {
  workId: string
  expectedRevision: number
  actor: ActorAdmissionSnapshot
  tick: SimulationTick
  leaseTicks: number
}

export type ClaimWorkResult
  = { ok: true, claim: WorkClaim, work: WorkItem }
    | { ok: false, code: 'not_found' | 'revision_mismatch' | 'not_claimable' | 'dependency_blocked' | 'already_claimed' | 'agent_already_committed' | 'actor_already_committed' | 'capability_mismatch' | 'invalid_lease', currentRevision?: number }

export function claim_work(swarm: SwarmStorage, input: ClaimWorkInput): ClaimWorkResult {
  const work = swarm.board.work[input.workId]
  if (!work) return { ok: false, code: 'not_found' }
  if (work.revision !== input.expectedRevision) return { ok: false, code: 'revision_mismatch', currentRevision: work.revision }
  if (input.leaseTicks <= 0) return { ok: false, code: 'invalid_lease' }
  if (work.status !== 'open') return { ok: false, code: 'not_claimable' }
  if (!dependencies_satisfied(swarm, work)) return { ok: false, code: 'dependency_blocked' }
  if (work.claimId && swarm.board.claims[work.claimId]) return { ok: false, code: 'already_claimed' }
  for (const claimId in swarm.board.claims) {
    const existing = swarm.board.claims[claimId]
    if (existing.agentId === input.actor.agentId) return { ok: false, code: 'agent_already_committed' }
    if (existing.actorId === input.actor.actorId) return { ok: false, code: 'actor_already_committed' }
  }
  if (!requirements_satisfied(work, input.actor)) return { ok: false, code: 'capability_mismatch' }

  const id = allocate_swarm_id('claim', swarm)
  work.revision += 1
  work.status = 'claimed'
  work.claimId = id
  work.updatedTick = input.tick

  const claim: WorkClaim = {
    id,
    workId: work.id,
    agentId: input.actor.agentId,
    actorId: input.actor.actorId,
    actorBodyRevision: input.actor.bodyRevision,
    acquiredTick: input.tick,
    leaseUntilTick: input.tick + input.leaseTicks,
    lastProgressTick: input.tick,
    workRevision: work.revision,
    state: 'claimed',
  }
  swarm.board.claims[id] = claim
  record_blackboard_event(swarm, {
    recordId: work.id,
    event: 'claimed',
    agentId: claim.agentId,
    tick: input.tick,
    revision: work.revision,
    details: { claimId: claim.id, actorId: claim.actorId },
  })
  return { ok: true, claim, work }
}

export function activate_claim(swarm: SwarmStorage, claimId: ClaimId, tick: SimulationTick) {
  const claim = swarm.board.claims[claimId]
  if (!claim) return { ok: false as const, code: 'not_found' as const }
  const work = swarm.board.work[claim.workId]
  if (!work || work.claimId !== claimId) return { ok: false as const, code: 'ownership_mismatch' as const }
  if (claim.state !== 'claimed') return { ok: false as const, code: 'invalid_state' as const }
  claim.state = 'active'
  work.status = 'active'
  work.updatedTick = tick
  work.revision += 1
  claim.workRevision = work.revision
  record_blackboard_event(swarm, {
    recordId: work.id,
    event: 'started',
    agentId: claim.agentId,
    tick,
    revision: work.revision,
    details: { claimId: claim.id },
  })
  return { ok: true as const, claim, work }
}

export interface HeartbeatClaimInput {
  claimId: ClaimId
  tick: SimulationTick
  leaseTicks: number
  bodyRevision: number
  usefulProgress: boolean
  summary?: string
  evidence?: EvidenceRef[]
}

export function heartbeat_claim(swarm: SwarmStorage, input: HeartbeatClaimInput) {
  const claim = swarm.board.claims[input.claimId]
  if (!claim) return { ok: false as const, code: 'not_found' as const }
  const work = swarm.board.work[claim.workId]
  if (!work || work.claimId !== claim.id) return { ok: false as const, code: 'ownership_mismatch' as const }
  if (input.leaseTicks <= 0) return { ok: false as const, code: 'invalid_lease' as const }
  if (input.bodyRevision !== claim.actorBodyRevision) return { ok: false as const, code: 'stale_actor_body' as const }
  if (!input.usefulProgress) return { ok: false as const, code: 'no_useful_progress' as const }
  if (input.tick < claim.lastProgressTick) return { ok: false as const, code: 'tick_regression' as const }

  claim.lastProgressTick = input.tick
  claim.leaseUntilTick = input.tick + input.leaseTicks
  if (input.summary || (input.evidence && input.evidence.length > 0)) {
    claim.progress = {
      summary: input.summary ?? claim.progress?.summary ?? 'useful progress',
      evidence: input.evidence ? [...input.evidence] : claim.progress?.evidence,
    }
  }
  return { ok: true as const, claim }
}

export type ReleaseReason
  = | 'blocker_discovered'
    | 'capability_lost'
    | 'dependency_invalidated'
    | 'target_missing'
    | 'supply_shortage'
    | 'path_unreachable'
    | 'higher_priority_preemption'
    | 'mission_cancelled'
    | 'project_cancelled'
    | 'actor_recovery'
    | 'actor_death'
    | 'no_progress_timeout'
    | 'voluntary'

export interface ReleaseClaimInput {
  claimId: ClaimId
  tick: SimulationTick
  reason: ReleaseReason
  blockerRequestId?: string
}

export function release_claim(swarm: SwarmStorage, input: ReleaseClaimInput) {
  const claim = swarm.board.claims[input.claimId]
  if (!claim) return { ok: false as const, code: 'not_found' as const }
  const work = swarm.board.work[claim.workId]
  if (!work || work.claimId !== claim.id) return { ok: false as const, code: 'ownership_mismatch' as const }

  claim.state = 'releasing'
  if (input.blockerRequestId) {
    let exists = false
    for (const requestId of work.blockingRequests) if (requestId === input.blockerRequestId) exists = true
    if (!exists) work.blockingRequests.push(input.blockerRequestId)
  }
  work.claimId = undefined
  work.status = 'open'
  work.updatedTick = input.tick
  work.revision += 1
  delete swarm.board.claims[claim.id]
  refresh_work_eligibility(swarm, work.id, input.tick)
  record_blackboard_event(swarm, {
    recordId: work.id,
    event: input.reason === 'no_progress_timeout' ? 'expired' : 'released',
    agentId: claim.agentId,
    tick: input.tick,
    revision: work.revision,
    details: { claimId: claim.id, reason: input.reason },
  })
  return { ok: true as const, work, releasedClaimId: claim.id, reason: input.reason }
}

export function expire_claims(swarm: SwarmStorage, tick: SimulationTick) {
  const expired: ClaimId[] = []
  const ids: ClaimId[] = []
  for (const id in swarm.board.claims) ids.push(id)
  for (const id of ids) {
    const claim = swarm.board.claims[id]
    if (claim.leaseUntilTick > tick) continue
    const released = release_claim(swarm, { claimId: id, tick, reason: 'no_progress_timeout' })
    if (released.ok) expired.push(id)
  }
  return expired
}

export function warn_stalled_claims(swarm: SwarmStorage, tick: SimulationTick, stalledTicks: number) {
  const warnings: string[] = []
  for (const id in swarm.board.claims) {
    const claim = swarm.board.claims[id]
    if (tick - claim.lastProgressTick < stalledTicks) continue
    let alreadyWarned = false
    for (const warningId in swarm.board.warnings) {
      const warning = swarm.board.warnings[warningId]
      if (warning.active && warning.kind === 'actor_stuck' && warning.workId === claim.workId) alreadyWarned = true
    }
    if (alreadyWarned) continue
    const warning = post_warning(swarm, {
      kind: 'actor_stuck',
      source: 'system',
      severity: 70,
      description: `No useful progress for claim ${claim.id}`,
      workId: claim.workId,
      createdTick: tick,
    })
    warnings.push(warning.id)
  }
  return warnings
}
