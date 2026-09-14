import { TaskStates } from '../types'
import { complete_work_from_result, create_request, post_observation, post_result } from './blackboard'
import { activate_claim, heartbeat_claim, release_claim } from './claims'
import type { new_actor_registry } from './actor_registry'
import type { new_actor_runtime_router } from './actor_runtime_router'
import type { ActorId, ClaimId, SimulationTick, SwarmStorage, WorkClaim, WorkItem } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>
type ActorRuntimeRouter = ReturnType<typeof new_actor_runtime_router>

type ItemExecutionCode
  = 'queued'
    | 'completed'
    | 'actor_busy'
    | 'actor_not_attached'
    | 'no_body'
    | 'wrong_surface'
    | 'submit_failed'
    | 'unsupported_work'

export interface ItemWorkExecutorOptions {
  leaseTicks: number
  heartbeatIntervalTicks: number
  minimumProgressDistance: number
}

const RESOURCE_INTERACTION_RADIUS = 4

function squared_distance(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function inventory_count(actor: NonNullable<ReturnType<ActorRegistry['resolve_actor']>>, itemName: string) {
  return actor.get_main_inventory()?.get_item_count(itemName) ?? 0
}

export function supports_item_work(work: WorkItem) {
  return work.goal.kind === 'gather_resource'
}

export function new_item_work_executor(
  swarm: SwarmStorage,
  registry: ActorRegistry,
  router: ActorRuntimeRouter,
  options: ItemWorkExecutorOptions,
) {
  const operationByClaim: Record<ClaimId, number> = {}
  const lastInventoryByClaim: Record<ClaimId, number> = {}
  const lastDistanceByClaim: Record<ClaimId, number> = {}

  function context_for(actorId: ActorId) {
    return router.get_context(actorId)
  }

  function clear_claim_state(claimId: ClaimId) {
    delete operationByClaim[claimId]
    delete lastInventoryByClaim[claimId]
    delete lastDistanceByClaim[claimId]
  }

  function cancel_context_work(actorId: ActorId) {
    const context = context_for(actorId)
    if (context === undefined) return
    context.manager.cancel_all_tasks()
  }

  function complete_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource') return { ok: false as const, code: 'unsupported_work' as const }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return { ok: false as const, code: 'no_body' as const }

    const held = inventory_count(actor, work.goal.itemName)
    if (held < work.goal.count) return { ok: false as const, code: 'not_satisfied' as const }

    cancel_context_work(claim.actorId)
    const observation = post_observation(swarm, {
      observer: claim.agentId,
      subject: `resource acquisition completed for ${work.id}`,
      location: work.goal.source,
      evidenceClass: 'measured',
      data: {
        itemName: work.goal.itemName,
        resourceName: work.goal.resourceName,
        inventoryCount: held,
        requiredCount: work.goal.count,
      },
      observedTick: tick,
    })
    const evidence = [{ kind: 'observation' as const, id: observation.id, tick }]
    const result = post_result(swarm, {
      workId: work.id,
      agentId: claim.agentId,
      status: 'success',
      evidence,
      summary: `Acquired at least ${work.goal.count} ${work.goal.itemName}; measured inventory ${held}`,
      tick,
    })
    const completed = complete_work_from_result(swarm, work.id, work.revision, result.id, tick)
    if (completed.ok) clear_claim_state(claim.id)
    return completed
  }

  function block_missing_resource(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource') return { ok: false as const, code: 'unsupported_work' as const }
    const actor = registry.resolve_actor(claim.actorId, tick)
    const held = actor !== undefined && actor.is_valid ? inventory_count(actor, work.goal.itemName) : 0
    const remaining = math.max(1, work.goal.count - held)
    cancel_context_work(claim.actorId)
    const request = create_request(swarm, {
      kind: 'material_request',
      requester: 'system',
      missionId: work.missionId,
      objectiveId: work.objectiveId,
      projectId: work.projectId,
      priority: math.min(100, work.priority + 5),
      description: `Resource source ${work.goal.resourceName} could not satisfy ${work.goal.itemName} for ${work.id}`,
      itemName: work.goal.itemName,
      count: remaining,
      destination: work.goal.source,
      blocksWorkIds: [work.id],
      createdTick: tick,
    })
    const released = release_claim(swarm, {
      claimId: claim.id,
      tick,
      reason: 'target_missing',
      blockerRequestId: request.id,
    })
    clear_claim_state(claim.id)
    return released.ok
      ? { ok: true as const, request, work: released.work }
      : { ok: false as const, code: 'claim_release_failed' as const, request }
  }

  function dispatch_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick): { ok: boolean, code: ItemExecutionCode } {
    if (work.goal.kind !== 'gather_resource') return { ok: false, code: 'unsupported_work' }
    const context = context_for(claim.actorId)
    if (context === undefined) return { ok: false, code: 'actor_not_attached' }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) {
      return { ok: false, code: 'actor_busy' }
    }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) return { ok: false, code: 'no_body' }
    if (actor.surface.index !== work.goal.source.surfaceIndex) return { ok: false, code: 'wrong_surface' }

    const held = inventory_count(actor, work.goal.itemName)
    if (held >= work.goal.count) {
      complete_gather(claim, work, tick)
      return { ok: true, code: 'completed' }
    }

    const target = work.goal.source.position
    const distanceSquared = squared_distance(actor.position.x, actor.position.y, target.x, target.y)
    if (distanceSquared > RESOURCE_INTERACTION_RADIUS * RESOURCE_INTERACTION_RADIUS) {
      context.manager.add_task({
        type: TaskStates.WALKING_DIRECT,
        target_position: { x: target.x, y: target.y },
      })
      lastDistanceByClaim[claim.id] = Math.sqrt(distanceSquared)
      lastInventoryByClaim[claim.id] = held
      return { ok: true, code: 'queued' }
    }

    const remaining = work.goal.count - held
    const accepted = context.basic.submit_mining(work.goal.resourceName, math.min(1000, remaining))
    if (!accepted) return { ok: false, code: 'submit_failed' }
    const operationId = context.basic.status().last_result?.operation_id
    if (operationId !== undefined) operationByClaim[claim.id] = operationId
    lastInventoryByClaim[claim.id] = held
    lastDistanceByClaim[claim.id] = Math.sqrt(distanceSquared)
    return { ok: true, code: 'queued' }
  }

  function maybe_heartbeat_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource') return
    if (tick - claim.lastProgressTick < options.heartbeatIntervalTicks) return
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid || actor.surface.index !== work.goal.source.surfaceIndex) return

    const held = inventory_count(actor, work.goal.itemName)
    const target = work.goal.source.position
    const distance = Math.sqrt(squared_distance(actor.position.x, actor.position.y, target.x, target.y))
    const previousInventory = lastInventoryByClaim[claim.id]
    const previousDistance = lastDistanceByClaim[claim.id]
    const inventoryProgress = previousInventory !== undefined && held > previousInventory
    const movementProgress = previousDistance !== undefined && previousDistance - distance >= options.minimumProgressDistance
    if (!inventoryProgress && !movementProgress) return

    const observation = post_observation(swarm, {
      observer: claim.agentId,
      subject: `resource acquisition progress for ${work.id}`,
      location: work.goal.source,
      evidenceClass: 'measured',
      data: {
        itemName: work.goal.itemName,
        inventoryCount: held,
        requiredCount: work.goal.count,
        distanceToSource: distance,
      },
      observedTick: tick,
    })
    const evidence = [{ kind: 'observation' as const, id: observation.id, tick }]
    const heartbeat = heartbeat_claim(swarm, {
      claimId: claim.id,
      tick,
      leaseTicks: options.leaseTicks,
      bodyRevision: claim.actorBodyRevision,
      usefulProgress: true,
      summary: inventoryProgress
        ? `Gathered ${held}/${work.goal.count} ${work.goal.itemName}`
        : `Moved closer to ${work.goal.resourceName} source`,
      evidence,
    })
    if (heartbeat.ok) {
      lastInventoryByClaim[claim.id] = held
      lastDistanceByClaim[claim.id] = distance
    }
  }

  function process_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource') return
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return
    if (inventory_count(actor, work.goal.itemName) >= work.goal.count) {
      complete_gather(claim, work, tick)
      return
    }

    const context = context_for(claim.actorId)
    if (context === undefined) return
    if (context.manager.player_state.task_state === TaskStates.IDLE && context.manager.is_task_queue_empty()) {
      const operationId = operationByClaim[claim.id]
      const lastResult = context.basic.status().last_result
      if (operationId !== undefined && lastResult?.operation_id === operationId && !lastResult.completed && lastResult.code !== 'queued') {
        if (lastResult.code === 'no_target' || lastResult.code === 'target_gone' || lastResult.code === 'invalid_entity') {
          block_missing_resource(claim, work, tick)
          return
        }
        delete operationByClaim[claim.id]
      }
      dispatch_gather(claim, work, tick)
      return
    }
    maybe_heartbeat_gather(claim, work, tick)
  }

  function dispatch(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind === 'gather_resource') return dispatch_gather(claim, work, tick)
    return { ok: false as const, code: 'unsupported_work' as const }
  }

  function process(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (!supports_item_work(work)) return false
    const runtime = registry.runtime_snapshot(claim.actorId, tick)
    if (runtime === undefined || !runtime.registered || runtime.state !== 'online') {
      cancel_context_work(claim.actorId)
      release_claim(swarm, { claimId: claim.id, tick, reason: 'actor_recovery' })
      clear_claim_state(claim.id)
      return true
    }
    if (runtime.bodyRevision !== claim.actorBodyRevision) {
      cancel_context_work(claim.actorId)
      release_claim(swarm, { claimId: claim.id, tick, reason: 'actor_recovery' })
      clear_claim_state(claim.id)
      return true
    }
    if (claim.leaseUntilTick <= tick) {
      cancel_context_work(claim.actorId)
      release_claim(swarm, { claimId: claim.id, tick, reason: 'no_progress_timeout' })
      clear_claim_state(claim.id)
      return true
    }
    if (claim.state === 'claimed') {
      const activated = activate_claim(swarm, claim.id, tick)
      if (!activated.ok) return true
    }
    process_gather(claim, work, tick)
    return true
  }

  return {
    supports: supports_item_work,
    dispatch,
    process,
    clear_claim_state,
  }
}
