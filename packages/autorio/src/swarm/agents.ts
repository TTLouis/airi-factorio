import type {
  ActorId,
  AgentAvailabilityState,
  AgentId,
  MissionId,
  PersistedAgentState,
  ProjectId,
  RequestId,
  SimulationTick,
  SwarmStorage,
  WorkId,
} from './types'
import { allocate_swarm_id } from './storage'

export function create_agent(swarm: SwarmStorage, actorId?: ActorId): PersistedAgentState {
  if (actorId) {
    for (const id in swarm.agents) {
      if (swarm.agents[id].actorId === actorId) {
        throw new Error(`Actor ${actorId} is already bound to agent ${id}`)
      }
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

export function allocate_logical_actor_id(swarm: SwarmStorage): ActorId {
  return allocate_swarm_id('actor', swarm)
}

export function bind_agent_actor(swarm: SwarmStorage, agentId: AgentId, expectedRevision: number, actorId: ActorId) {
  const agent = swarm.agents[agentId]
  if (!agent) return { ok: false as const, code: 'not_found' as const }
  if (agent.revision !== expectedRevision) {
    return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: agent.revision }
  }

  for (const id in swarm.agents) {
    if (id !== agentId && swarm.agents[id].actorId === actorId) {
      return { ok: false as const, code: 'actor_already_bound' as const }
    }
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
  currentMissionId?: MissionId
  focusDescription?: string
}

export function update_agent_commitment(swarm: SwarmStorage, input: UpdateAgentCommitmentInput) {
  const agent = swarm.agents[input.agentId]
  if (!agent) return { ok: false as const, code: 'not_found' as const }
  if (agent.revision !== input.expectedRevision) {
    return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: agent.revision }
  }

  agent.state = input.state
  agent.currentWorkId = input.currentWorkId
  agent.currentProjectId = input.currentProjectId
  agent.currentMissionId = input.currentMissionId
  agent.lastDecisionTick = input.tick
  agent.focus = input.focusDescription
    ? { description: input.focusDescription, sinceTick: input.tick }
    : undefined
  agent.revision += 1
  return { ok: true as const, agent }
}

export function add_agent_request(swarm: SwarmStorage, agentId: AgentId, requestId: RequestId) {
  const agent = swarm.agents[agentId]
  if (!agent) return false
  for (const existing of agent.activeRequestIds) {
    if (existing === requestId) return true
  }
  agent.activeRequestIds.push(requestId)
  agent.revision += 1
  return true
}

export function remove_agent_request(swarm: SwarmStorage, agentId: AgentId, requestId: RequestId) {
  const agent = swarm.agents[agentId]
  if (!agent) return false

  const next: RequestId[] = []
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
