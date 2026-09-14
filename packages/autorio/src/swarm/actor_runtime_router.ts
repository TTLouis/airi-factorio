import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import { TaskStates } from '../types'
import type { new_actor_registry } from './actor_registry'
import { new_actor_runtime_context } from './actor_runtime_context'
import type { ActorId } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>
type ActorRuntimeContext = ReturnType<typeof new_actor_runtime_context>

export function new_actor_runtime_router(registry: ActorRegistry) {
  const contexts: Record<ActorId, ActorRuntimeContext> = {}

  function attach(actorId: ActorId) {
    if (contexts[actorId] !== undefined) return { ok: false as const, code: 'already_attached' as const }
    const snapshot = registry.runtime_snapshot(actorId, game.tick)
    if (snapshot === undefined) return { ok: false as const, code: 'unknown_actor' as const }
    if (!snapshot.registered) return { ok: false as const, code: 'actor_not_registered' as const }
    const context = new_actor_runtime_context(actorId, registry)
    contexts[actorId] = context
    return { ok: true as const, context }
  }

  function detach(actorId: ActorId) {
    const context = contexts[actorId]
    if (context === undefined) return { ok: false as const, code: 'not_attached' as const }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) {
      return { ok: false as const, code: 'actor_busy' as const }
    }
    delete contexts[actorId]
    return { ok: true as const }
  }

  function get_context(actorId: ActorId) {
    return contexts[actorId]
  }

  function sorted_actor_ids() {
    const ids: ActorId[] = []
    for (const actorId in contexts) ids.push(actorId)
    ids.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return ids
  }

  function tick_all() {
    const results: Array<{ actorId: ActorId, actorAvailable: boolean }> = []
    for (const actorId of sorted_actor_ids()) {
      results.push({ actorId, actorAvailable: contexts[actorId].tick() })
    }
    return results
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    let owner: ActorRuntimeContext | undefined
    for (const actorId of sorted_actor_ids()) {
      const context = contexts[actorId]
      if (!context.navigation.owns_path_request(event.id)) continue
      if (owner !== undefined) {
        log(`[AUTORIO] [ERROR] Duplicate swarm path ownership for request id=${event.id}`)
        return { handled: false as const, code: 'ambiguous_owner' as const }
      }
      owner = context
    }
    if (owner === undefined) return { handled: false as const, code: 'not_owned' as const }
    return {
      handled: owner.on_path_finished(event),
      actorId: owner.actorId,
    }
  }

  function on_player_mined_entity(playerIndex: number) {
    let owner: ActorRuntimeContext | undefined
    for (const actorId of sorted_actor_ids()) {
      const context = contexts[actorId]
      if (!context.owns_player_index(playerIndex)) continue
      if (owner !== undefined) {
        log(`[AUTORIO] [ERROR] Duplicate swarm player ownership for player_index=${playerIndex}`)
        return { handled: false as const, code: 'ambiguous_owner' as const }
      }
      owner = context
    }
    if (owner === undefined) return { handled: false as const, code: 'not_owned' as const }
    return {
      handled: owner.on_player_mined_entity(playerIndex),
      actorId: owner.actorId,
    }
  }

  function status() {
    return sorted_actor_ids().map(actorId => contexts[actorId].status())
  }

  return {
    attach,
    detach,
    get_context,
    tick_all,
    on_path_finished,
    on_player_mined_entity,
    status,
  }
}
