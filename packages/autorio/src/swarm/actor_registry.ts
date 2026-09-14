import type { ControlledActor } from '../actors/types'
import type {
  ActorAdmissionSnapshot,
  ActorCapability,
  ActorId,
  AgentId,
  PersistedActorState,
  PhysicalActorIdentity,
  SimulationTick,
  SwarmStorage,
} from './types'

export interface ActorRuntimeRegistration {
  resolve: () => ControlledActor | undefined
  capabilities: ActorCapability[]
}

export interface ActorRuntimeSnapshot {
  actorId: ActorId
  agentId?: AgentId
  registered: boolean
  available: boolean
  capabilities: ActorCapability[]
  state: PersistedActorState['state']
  bodyRevision: number
  physical?: PhysicalActorIdentity
  lastSeenTick?: SimulationTick
  missingSinceTick?: SimulationTick
  revision: number
}

function same_physical_identity(left: PhysicalActorIdentity, right: PhysicalActorIdentity) {
  return left.physicalActorId === right.physicalActorId
    && left.kind === right.kind
    && left.forceIndex === right.forceIndex
}

function find_bound_agent_id(swarm: SwarmStorage, actorId: ActorId) {
  for (const agentId in swarm.agents) {
    if (swarm.agents[agentId].actorId === actorId) return agentId
  }
  return undefined
}

function mark_missing(state: PersistedActorState, tick: SimulationTick) {
  let changed = false
  if (state.state !== 'missing') {
    state.state = 'missing'
    changed = true
  }
  if (state.missingSinceTick === undefined) {
    state.missingSinceTick = tick
    changed = true
  }
  if (changed) state.revision += 1
}

function mark_online(state: PersistedActorState, identity: PhysicalActorIdentity, tick: SimulationTick) {
  let changed = false
  if (state.physical === undefined) {
    state.physical = identity
    if (state.bodyRevision < 1) state.bodyRevision = 1
    changed = true
  }
  else if (!same_physical_identity(state.physical, identity)) {
    state.physical = identity
    state.bodyRevision += 1
    changed = true
  }
  if (state.state !== 'online') {
    state.state = 'online'
    changed = true
  }
  if (state.missingSinceTick !== undefined) {
    state.missingSinceTick = undefined
    changed = true
  }
  state.lastSeenTick = tick
  if (changed) state.revision += 1
}

export function new_actor_registry(swarm: SwarmStorage) {
  const registrations: Record<ActorId, ActorRuntimeRegistration> = {}

  function reconcile_actor(actorId: ActorId, tick: SimulationTick) {
    const state = swarm.actors[actorId]
    if (state === undefined) return { ok: false as const, code: 'unknown_actor' as const }
    const registration = registrations[actorId]
    if (registration === undefined) return { ok: false as const, code: 'not_registered' as const, state }

    const actor = registration.resolve()
    if (actor === undefined || !actor.is_valid) {
      mark_missing(state, tick)
      return { ok: true as const, state, actor: undefined }
    }

    const status = actor.status_snapshot()
    if (status.actor_id === undefined) {
      mark_missing(state, tick)
      return { ok: true as const, state, actor: undefined }
    }

    const identity: PhysicalActorIdentity = {
      physicalActorId: status.actor_id,
      kind: status.kind,
      forceIndex: actor.force.index,
    }
    mark_online(state, identity, tick)
    return { ok: true as const, state, actor }
  }

  function register_actor(actorId: ActorId, registration: ActorRuntimeRegistration, tick: SimulationTick) {
    if (swarm.actors[actorId] === undefined) return { ok: false as const, code: 'unknown_actor' as const }
    if (registrations[actorId] !== undefined) return { ok: false as const, code: 'already_registered' as const }
    registrations[actorId] = {
      resolve: registration.resolve,
      capabilities: [...registration.capabilities],
    }
    const reconciled = reconcile_actor(actorId, tick)
    if (!reconciled.ok) {
      delete registrations[actorId]
      return reconciled
    }
    return { ok: true as const, state: reconciled.state, actor: reconciled.actor }
  }

  function unregister_actor(actorId: ActorId) {
    const state = swarm.actors[actorId]
    if (state === undefined) return { ok: false as const, code: 'unknown_actor' as const }
    if (registrations[actorId] === undefined) return { ok: false as const, code: 'not_registered' as const }
    delete registrations[actorId]
    if (state.state !== 'unbound' || state.missingSinceTick !== undefined) {
      state.state = 'unbound'
      state.missingSinceTick = undefined
      state.revision += 1
    }
    return { ok: true as const, state }
  }

  function resolve_actor(actorId: ActorId, tick: SimulationTick) {
    const reconciled = reconcile_actor(actorId, tick)
    return reconciled.ok ? reconciled.actor : undefined
  }

  function runtime_snapshot(actorId: ActorId, tick: SimulationTick): ActorRuntimeSnapshot | undefined {
    const state = swarm.actors[actorId]
    if (state === undefined) return undefined
    const registration = registrations[actorId]
    let actor: ControlledActor | undefined
    if (registration !== undefined) {
      const reconciled = reconcile_actor(actorId, tick)
      if (reconciled.ok) actor = reconciled.actor
    }
    const agentId = find_bound_agent_id(swarm, actorId)
    const agent = agentId !== undefined ? swarm.agents[agentId] : undefined
    return {
      actorId,
      agentId,
      registered: registration !== undefined,
      available: actor !== undefined && agent !== undefined && agent.state === 'available',
      capabilities: registration !== undefined ? [...registration.capabilities] : [],
      state: state.state,
      bodyRevision: state.bodyRevision,
      physical: state.physical,
      lastSeenTick: state.lastSeenTick,
      missingSinceTick: state.missingSinceTick,
      revision: state.revision,
    }
  }

  function admission_snapshot(actorId: ActorId, tick: SimulationTick): ActorAdmissionSnapshot | undefined {
    const snapshot = runtime_snapshot(actorId, tick)
    if (snapshot === undefined || snapshot.agentId === undefined || !snapshot.registered) return undefined
    return {
      actorId: snapshot.actorId,
      agentId: snapshot.agentId,
      available: snapshot.available,
      capabilities: [...snapshot.capabilities],
      bodyRevision: snapshot.bodyRevision,
    }
  }

  function list_runtime_snapshots(tick: SimulationTick) {
    const snapshots: ActorRuntimeSnapshot[] = []
    for (const actorId in swarm.actors) {
      const snapshot = runtime_snapshot(actorId, tick)
      if (snapshot !== undefined) snapshots.push(snapshot)
    }
    snapshots.sort((a, b) => a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0)
    return snapshots
  }

  function list_admission_snapshots(tick: SimulationTick) {
    const snapshots: ActorAdmissionSnapshot[] = []
    for (const actorId in registrations) {
      const snapshot = admission_snapshot(actorId, tick)
      if (snapshot !== undefined) snapshots.push(snapshot)
    }
    snapshots.sort((a, b) => a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0)
    return snapshots
  }

  return {
    register_actor,
    unregister_actor,
    reconcile_actor,
    resolve_actor,
    runtime_snapshot,
    admission_snapshot,
    list_runtime_snapshots,
    list_admission_snapshots,
  }
}
