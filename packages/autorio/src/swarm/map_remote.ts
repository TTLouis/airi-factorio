import type { LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { StandaloneCharacterActor } from '../actors/standalone_character_actor'
import { inspect_charted_entity, query_charted_entities, set_charted_machine_recipe } from '../map_remote'
import type { ActorCapability, ActorId } from './types'

interface SwarmRuntimeStatus {
  found: boolean
  runtime?: {
    agentId?: string
    registered: boolean
    capabilities: ActorCapability[]
    state: string
    bodyRevision: number
    physical?: {
      physicalActorId: number
      kind: string
      forceIndex: number
      surfaceIndex: number
    }
  }
}

type SwarmStatusProvider = (actorId: ActorId) => SwarmRuntimeStatus

type PhysicalActorResolver = (surface: LuaSurface, physicalActorId: number) => ControlledActor | undefined

type MapAccessCode = 'ok' | 'unknown_actor' | 'actor_not_registered' | 'missing_capability' | 'no_body'

function has_capability(values: ActorCapability[], expected: ActorCapability) {
  for (const value of values) if (value === expected) return true
  return false
}

function default_actor_resolver(surface: LuaSurface, physicalActorId: number) {
  return StandaloneCharacterActor.reacquire_unit(surface, physicalActorId)
}

export function new_swarm_map_service(
  getStatus: SwarmStatusProvider,
  resolvePhysicalActor: PhysicalActorResolver = default_actor_resolver,
) {
  function resolve_actor(actorId: ActorId, capability?: ActorCapability): {
    ok: true
    code: 'ok'
    actor: ControlledActor
    observer: { actor_id: ActorId, agent_id?: string, body_revision: number }
  } | {
    ok: false
    code: Exclude<MapAccessCode, 'ok'>
    actor_id: ActorId
    required_capability?: ActorCapability
  } {
    const status = getStatus(actorId)
    const snapshot = status.runtime
    if (!status.found || snapshot === undefined) return { ok: false, code: 'unknown_actor', actor_id: actorId }
    if (!snapshot.registered) return { ok: false, code: 'actor_not_registered', actor_id: actorId }
    if (capability !== undefined && !has_capability(snapshot.capabilities, capability)) {
      return { ok: false, code: 'missing_capability', actor_id: actorId, required_capability: capability }
    }
    const physical = snapshot.physical
    if (snapshot.state !== 'online' || physical === undefined || physical.kind !== 'standalone_character') {
      return { ok: false, code: 'no_body', actor_id: actorId }
    }
    const surface = game.surfaces[physical.surfaceIndex]
    if (surface === undefined) return { ok: false, code: 'no_body', actor_id: actorId }
    const actor = resolvePhysicalActor(surface, physical.physicalActorId)
    if (actor === undefined || !actor.is_valid || actor.force.index !== physical.forceIndex || actor.surface.index !== physical.surfaceIndex) {
      return { ok: false, code: 'no_body', actor_id: actorId }
    }
    return {
      ok: true,
      code: 'ok',
      actor,
      observer: {
        actor_id: actorId,
        agent_id: snapshot.agentId,
        body_revision: snapshot.bodyRevision,
      },
    }
  }

  function context(actorId: ActorId) {
    const resolved = resolve_actor(actorId)
    if (!resolved.ok) return resolved
    return {
      ok: true as const,
      code: 'ok' as const,
      policy: {
        map_first: true,
        charted_only: true,
        live_operations_require_visibility: true,
        physical_fallback_only_when_required: true,
        actor_scoped: true,
      },
      observer: resolved.observer,
      actor: resolved.actor.status_snapshot(),
      physical_surface: {
        index: resolved.actor.surface.index,
        name: resolved.actor.surface.name,
      },
    }
  }

  function query_area(
    actorId: ActorId,
    surfaceIndex: number,
    x: number,
    y: number,
    radius: number = 32,
    limit: number = 32,
    name?: string,
  ) {
    const resolved = resolve_actor(actorId, 'inspect')
    if (!resolved.ok) return { ...resolved, entities: [] }
    return {
      ...query_charted_entities(resolved.actor, surfaceIndex, x, y, radius, limit, name),
      observer: resolved.observer,
    }
  }

  function inspect_entity(actorId: ActorId, unitNumber: number) {
    const resolved = resolve_actor(actorId, 'inspect')
    if (!resolved.ok) return { ...resolved, unit_number: unitNumber }
    return {
      ...inspect_charted_entity(resolved.actor, unitNumber),
      observer: resolved.observer,
    }
  }

  function set_machine_recipe(actorId: ActorId, unitNumber: number, recipeName: string) {
    const resolved = resolve_actor(actorId, 'build')
    if (!resolved.ok) {
      return {
        accepted: false as const,
        completed: false as const,
        code: resolved.code,
        actor_id: actorId,
        unit_number: unitNumber,
        recipe_name: recipeName,
      }
    }
    return {
      ...set_charted_machine_recipe(resolved.actor, unitNumber, recipeName),
      observer: resolved.observer,
    }
  }

  return {
    context,
    query_area,
    inspect_entity,
    set_machine_recipe,
  }
}

export function create_swarm_map_remote_interface() {
  const service = new_swarm_map_service(actorId => remote.call('autorio_swarm', 'status', actorId) as SwarmRuntimeStatus)
  remote.add_interface('autorio_swarm_map', {
    context: (actor_id: ActorId) => service.context(actor_id),
    query_area: (
      actor_id: ActorId,
      surface_index: number,
      x: number,
      y: number,
      radius: number = 32,
      limit: number = 32,
      name?: string,
    ) => service.query_area(actor_id, surface_index, x, y, radius, limit, name),
    inspect_entity: (actor_id: ActorId, unit_number: number) => service.inspect_entity(actor_id, unit_number),
    set_machine_recipe: (actor_id: ActorId, unit_number: number, recipe_name: string) => service.set_machine_recipe(actor_id, unit_number, recipe_name),
  })
}
