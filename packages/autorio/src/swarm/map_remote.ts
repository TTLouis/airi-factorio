import type { ControlledActor } from '../actors/types'
import { inspect_charted_entity, query_charted_entities, set_charted_machine_recipe } from '../map_remote'
import type { new_actor_registry } from './actor_registry'
import type { ActorCapability, ActorId } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>

type MapAccessCode = 'ok' | 'unknown_actor' | 'actor_not_registered' | 'missing_capability' | 'no_body'

function has_capability(values: ActorCapability[], expected: ActorCapability) {
  for (const value of values) if (value === expected) return true
  return false
}

function observer_context(actorId: ActorId, snapshot: NonNullable<ReturnType<ActorRegistry['runtime_snapshot']>>) {
  return {
    actor_id: actorId,
    agent_id: snapshot.agentId,
    body_revision: snapshot.bodyRevision,
  }
}

export function new_swarm_map_service(registry: ActorRegistry) {
  function resolve_actor(actorId: ActorId, capability?: ActorCapability): {
    ok: true
    code: 'ok'
    actor: ControlledActor
    observer: ReturnType<typeof observer_context>
  } | {
    ok: false
    code: Exclude<MapAccessCode, 'ok'>
    actor_id: ActorId
    required_capability?: ActorCapability
  } {
    const snapshot = registry.runtime_snapshot(actorId, game.tick)
    if (snapshot === undefined) return { ok: false, code: 'unknown_actor', actor_id: actorId }
    if (!snapshot.registered) return { ok: false, code: 'actor_not_registered', actor_id: actorId }
    if (capability !== undefined && !has_capability(snapshot.capabilities, capability)) {
      return { ok: false, code: 'missing_capability', actor_id: actorId, required_capability: capability }
    }
    const actor = registry.resolve_actor(actorId, game.tick)
    if (actor === undefined || !actor.is_valid) return { ok: false, code: 'no_body', actor_id: actorId }
    return { ok: true, code: 'ok', actor, observer: observer_context(actorId, snapshot) }
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
