import type { ActorId, AgentId, ClaimId, SimulationTick, SwarmStorage, WorkId } from './types'

export interface RuntimeActorRecoverySnapshot {
  actorId: ActorId
  agentId: AgentId
  bodyRevision: number
  available: boolean
}

export type RecoveryDisposition = 'release' | 'preserve_until_lease'

export interface SwarmRecoveryPolicy {
  missingActor: RecoveryDisposition
  unavailableActor: RecoveryDisposition
  bodyRevisionChanged: RecoveryDisposition
}

export const CONSERVATIVE_RECOVERY_POLICY: SwarmRecoveryPolicy = {
  missingActor: 'preserve_until_lease',
  unavailableActor: 'preserve_until_lease',
  bodyRevisionChanged: 'release',
}

export type ReconciliationAction
  = {
      kind: 'expire_claim'
      claimId: ClaimId
      workId: WorkId
      reason: 'lease_expired'
    }
    | {
      kind: 'release_claim'
      claimId: ClaimId
      workId: WorkId
      reason: 'missing_actor' | 'unavailable_actor' | 'body_revision_changed' | 'actor_agent_mismatch'
    }
    | {
      kind: 'clear_agent_commitment'
      agentId: AgentId
      workId?: WorkId
      reason: 'work_missing' | 'claim_missing' | 'claim_owned_by_other_agent'
    }

function find_actor(snapshots: RuntimeActorRecoverySnapshot[], actorId: ActorId) {
  for (const snapshot of snapshots) if (snapshot.actorId === actorId) return snapshot
  return undefined
}

function has_claim_for_agent_work(swarm: SwarmStorage, agentId: AgentId, workId: WorkId) {
  const work = swarm.board.work[workId]
  if (!work?.claimId) return 'missing'
  const claim = swarm.board.claims[work.claimId]
  if (!claim) return 'missing'
  return claim.agentId === agentId ? 'owned' : 'other'
}

/**
 * Compute reconciliation actions without mutating persistent state.
 *
 * The caller chooses policy and later applies actions through the normal
 * claim/agent state-machine functions. This keeps save/restart policy separate
 * from navigation and physical body reacquisition.
 */
export function plan_swarm_reconciliation(
  swarm: SwarmStorage,
  snapshots: RuntimeActorRecoverySnapshot[],
  tick: SimulationTick,
  policy: SwarmRecoveryPolicy = CONSERVATIVE_RECOVERY_POLICY,
) {
  const actions: ReconciliationAction[] = []
  const claimIds: ClaimId[] = []
  for (const id in swarm.board.claims) claimIds.push(id)
  claimIds.sort()

  for (const claimId of claimIds) {
    const claim = swarm.board.claims[claimId]
    if (claim.leaseUntilTick <= tick) {
      actions.push({ kind: 'expire_claim', claimId: claim.id, workId: claim.workId, reason: 'lease_expired' })
      continue
    }

    const actor = find_actor(snapshots, claim.actorId)
    if (!actor) {
      if (policy.missingActor === 'release') actions.push({ kind: 'release_claim', claimId: claim.id, workId: claim.workId, reason: 'missing_actor' })
      continue
    }
    if (actor.agentId !== claim.agentId) {
      actions.push({ kind: 'release_claim', claimId: claim.id, workId: claim.workId, reason: 'actor_agent_mismatch' })
      continue
    }
    if (actor.bodyRevision !== claim.actorBodyRevision) {
      if (policy.bodyRevisionChanged === 'release') actions.push({ kind: 'release_claim', claimId: claim.id, workId: claim.workId, reason: 'body_revision_changed' })
      continue
    }
    if (!actor.available && policy.unavailableActor === 'release') {
      actions.push({ kind: 'release_claim', claimId: claim.id, workId: claim.workId, reason: 'unavailable_actor' })
    }
  }

  const agentIds: AgentId[] = []
  for (const id in swarm.agents) agentIds.push(id)
  agentIds.sort()
  for (const agentId of agentIds) {
    const agent = swarm.agents[agentId]
    if (!agent.currentWorkId) continue
    const work = swarm.board.work[agent.currentWorkId]
    if (!work) {
      actions.push({ kind: 'clear_agent_commitment', agentId: agent.id, workId: agent.currentWorkId, reason: 'work_missing' })
      continue
    }
    const ownership = has_claim_for_agent_work(swarm, agent.id, work.id)
    if (ownership === 'missing' && (agent.state === 'working' || agent.state === 'recovering')) {
      actions.push({ kind: 'clear_agent_commitment', agentId: agent.id, workId: work.id, reason: 'claim_missing' })
    }
    else if (ownership === 'other') {
      actions.push({ kind: 'clear_agent_commitment', agentId: agent.id, workId: work.id, reason: 'claim_owned_by_other_agent' })
    }
  }

  return actions
}
