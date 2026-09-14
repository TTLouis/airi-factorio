import type { ActorCapability, AgentId, SwarmStorage, WorkId, WorkItem, WorldLocation } from './types'

export interface SelectionActorContext {
  agentId: AgentId
  actorId: string
  capabilities: ActorCapability[]
  location: WorldLocation
  inventory: Record<string, number>
  currentWorkId?: WorkId
}

export interface SelectionEnvironment {
  reachable?: Record<WorkId, boolean>
  riskPenaltyByWork?: Record<WorkId, number>
}

export interface WorkCandidateScore {
  workId: WorkId
  finalScore: number
  factors: {
    priority: number
    locality: number
    inventoryFit: number
    continuity: number
    dependencyValue: number
    switchingPenalty: number
    riskPenalty: number
  }
}

export interface SelectionPolicy {
  localityRadius: number
  localityMaxBonus: number
  inventoryMaxBonus: number
  continuityBonus: number
  dependencyBonusPerBlockedWork: number
  switchingPenalty: number
  switchThreshold: number
  emergencyPriority: number
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  localityRadius: 64,
  localityMaxBonus: 15,
  inventoryMaxBonus: 10,
  continuityBonus: 12,
  dependencyBonusPerBlockedWork: 4,
  switchingPenalty: 8,
  switchThreshold: 10,
  emergencyPriority: 90,
}

function has_capability(capabilities: ActorCapability[], required: ActorCapability) {
  for (const capability of capabilities) if (capability === required) return true
  return false
}

function owns_current_claim(swarm: SwarmStorage, work: WorkItem, actor: SelectionActorContext) {
  if (actor.currentWorkId !== work.id || !work.claimId) return false
  const claim = swarm.board.claims[work.claimId]
  return claim?.agentId === actor.agentId && claim.actorId === actor.actorId
}

function eligible(swarm: SwarmStorage, work: WorkItem, actor: SelectionActorContext, env: SelectionEnvironment) {
  const current = owns_current_claim(swarm, work, actor)
  if (work.status !== 'open' && !current) return false
  if (env.reachable?.[work.id] === false) return false
  for (const capability of work.requirements.capabilities) {
    if (!has_capability(actor.capabilities, capability)) return false
  }
  return true
}

function distance(a: WorldLocation, b: WorldLocation) {
  if (a.surfaceIndex !== b.surfaceIndex) return undefined
  const dx = a.position.x - b.position.x
  const dy = a.position.y - b.position.y
  return Math.sqrt(dx * dx + dy * dy)
}

function locality_score(work: WorkItem, actor: SelectionActorContext, policy: SelectionPolicy) {
  if (!work.location) return 0
  const d = distance(work.location, actor.location)
  if (d === undefined || d >= policy.localityRadius) return 0
  return policy.localityMaxBonus * (1 - d / policy.localityRadius)
}

function inventory_score(work: WorkItem, actor: SelectionActorContext, policy: SelectionPolicy) {
  const goal = work.goal
  if (goal.kind !== 'deliver_items') return 0
  const held = actor.inventory[goal.itemName] ?? 0
  if (held <= 0) return 0
  const ratio = Math.min(1, held / Math.max(1, goal.count))
  return policy.inventoryMaxBonus * ratio
}

function dependency_value(swarm: SwarmStorage, workId: WorkId, policy: SelectionPolicy) {
  let blocked = 0
  for (const id in swarm.board.work) {
    const candidate = swarm.board.work[id]
    if (candidate.status === 'completed' || candidate.status === 'cancelled') continue
    for (const dependency of candidate.dependencies) if (dependency === workId) blocked += 1
  }
  return blocked * policy.dependencyBonusPerBlockedWork
}

export function score_work_candidate(swarm: SwarmStorage, work: WorkItem, actor: SelectionActorContext, env: SelectionEnvironment = {}, policy: SelectionPolicy = DEFAULT_SELECTION_POLICY): WorkCandidateScore | undefined {
  if (!eligible(swarm, work, actor, env)) return undefined
  const priority = work.priority
  const locality = locality_score(work, actor, policy)
  const inventoryFit = inventory_score(work, actor, policy)
  const continuity = actor.currentWorkId === work.id ? policy.continuityBonus : 0
  const dependencyValue = dependency_value(swarm, work.id, policy)
  const switchingPenalty = actor.currentWorkId && actor.currentWorkId !== work.id ? policy.switchingPenalty : 0
  const riskPenalty = env.riskPenaltyByWork?.[work.id] ?? 0
  return {
    workId: work.id,
    finalScore: priority + locality + inventoryFit + continuity + dependencyValue - switchingPenalty - riskPenalty,
    factors: { priority, locality, inventoryFit, continuity, dependencyValue, switchingPenalty, riskPenalty },
  }
}

export function rank_work_candidates(swarm: SwarmStorage, actor: SelectionActorContext, env: SelectionEnvironment = {}, limit = 5, policy: SelectionPolicy = DEFAULT_SELECTION_POLICY) {
  const scores: WorkCandidateScore[] = []
  for (const id in swarm.board.work) {
    const score = score_work_candidate(swarm, swarm.board.work[id], actor, env, policy)
    if (score) scores.push(score)
  }
  scores.sort((a, b) => b.finalScore - a.finalScore || (a.workId < b.workId ? -1 : a.workId > b.workId ? 1 : 0))
  if (scores.length <= limit) return scores
  return scores.slice(0, limit)
}

export function should_switch_work(currentScore: number, candidate: WorkCandidateScore, candidatePriority: number, policy: SelectionPolicy = DEFAULT_SELECTION_POLICY) {
  if (candidatePriority >= policy.emergencyPriority) return true
  return candidate.finalScore >= currentScore + policy.switchThreshold
}
