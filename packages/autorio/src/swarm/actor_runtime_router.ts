import type { OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import { TaskStates } from '../types'
import { get_actor_inventory_items } from '../utils/inventory'
import type { new_actor_registry } from './actor_registry'
import { new_actor_runtime_context } from './actor_runtime_context'
import { display_name_for_agent } from './names'
import { get_swarm_storage } from './storage'
import type { ActorId } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>
type ActorRuntimeContext = ReturnType<typeof new_actor_runtime_context>

type DirectAccessCode
  = 'ready'
    | 'unknown_actor'
    | 'actor_not_registered'
    | 'actor_not_attached'
    | 'actor_missing'
    | 'agent_not_bound'
    | 'agent_unavailable'
    | 'actor_claimed'
    | 'stale_authority'

function direct_authority_token(actorId: ActorId, actorRevision: number, bodyRevision: number, agentRevision: number) {
  return `${actorId}:${actorRevision}:${bodyRevision}:${agentRevision}`
}

export function new_actor_runtime_router(registry: ActorRegistry) {
  const contexts: Record<ActorId, ActorRuntimeContext> = {}
  const swarm = get_swarm_storage()

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
      const ownsNavigationPath = context.navigation.owns_path_request(event.id)
      const ownsCombatPath = context.combat.owns_path_request(event.id)
      if (!ownsNavigationPath && !ownsCombatPath) continue
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

  function active_claim(actorId: ActorId, agentId: string) {
    for (const claimId in swarm.board.claims) {
      const claim = swarm.board.claims[claimId]
      if (claim.actorId === actorId || claim.agentId === agentId) return claim
    }
    return undefined
  }

  function direct_snapshot(actorId: ActorId) {
    let runtime = registry.runtime_snapshot(actorId, game.tick)
    if (runtime === undefined) {
      return { found: false as const, actorId, allowed: false as const, code: 'unknown_actor' as DirectAccessCode }
    }

    const context = contexts[actorId]
    const actor = registry.resolve_actor(actorId, game.tick)
    runtime = registry.runtime_snapshot(actorId, game.tick) ?? runtime
    const agentId = runtime.agentId
    const agent = agentId !== undefined ? swarm.agents[agentId] : undefined
    const claim = agentId !== undefined ? active_claim(actorId, agentId) : undefined

    let code: DirectAccessCode = 'ready'
    if (!runtime.registered) code = 'actor_not_registered'
    else if (context === undefined) code = 'actor_not_attached'
    else if (runtime.state !== 'online' || actor === undefined || !actor.is_valid || actor.character === undefined) code = 'actor_missing'
    else if (agentId === undefined || agent === undefined || agent.actorId !== actorId) code = 'agent_not_bound'
    else if (claim !== undefined) code = 'actor_claimed'
    else if (agent.state !== 'available' || agent.currentWorkId !== undefined) code = 'agent_unavailable'

    const allowed = code === 'ready' && agent !== undefined
    const authorityToken = allowed
      ? direct_authority_token(actorId, runtime.revision, runtime.bodyRevision, agent!.revision)
      : undefined

    return {
      found: true as const,
      actorId,
      agentId,
      displayName: agentId !== undefined ? display_name_for_agent(agentId) : undefined,
      allowed,
      code,
      authority_token: authorityToken,
      actor_revision: runtime.revision,
      body_revision: runtime.bodyRevision,
      agent_revision: agent?.revision,
      runtime,
      agent,
      actor: actor?.status_snapshot(),
      inventory: actor && actor.is_valid ? get_actor_inventory_items(actor) : [],
      tasks: context?.manager.get_status_snapshot(),
      basic: context?.basic.status(),
      navigation: context?.navigation.status(),
      crafting: context?.crafting.status(),
      combat: context?.combat.status(),
      claim_id: claim?.id,
      work_id: claim?.workId,
    }
  }

  function authorize(actorId: ActorId, authorityToken: string) {
    const snapshot = direct_snapshot(actorId)
    return snapshot.allowed === true && snapshot.authority_token === authorityToken
  }

  function guarded(actorId: ActorId, authorityToken: string, operation: (context: ActorRuntimeContext) => any) {
    const snapshot = direct_snapshot(actorId)
    if (!snapshot.allowed) return { ok: false as const, code: snapshot.code }
    if (typeof authorityToken !== 'string' || snapshot.authority_token !== authorityToken) {
      return { ok: false as const, code: 'stale_authority' as const }
    }
    const context = contexts[actorId]
    if (context === undefined) return { ok: false as const, code: 'actor_not_attached' as const }
    return operation(context)
  }

  function tuple_result(result: [boolean, string], controllerStatus: unknown) {
    return { ok: result[0], message: result[1], status: controllerStatus }
  }

  remote.add_interface('autorio_swarm_actor', {
    status: (actor_id: ActorId) => direct_snapshot(actor_id),
    authorize: (actor_id: ActorId, authority_token: string) => authorize(actor_id, authority_token),
    walk_to_entity: (actor_id: ActorId, authority_token: string, entity_name: string, search_radius: number) =>
      guarded(actor_id, authority_token, (context) => {
        const accepted = context.navigation.submit(entity_name, search_radius)
        return { ok: accepted, status: context.navigation.status() }
      }),
    walk_to_player: (actor_id: ActorId, authority_token: string, player_name: string) =>
      guarded(actor_id, authority_token, context => tuple_result(context.navigation.submit_player(player_name), context.navigation.status())),
    gather_resource: (actor_id: ActorId, authority_token: string, resource_name: string, count: number = 1, search_radius: number = 256) =>
      guarded(actor_id, authority_token, context => tuple_result(context.composite.gather_resource(resource_name, count, search_radius), {
        navigation: context.navigation.status(),
        basic: context.basic.status(),
      })),
    mine_entity: (actor_id: ActorId, authority_token: string, entity_name: string, count: number = 1) =>
      guarded(actor_id, authority_token, (context) => {
        const accepted = context.basic.submit_mining(entity_name, count)
        return { ok: accepted, status: context.basic.status() }
      }),
    place_entity: (actor_id: ActorId, authority_token: string, entity_name: string, x?: number, y?: number, direction?: number) =>
      guarded(actor_id, authority_token, (context) => {
        const accepted = context.basic.submit_placement(entity_name, x, y, direction)
        return { ok: accepted, status: context.basic.status() }
      }),
    move_items: (actor_id: ActorId, authority_token: string, item_name: string, entity_name: string, max_count: number, to_entity: boolean) =>
      guarded(actor_id, authority_token, context => tuple_result(context.basic.submit_move(item_name, entity_name, max_count, to_entity), context.basic.status())),
    move_items_exact: (actor_id: ActorId, authority_token: string, item_name: string, unit_number: number, max_count: number, to_entity: boolean) =>
      guarded(actor_id, authority_token, context => tuple_result(context.basic.submit_move_exact(item_name, unit_number, max_count, to_entity), context.basic.status())),
    set_machine_recipe: (actor_id: ActorId, authority_token: string, unit_number: number, recipe_name: string) =>
      guarded(actor_id, authority_token, context => tuple_result(context.basic.submit_set_recipe_exact(unit_number, recipe_name), context.basic.status())),
    move_items_with_player: (actor_id: ActorId, authority_token: string, item_name: string, player_name: string, max_count: number, to_player: boolean) =>
      guarded(actor_id, authority_token, context => tuple_result(context.basic.submit_player_move(item_name, player_name, max_count, to_player), context.basic.status())),
    wait: (actor_id: ActorId, authority_token: string, ticks: number) =>
      guarded(actor_id, authority_token, context => tuple_result(context.basic.submit_wait(ticks), context.basic.status())),
    craft_item: (actor_id: ActorId, authority_token: string, item_name: string, count: number = 1) =>
      guarded(actor_id, authority_token, context => tuple_result(context.crafting.submit(item_name, count), context.crafting.status())),
    attack_nearest_enemy: (actor_id: ActorId, authority_token: string, search_radius: number = 50) =>
      guarded(actor_id, authority_token, context => tuple_result(context.combat.submit(search_radius), context.combat.status())),
    clear_enemy_area: (actor_id: ActorId, authority_token: string, search_radius: number = 96) =>
      guarded(actor_id, authority_token, context => tuple_result(context.combat.submit_clear(search_radius), context.combat.status())),
    cancel_all_tasks: (actor_id: ActorId, authority_token: string) =>
      guarded(actor_id, authority_token, (context) => {
        context.manager.cancel_all_tasks('swarm_direct_cancel')
        return { ok: true as const, tasks: context.manager.get_status_snapshot() }
      }),
  })

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
