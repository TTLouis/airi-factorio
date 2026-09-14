import { clear_agent_commitment } from './agents'
import type { new_actor_registry } from './actor_registry'
import type { AgentId, SimulationTick, SwarmStorage } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>

/**
 * Return logical agents to the available pool after their bound actor has a
 * valid online body again and no stale Work commitment remains. Claim release
 * is responsible for clearing currentWorkId before putting an agent into the
 * recovering state; this function never overrides an active commitment.
 */
export function reconcile_recovered_agents(
  swarm: SwarmStorage,
  registry: ActorRegistry,
  tick: SimulationTick,
) {
  const recovered: AgentId[] = []
  for (const snapshot of registry.list_runtime_snapshots(tick)) {
    if (!snapshot.registered || snapshot.state !== 'online' || snapshot.agentId === undefined) continue
    const agent = swarm.agents[snapshot.agentId]
    if (agent === undefined || agent.state !== 'recovering' || agent.currentWorkId !== undefined) continue
    if (clear_agent_commitment(swarm, agent.id, tick, 'available')) recovered.push(agent.id)
  }
  recovered.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  return recovered
}
