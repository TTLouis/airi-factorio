import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaForce, LuaSurface } from 'factorio:runtime'
import { StandaloneCharacterActor } from '../actors/standalone_character_actor'
import type { ActorCapability, ActorId, SimulationTick, SwarmStorage } from './types'
import type { new_actor_registry } from './actor_registry'

type ActorRegistry = ReturnType<typeof new_actor_registry>

function has_active_claim(swarm: SwarmStorage, actorId: ActorId) {
  for (const claimId in swarm.board.claims) {
    if (swarm.board.claims[claimId].actorId === actorId) return true
  }
  return false
}

export function new_standalone_actor_pool(swarm: SwarmStorage, registry: ActorRegistry) {
  const cached: Record<ActorId, StandaloneCharacterActor> = {}

  function reacquire_persisted_body(actorId: ActorId) {
    const state = swarm.actors[actorId]
    const physical = state?.physical
    if (physical === undefined || physical.kind !== 'standalone_character') return undefined

    const surface = game.surfaces[physical.surfaceIndex]
    if (surface === undefined) return undefined
    const actor = StandaloneCharacterActor.reacquire_unit(surface, physical.physicalActorId)
    if (actor === undefined || !actor.is_valid) return undefined
    if (actor.force.index !== physical.forceIndex) return undefined
    return actor
  }

  function resolve_body(actorId: ActorId) {
    const current = cached[actorId]
    if (current !== undefined && current.is_valid) return current
    if (current !== undefined) delete cached[actorId]

    const reacquired = reacquire_persisted_body(actorId)
    if (reacquired !== undefined) cached[actorId] = reacquired
    return reacquired
  }

  function register_actor(actorId: ActorId, capabilities: ActorCapability[], tick: SimulationTick) {
    return registry.register_actor(actorId, {
      resolve: () => resolve_body(actorId),
      capabilities,
    }, tick)
  }

  function create_body(actorId: ActorId, surface: LuaSurface, force: LuaForce, position: MapPositionStruct, tick: SimulationTick) {
    const state = swarm.actors[actorId]
    if (state === undefined) return { ok: false as const, code: 'unknown_actor' as const }

    const snapshot = registry.runtime_snapshot(actorId, tick)
    if (snapshot === undefined || !snapshot.registered) return { ok: false as const, code: 'not_registered' as const }

    const existing = resolve_body(actorId)
    if (existing !== undefined) return { ok: false as const, code: 'body_already_exists' as const, actor: existing }

    // Replacing a missing physical body while a claim still references its old
    // generation would make the claim stale behind the scheduler's back. The
    // recovery layer must release/reconcile that claim before creating a body.
    if (has_active_claim(swarm, actorId)) return { ok: false as const, code: 'actor_has_active_claim' as const }

    const actor = StandaloneCharacterActor.create_untracked(surface, force, position)
    if (actor === undefined) return { ok: false as const, code: 'create_failed' as const }
    cached[actorId] = actor

    const reconciled = registry.reconcile_actor(actorId, tick)
    if (!reconciled.ok || reconciled.actor === undefined) {
      delete cached[actorId]
      return { ok: false as const, code: 'reconcile_failed' as const }
    }
    return { ok: true as const, actor, state: reconciled.state }
  }

  function forget_cached_body(actorId: ActorId) {
    if (cached[actorId] === undefined) return false
    delete cached[actorId]
    return true
  }

  function unregister_actor(actorId: ActorId) {
    forget_cached_body(actorId)
    return registry.unregister_actor(actorId)
  }

  return {
    register_actor,
    unregister_actor,
    resolve_body,
    create_body,
    forget_cached_body,
  }
}
