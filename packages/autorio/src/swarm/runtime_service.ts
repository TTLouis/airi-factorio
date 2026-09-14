import type { MapPositionStruct } from 'factorio:prototype'
import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { new_standalone_actor_pool } from './standalone_actor_pool'
import { get_swarm_storage } from './storage'
import type { ActorCapability, ActorId } from './types'

const DEFAULT_STANDALONE_CAPABILITIES: ActorCapability[] = [
  'move',
  'mine',
  'craft',
  'build',
  'transfer',
  'combat',
  'inspect',
  'survey',
]

function valid_coordinate(value: number | undefined) {
  return value === undefined || (typeof value === 'number' && value === value && math.abs(value) < 1000000)
}

export function new_swarm_runtime_service() {
  const swarm = get_swarm_storage()
  const registry = new_actor_registry(swarm)
  const pool = new_standalone_actor_pool(swarm, registry)
  const router = new_actor_runtime_router(registry)

  // Ordinary module locals are rebuilt after a save/load. Swarm storage keeps
  // logical and physical identity, so reconstruct runtime registrations and
  // volatile contexts around any persisted standalone bodies.
  for (const actorId in swarm.actors) {
    const state = swarm.actors[actorId]
    if (state.physical?.kind !== 'standalone_character') continue
    const registered = pool.register_actor(actorId, DEFAULT_STANDALONE_CAPABILITIES, game.tick)
    if (registered.ok) router.attach(actorId)
  }

  function cleanup_failed_creation(actorId: ActorId, agentId: string) {
    pool.unregister_actor(actorId)
    delete swarm.agents[agentId]
    delete swarm.actors[actorId]
  }

  function resolve_spawn(
    surfaceIndex: number,
    forceName: string,
    x?: number,
    y?: number,
  ) {
    if (!valid_coordinate(x) || !valid_coordinate(y)) return { ok: false as const, code: 'invalid_position' as const }
    const surface = game.surfaces[surfaceIndex]
    if (surface === undefined) return { ok: false as const, code: 'unknown_surface' as const }
    const force = game.forces[forceName]
    if (force === undefined) return { ok: false as const, code: 'unknown_force' as const }
    const base = force.get_spawn_position(surface)
    const requested: MapPositionStruct = {
      x: x ?? base.x,
      y: y ?? base.y,
    }
    const position = surface.find_non_colliding_position('character', requested, 32, 0.5) ?? requested
    return { ok: true as const, surface, force, position }
  }

  function create_actor(
    x?: number,
    y?: number,
    surfaceIndex: number = 1,
    forceName: string = 'player',
  ) {
    const spawn = resolve_spawn(surfaceIndex, forceName, x, y)
    if (!spawn.ok) return spawn

    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const registered = pool.register_actor(actorId, DEFAULT_STANDALONE_CAPABILITIES, game.tick)
    if (!registered.ok) {
      delete swarm.agents[agent.id]
      delete swarm.actors[actorId]
      return { ok: false as const, code: registered.code }
    }

    const created = pool.create_body(actorId, spawn.surface, spawn.force, spawn.position, game.tick)
    if (!created.ok) {
      cleanup_failed_creation(actorId, agent.id)
      return { ok: false as const, code: created.code }
    }

    const attached = router.attach(actorId)
    if (!attached.ok) {
      created.actor.character?.destroy()
      cleanup_failed_creation(actorId, agent.id)
      return { ok: false as const, code: attached.code }
    }

    return {
      ok: true as const,
      actorId,
      agentId: agent.id,
      runtime: registry.runtime_snapshot(actorId, game.tick),
      actor: created.actor.status_snapshot(),
    }
  }

  function actor_status(actorId: ActorId) {
    const runtime = registry.runtime_snapshot(actorId, game.tick)
    if (runtime === undefined) return { found: false as const, actorId, code: 'unknown_actor' as const }
    const context = router.get_context(actorId)
    const actor = registry.resolve_actor(actorId, game.tick)
    return {
      found: true as const,
      actorId,
      runtime: registry.runtime_snapshot(actorId, game.tick),
      actor: actor?.status_snapshot(),
      tasks: context?.manager.get_status_snapshot(),
      basic: context?.basic.status(),
      navigation: context?.navigation.status(),
      crafting: context?.crafting.status(),
      combat: context?.combat.status(),
    }
  }

  function status(actorId?: ActorId) {
    if (actorId !== undefined) return actor_status(actorId)
    const ids: ActorId[] = []
    for (const id in swarm.actors) ids.push(id)
    ids.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return {
      tick: game.tick,
      actors: ids.map(id => actor_status(id)),
    }
  }

  function context_for(actorId: ActorId) {
    return router.get_context(actorId)
  }

  function wait(actorId: ActorId, ticks: number) {
    const context = context_for(actorId)
    if (context === undefined) return { ok: false as const, code: 'actor_not_attached' as const }
    const result = context.basic.submit_wait(ticks)
    return { ok: result[0], message: result[1] }
  }

  function walk_to_position(actorId: ActorId, x: number, y: number) {
    if (!valid_coordinate(x) || !valid_coordinate(y)) return { ok: false as const, code: 'invalid_position' as const }
    const context = context_for(actorId)
    if (context === undefined) return { ok: false as const, code: 'actor_not_attached' as const }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) {
      return { ok: false as const, code: 'actor_busy' as const }
    }
    const actor = registry.resolve_actor(actorId, game.tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) {
      return { ok: false as const, code: 'no_body' as const }
    }
    context.manager.add_task({
      type: TaskStates.WALKING_DIRECT,
      target_position: { x, y },
    })
    return { ok: true as const }
  }

  function cancel(actorId: ActorId) {
    const context = context_for(actorId)
    if (context === undefined) return { ok: false as const, code: 'actor_not_attached' as const }
    context.manager.cancel_all_tasks()
    return { ok: true as const }
  }

  function destroy_body(actorId: ActorId) {
    const context = context_for(actorId)
    const actor = registry.resolve_actor(actorId, game.tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) {
      return { ok: false as const, code: 'no_body' as const }
    }
    const previous = registry.runtime_snapshot(actorId, game.tick)
    const physicalActorId = actor.status_snapshot().actor_id
    const destroyed = actor.character.destroy()
    pool.forget_cached_body(actorId)
    registry.reconcile_actor(actorId, game.tick)
    context?.discard_volatile_work_after_actor_loss()
    return {
      ok: destroyed,
      actorId,
      physicalActorId,
      previousBodyRevision: previous?.bodyRevision,
      runtime: registry.runtime_snapshot(actorId, game.tick),
    }
  }

  function replace_body(
    actorId: ActorId,
    x?: number,
    y?: number,
    surfaceIndex: number = 1,
    forceName: string = 'player',
  ) {
    const context = context_for(actorId)
    if (context === undefined) return { ok: false as const, code: 'actor_not_attached' as const }
    const spawn = resolve_spawn(surfaceIndex, forceName, x, y)
    if (!spawn.ok) return spawn
    const created = pool.create_body(actorId, spawn.surface, spawn.force, spawn.position, game.tick)
    if (!created.ok) return { ok: false as const, code: created.code }
    return {
      ok: true as const,
      actorId,
      runtime: registry.runtime_snapshot(actorId, game.tick),
      actor: created.actor.status_snapshot(),
    }
  }

  function tick_all() {
    return router.tick_all()
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    return router.on_path_finished(event)
  }

  function on_player_mined_entity(playerIndex: number) {
    return router.on_player_mined_entity(playerIndex)
  }

  return {
    create_actor,
    status,
    wait,
    walk_to_position,
    cancel,
    destroy_body,
    replace_body,
    tick_all,
    on_path_finished,
    on_player_mined_entity,
  }
}
