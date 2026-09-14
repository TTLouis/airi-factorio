import type { ActorId, AgentAvailabilityState, AgentId, PersistedAgentState, ProjectId, SimulationTick, SwarmStorage, WorkId } from './types'
import { allocate_swarm_id } from './storage'

export function create_agent(swarm: SwarmStorage, actorId?: ActorId): PersistedAgentState {
  if (actorId) {
    for (const id in swarm.agents) {
      if (swarm.agents[id].actorId === actorId) throw new Error(`Actor ${actorId} is already bound to agent ${id}`)
    }
  }
  const id = allocate_swarm_id('agent', swarm)
  const agent: PersistedAgentState = {
    id,
    actorId,
    state: 'available',
    activeRequestIds: [],
    revision: 1,
  }
  swarm.agents[id] = agent
  return agent
}

export function allocate_logical_actor_id(swarm: SwarmStorage) {
  return allocate_swarm_id('actor', swarm)
}

export function bind_agent_actor(swarm: SwarmStorage, agentId: AgentId, expectedRevision: number, actorId: ActorId) {
  const agent = swarm.agents[agentId]
  if (!agent) return { ok: false as const, code: 'not_found' as const }
  if (agent.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: agent.revision }
  for (const id in swarm.agents) {
    if (id !== agentId && swarm.agents[id].actorId === actorId) return { ok: false as const, code: 'actor_already_bound' as const }
  }
  agent.actorId = actorId
  agent.revision += 1
  return { ok: true as const, agent }
}

export interface UpdateAgentCommitmentInput {
  agentId: AgentId
  expectedRevision: number
  tick: SimulationTick
  state: AgentAvailabilityState
  currentWorkId?: WorkId
  currentProjectId?: ProjectId
  currentMissionId?: string
  focusDescription?: string
}

export function update_agent_commitment(swarm: SwarmStorage, input: UpdateAgentCommitmentInput) {
  const agent = swarm.agents[input.agentId]
  if (!agent) return { ok: false as const, code: 'not_found' as const }
  if (agent.revision !== input.expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: agent.revision }
  agent.state = input.state
  agent.currentWorkId = input.currentWorkId
  agent.currentProjectId = input.currentProjectId
  agent.currentMissionId = input.currentMissionId
  agent.lastDecisionTick = input.tick
  agent.focus = input.focusDescription ? { description: input.focusDescription, sinceTick: input.tick } : undefined
  agent.revision += 1
  return { ok: true as const, agent }
}

export function add_agent_request(swarm: SwarmStorage, agentId: AgentId, requestId: string) {
  const agent = swarm.agents[agentId]
  if (!agent) return false
  for (const existing of agent.activeRequestIds) if (existing === requestId) return true
  agent.activeRequestIds.push(requestId)
  agent.revision += 1
  return true
}

export function remove_agent_request(swarm: SwarmStorage, agentId: AgentId, requestId: string) {
  const agent = swarm.agents[agentId]
  if (!agent) return false
  const next: string[] = []
  let removed = false
  for (const existing of agent.activeRequestIds) {
    if (existing === requestId) removed = true
    else next.push(existing)
  }
  if (!removed) return false
  agent.activeRequestIds = next
  agent.revision += 1
  return true
}

/** Internal atomic companion to claim creation. Claim admission performs the CAS;
 * this keeps the persisted agent commitment synchronized with the winning claim. */
export function commit_agent_to_work(
  swarm: SwarmStorage,
  agentId: AgentId,
  actorId: ActorId,
  workId: WorkId,
  projectId: ProjectId | undefined,
  missionId: string | undefined,
  tick: SimulationTick,
) {
  const agent = swarm.agents[agentId]
  if (!agent) return false
  if (agent.actorId !== actorId) return false
  agent.state = 'working'
  agent.currentWorkId = workId
  agent.currentProjectId = projectId
  agent.currentMissionId = missionId
  agent.lastDecisionTick = tick
  agent.revision += 1
  return true
}

/** Clear a commitment after release/completion while preserving logical identity. */
export function clear_agent_commitment(
  swarm: SwarmStorage,
  agentId: AgentId,
  tick: SimulationTick,
  nextState: AgentAvailabilityState = 'available',
) {
  const agent = swarm.agents[agentId]
  if (!agent) return false
  agent.state = nextState
  agent.currentWorkId = undefined
  agent.currentProjectId = undefined
  agent.currentMissionId = undefined
  agent.focus = undefined
  agent.lastDecisionTick = tick
  agent.revision += 1
  return true
}

/** Clear only when the persisted commitment still refers to this exact work.
 * This prevents a delayed release/completion from clobbering a newer commitment. */
export function clear_agent_commitment_for_work(
  swarm: SwarmStorage,
  agentId: AgentId,
  workId: WorkId,
  tick: SimulationTick,
  nextState: AgentAvailabilityState = 'available',
) {
  const agent = swarm.agents[agentId]
  if (!agent || agent.currentWorkId !== workId) return false
  return clear_agent_commitment(swarm, agentId, tick, nextState)
}
