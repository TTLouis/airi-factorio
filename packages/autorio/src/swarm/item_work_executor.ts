import { TaskStates } from '../types'
import { complete_work_from_result, create_request, post_observation, post_result } from './blackboard'
import { activate_claim, heartbeat_claim, release_claim } from './claims'
import type { new_actor_registry } from './actor_registry'
import type { new_actor_runtime_router } from './actor_runtime_router'
import type { ActorId, ClaimId, EvidenceClass, RequestKind, SimulationTick, SwarmStorage, WorkClaim, WorkItem, WorldLocation } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>
type ActorRuntimeRouter = ReturnType<typeof new_actor_runtime_router>
type ResolvedActor = NonNullable<ReturnType<ActorRegistry['resolve_actor']>>

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
const TRANSFER_INTERACTION_RADIUS = 7

function squared_distance(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function inventory_count(actor: ResolvedActor, itemName: string) {
  return actor.get_main_inventory()?.get_item_count(itemName) ?? 0
}

function endpoint_inventory_count(actor: ResolvedActor, entityName: string, location: WorldLocation, itemName: string) {
  if (actor.surface.index !== location.surfaceIndex) return { found: false, count: 0 }
  const entities = actor.surface.find_entities_filtered({
    position: location.position,
    radius: location.radius ?? 2,
    name: entityName,
    force: actor.force,
  })
  let count = 0
  for (const entity of entities) {
    const maxIndex = entity.get_max_inventory_index()
    for (let index = 1; index <= maxIndex; index += 1) {
      const inventory = entity.get_inventory(index)
      if (inventory !== undefined) count += inventory.get_item_count(itemName)
    }
  }
  return { found: entities.length > 0, count }
}

export function supports_item_work(work: WorkItem) {
  if (work.goal.kind === 'gather_resource' || work.goal.kind === 'craft_items') return true
  if (work.goal.kind === 'acquire_items') {
    return work.goal.source !== undefined && work.goal.sourceEntityName !== undefined && work.goal.sourceEntityName !== ''
  }
  if (work.goal.kind === 'deliver_items') {
    return work.goal.destinationEntityName !== undefined && work.goal.destinationEntityName !== ''
  }
  return false
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

  function finish_work(
    claim: WorkClaim,
    work: WorkItem,
    tick: SimulationTick,
    subject: string,
    summary: string,
    location: WorldLocation | undefined,
    data: Record<string, string | number | boolean>,
    evidenceClass: EvidenceClass = 'measured',
  ) {
    cancel_context_work(claim.actorId)
    const observation = post_observation(swarm, {
      observer: claim.agentId,
      subject,
      location,
      evidenceClass,
      data,
      observedTick: tick,
    })
    const evidence = [{ kind: 'observation' as const, id: observation.id, tick }]
    const result = post_result(swarm, {
      workId: work.id,
      agentId: claim.agentId,
      status: 'success',
      evidence,
      summary,
      tick,
    })
    const completed = complete_work_from_result(swarm, work.id, work.revision, result.id, tick)
    if (completed.ok) clear_claim_state(claim.id)
    return completed
  }

  function block_with_request(
    claim: WorkClaim,
    work: WorkItem,
    tick: SimulationTick,
    kind: RequestKind,
    description: string,
    releaseReason: 'supply_shortage' | 'target_missing' | 'blocker_discovered',
    details: { itemName?: string, count?: number, destination?: WorldLocation } = {},
  ) {
    cancel_context_work(claim.actorId)
    const request = create_request(swarm, {
      kind,
      requester: 'system',
      missionId: work.missionId,
      objectiveId: work.objectiveId,
      projectId: work.projectId,
      priority: math.min(100, work.priority + 5),
      description,
      itemName: details.itemName,
      count: details.count,
      destination: details.destination,
      blocksWorkIds: [work.id],
      createdTick: tick,
    })
    const released = release_claim(swarm, {
      claimId: claim.id,
      tick,
      reason: releaseReason,
      blockerRequestId: request.id,
    })
    clear_claim_state(claim.id)
    return released.ok
      ? { ok: true as const, request, work: released.work }
      : { ok: false as const, code: 'claim_release_failed' as const, request }
  }

  function block_material_shortage(
    claim: WorkClaim,
    work: WorkItem,
    tick: SimulationTick,
    itemName: string,
    count: number,
    destination: WorldLocation | undefined,
    description: string,
  ) {
    return block_with_request(claim, work, tick, 'material_request', description, 'supply_shortage', {
      itemName,
      count: math.max(1, count),
      destination,
    })
  }

  function block_missing_endpoint(claim: WorkClaim, work: WorkItem, tick: SimulationTick, destination: WorldLocation, description: string) {
    return block_with_request(claim, work, tick, 'construction_request', description, 'target_missing', { destination })
  }

  function complete_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource') return { ok: false as const, code: 'unsupported_work' as const }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return { ok: false as const, code: 'no_body' as const }
    const held = inventory_count(actor, work.goal.itemName)
    if (held < work.goal.count) return { ok: false as const, code: 'not_satisfied' as const }
    return finish_work(claim, work, tick, `resource acquisition completed for ${work.id}`,
      `Acquired at least ${work.goal.count} ${work.goal.itemName}; measured inventory ${held}`, work.goal.source, {
        itemName: work.goal.itemName,
        resourceName: work.goal.resourceName,
        inventoryCount: held,
        requiredCount: work.goal.count,
      })
  }

  function complete_acquire(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'acquire_items' || work.goal.source === undefined || work.goal.sourceEntityName === undefined) {
      return { ok: false as const, code: 'unsupported_work' as const }
    }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return { ok: false as const, code: 'no_body' as const }
    const held = inventory_count(actor, work.goal.itemName)
    if (held < work.goal.count) return { ok: false as const, code: 'not_satisfied' as const }
    const source = endpoint_inventory_count(actor, work.goal.sourceEntityName, work.goal.source, work.goal.itemName)
    return finish_work(claim, work, tick, `item pickup completed for ${work.id}`,
      `Acquired at least ${work.goal.count} ${work.goal.itemName} from ${work.goal.sourceEntityName}`, work.goal.source, {
        itemName: work.goal.itemName,
        inventoryCount: held,
        requiredCount: work.goal.count,
        sourceEntityName: work.goal.sourceEntityName,
        sourceInventoryCount: source.count,
      })
  }

  function complete_delivery(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'deliver_items' || work.goal.destinationEntityName === undefined) {
      return { ok: false as const, code: 'unsupported_work' as const }
    }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return { ok: false as const, code: 'no_body' as const }
    const destination = endpoint_inventory_count(actor, work.goal.destinationEntityName, work.goal.destination, work.goal.itemName)
    if (!destination.found || destination.count < work.goal.count) return { ok: false as const, code: 'not_satisfied' as const }
    return finish_work(claim, work, tick, `item delivery completed for ${work.id}`,
      `Delivered ${work.goal.itemName}; destination inventory reached ${destination.count}`, work.goal.destination, {
        itemName: work.goal.itemName,
        requiredCount: work.goal.count,
        destinationEntityName: work.goal.destinationEntityName,
        destinationInventoryCount: destination.count,
        actorInventoryCount: inventory_count(actor, work.goal.itemName),
      })
  }

  function complete_craft(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'craft_items') return { ok: false as const, code: 'unsupported_work' as const }
    const actor = registry.resolve_actor(claim.actorId, tick)
    const context = context_for(claim.actorId)
    if (actor === undefined || !actor.is_valid || context === undefined) return { ok: false as const, code: 'no_body' as const }
    const receipt = context.crafting.status().last_result
    if (receipt === undefined || !receipt.completed || receipt.code !== 'completed' || receipt.tick < claim.acquiredTick) {
      return { ok: false as const, code: 'not_satisfied' as const }
    }
    if (receipt.item_name !== work.goal.itemName || receipt.requested_count !== work.goal.count) {
      return { ok: false as const, code: 'receipt_mismatch' as const }
    }
    const produced = (receipt.output_count_after ?? 0) - (receipt.output_count_before ?? 0)
    if (produced < work.goal.count) return { ok: false as const, code: 'output_missing' as const }
    return finish_work(claim, work, tick, `crafting receipt completed for ${work.id}`,
      `Crafted ${work.goal.itemName} x${work.goal.count} with measured output delta ${produced}`, work.location, {
        itemName: work.goal.itemName,
        requestedCount: work.goal.count,
        startedCount: receipt.started_count ?? 0,
        outputCountBefore: receipt.output_count_before ?? 0,
        outputCountAfter: receipt.output_count_after ?? 0,
        producedCount: produced,
        receiptTick: receipt.tick,
      }, 'operation_receipt')
  }

  function block_missing_resource(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource') return { ok: false as const, code: 'unsupported_work' as const }
    const actor = registry.resolve_actor(claim.actorId, tick)
    const held = actor !== undefined && actor.is_valid ? inventory_count(actor, work.goal.itemName) : 0
    return block_material_shortage(claim, work, tick, work.goal.itemName, work.goal.count - held, work.goal.source,
      `Resource source ${work.goal.resourceName} could not satisfy ${work.goal.itemName} for ${work.id}`)
  }

  function queue_walk(claim: WorkClaim, actor: ResolvedActor, location: WorldLocation, interactionRadius: number) {
    const context = context_for(claim.actorId)
    if (context === undefined) return false
    const target = location.position
    const distanceSquared = squared_distance(actor.position.x, actor.position.y, target.x, target.y)
    if (distanceSquared <= interactionRadius * interactionRadius) return false
    context.manager.add_task({ type: TaskStates.WALKING_DIRECT, target_position: { x: target.x, y: target.y } })
    lastDistanceByClaim[claim.id] = Math.sqrt(distanceSquared)
    return true
  }

  function record_operation(claimId: ClaimId, operationId: number | undefined) {
    if (operationId !== undefined) operationByClaim[claimId] = operationId
  }

  function dispatch_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick): { ok: boolean, code: ItemExecutionCode } {
    if (work.goal.kind !== 'gather_resource') return { ok: false, code: 'unsupported_work' }
    const context = context_for(claim.actorId)
    if (context === undefined) return { ok: false, code: 'actor_not_attached' }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) return { ok: false, code: 'actor_busy' }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) return { ok: false, code: 'no_body' }
    if (actor.surface.index !== work.goal.source.surfaceIndex) return { ok: false, code: 'wrong_surface' }
    const held = inventory_count(actor, work.goal.itemName)
    if (held >= work.goal.count) {
      complete_gather(claim, work, tick)
      return { ok: true, code: 'completed' }
    }
    if (queue_walk(claim, actor, work.goal.source, RESOURCE_INTERACTION_RADIUS)) {
      lastInventoryByClaim[claim.id] = held
      return { ok: true, code: 'queued' }
    }
    const accepted = context.basic.submit_mining(work.goal.resourceName, math.min(1000, work.goal.count - held))
    if (!accepted) return { ok: false, code: 'submit_failed' }
    record_operation(claim.id, context.basic.status().last_result?.operation_id)
    lastInventoryByClaim[claim.id] = held
    return { ok: true, code: 'queued' }
  }

  function dispatch_acquire(claim: WorkClaim, work: WorkItem, tick: SimulationTick): { ok: boolean, code: ItemExecutionCode } {
    if (work.goal.kind !== 'acquire_items' || work.goal.source === undefined || work.goal.sourceEntityName === undefined) return { ok: false, code: 'unsupported_work' }
    const context = context_for(claim.actorId)
    if (context === undefined) return { ok: false, code: 'actor_not_attached' }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) return { ok: false, code: 'actor_busy' }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) return { ok: false, code: 'no_body' }
    if (actor.surface.index !== work.goal.source.surfaceIndex) return { ok: false, code: 'wrong_surface' }
    const held = inventory_count(actor, work.goal.itemName)
    if (held >= work.goal.count) {
      complete_acquire(claim, work, tick)
      return { ok: true, code: 'completed' }
    }
    const source = endpoint_inventory_count(actor, work.goal.sourceEntityName, work.goal.source, work.goal.itemName)
    if (!source.found || source.count <= 0) return { ok: true, code: 'queued' }
    if (queue_walk(claim, actor, work.goal.source, TRANSFER_INTERACTION_RADIUS)) return { ok: true, code: 'queued' }
    const moved = context.basic.submit_move(work.goal.itemName, work.goal.sourceEntityName, work.goal.count - held, false)
    if (!moved[0]) return { ok: false, code: 'submit_failed' }
    record_operation(claim.id, context.basic.status().last_result?.operation_id)
    return { ok: true, code: 'queued' }
  }

  function dispatch_delivery(claim: WorkClaim, work: WorkItem, tick: SimulationTick): { ok: boolean, code: ItemExecutionCode } {
    if (work.goal.kind !== 'deliver_items' || work.goal.destinationEntityName === undefined) return { ok: false, code: 'unsupported_work' }
    const context = context_for(claim.actorId)
    if (context === undefined) return { ok: false, code: 'actor_not_attached' }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) return { ok: false, code: 'actor_busy' }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) return { ok: false, code: 'no_body' }
    if (actor.surface.index !== work.goal.destination.surfaceIndex) return { ok: false, code: 'wrong_surface' }
    const destination = endpoint_inventory_count(actor, work.goal.destinationEntityName, work.goal.destination, work.goal.itemName)
    if (destination.found && destination.count >= work.goal.count) {
      complete_delivery(claim, work, tick)
      return { ok: true, code: 'completed' }
    }
    if (!destination.found || inventory_count(actor, work.goal.itemName) <= 0) return { ok: true, code: 'queued' }
    if (queue_walk(claim, actor, work.goal.destination, TRANSFER_INTERACTION_RADIUS)) return { ok: true, code: 'queued' }
    const remaining = work.goal.count - destination.count
    const moved = context.basic.submit_move(work.goal.itemName, work.goal.destinationEntityName, math.min(remaining, inventory_count(actor, work.goal.itemName)), true)
    if (!moved[0]) return { ok: false, code: 'submit_failed' }
    record_operation(claim.id, context.basic.status().last_result?.operation_id)
    return { ok: true, code: 'queued' }
  }

  function dispatch_craft(claim: WorkClaim, work: WorkItem): { ok: boolean, code: ItemExecutionCode } {
    if (work.goal.kind !== 'craft_items') return { ok: false, code: 'unsupported_work' }
    const context = context_for(claim.actorId)
    if (context === undefined) return { ok: false, code: 'actor_not_attached' }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) return { ok: false, code: 'actor_busy' }
    const submitted = context.crafting.submit(work.goal.itemName, work.goal.count)
    // Submission failures are converted into structured Requests on the next
    // coordinator tick instead of dropping the Claim as a generic dispatch error.
    return { ok: true, code: submitted[0] ? 'queued' : 'queued' }
  }

  function maybe_heartbeat_location(claim: WorkClaim, work: WorkItem, tick: SimulationTick, location: WorldLocation, summary: string) {
    if (tick - claim.lastProgressTick < options.heartbeatIntervalTicks) return
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid || actor.surface.index !== location.surfaceIndex) return
    const distance = Math.sqrt(squared_distance(actor.position.x, actor.position.y, location.position.x, location.position.y))
    const previousDistance = lastDistanceByClaim[claim.id]
    if (previousDistance === undefined || previousDistance - distance < options.minimumProgressDistance) return
    const observation = post_observation(swarm, {
      observer: claim.agentId,
      subject: `logistics progress for ${work.id}`,
      location,
      evidenceClass: 'measured',
      data: { distanceToTarget: distance },
      observedTick: tick,
    })
    const heartbeat = heartbeat_claim(swarm, {
      claimId: claim.id,
      tick,
      leaseTicks: options.leaseTicks,
      bodyRevision: claim.actorBodyRevision,
      usefulProgress: true,
      summary,
      evidence: [{ kind: 'observation' as const, id: observation.id, tick }],
    })
    if (heartbeat.ok) lastDistanceByClaim[claim.id] = distance
  }

  function maybe_heartbeat_gather(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'gather_resource' || tick - claim.lastProgressTick < options.heartbeatIntervalTicks) return
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
      data: { itemName: work.goal.itemName, inventoryCount: held, requiredCount: work.goal.count, distanceToSource: distance },
      observedTick: tick,
    })
    const heartbeat = heartbeat_claim(swarm, {
      claimId: claim.id,
      tick,
      leaseTicks: options.leaseTicks,
      bodyRevision: claim.actorBodyRevision,
      usefulProgress: true,
      summary: inventoryProgress ? `Gathered ${held}/${work.goal.count} ${work.goal.itemName}` : `Moved closer to ${work.goal.resourceName} source`,
      evidence: [{ kind: 'observation' as const, id: observation.id, tick }],
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

  function process_acquire(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'acquire_items' || work.goal.source === undefined || work.goal.sourceEntityName === undefined) return
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return
    const held = inventory_count(actor, work.goal.itemName)
    if (held >= work.goal.count) {
      complete_acquire(claim, work, tick)
      return
    }
    const source = endpoint_inventory_count(actor, work.goal.sourceEntityName, work.goal.source, work.goal.itemName)
    if (!source.found) {
      block_missing_endpoint(claim, work, tick, work.goal.source, `Pickup endpoint ${work.goal.sourceEntityName} is missing for ${work.id}`)
      return
    }
    if (source.count <= 0) {
      block_material_shortage(claim, work, tick, work.goal.itemName, work.goal.count - held, work.goal.source, `Pickup source lacks ${work.goal.itemName} for ${work.id}`)
      return
    }
    const context = context_for(claim.actorId)
    if (context === undefined) return
    if (context.manager.player_state.task_state === TaskStates.IDLE && context.manager.is_task_queue_empty()) {
      const operationId = operationByClaim[claim.id]
      const lastResult = context.basic.status().last_result
      if (operationId !== undefined && lastResult?.operation_id === operationId && !lastResult.completed && lastResult.code !== 'queued') {
        if (lastResult.code === 'no_target' || lastResult.code === 'invalid_entity') {
          block_missing_endpoint(claim, work, tick, work.goal.source, `Pickup endpoint ${work.goal.sourceEntityName} became unavailable for ${work.id}`)
          return
        }
        if (lastResult.code === 'nothing_moved') {
          block_material_shortage(claim, work, tick, work.goal.itemName, work.goal.count - held, work.goal.source, `No ${work.goal.itemName} could be collected for ${work.id}`)
          return
        }
        delete operationByClaim[claim.id]
      }
      dispatch_acquire(claim, work, tick)
      return
    }
    maybe_heartbeat_location(claim, work, tick, work.goal.source, `Moved closer to pickup source ${work.goal.sourceEntityName}`)
  }

  function process_delivery(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'deliver_items' || work.goal.destinationEntityName === undefined) return
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return
    const destination = endpoint_inventory_count(actor, work.goal.destinationEntityName, work.goal.destination, work.goal.itemName)
    if (destination.found && destination.count >= work.goal.count) {
      complete_delivery(claim, work, tick)
      return
    }
    if (!destination.found) {
      block_missing_endpoint(claim, work, tick, work.goal.destination, `Delivery endpoint ${work.goal.destinationEntityName} is missing for ${work.id}`)
      return
    }
    const held = inventory_count(actor, work.goal.itemName)
    if (held <= 0) {
      block_material_shortage(claim, work, tick, work.goal.itemName, work.goal.count - destination.count, work.goal.destination, `Carrier lacks ${work.goal.itemName} required by ${work.id}`)
      return
    }
    const context = context_for(claim.actorId)
    if (context === undefined) return
    if (context.manager.player_state.task_state === TaskStates.IDLE && context.manager.is_task_queue_empty()) {
      const operationId = operationByClaim[claim.id]
      const lastResult = context.basic.status().last_result
      if (operationId !== undefined && lastResult?.operation_id === operationId && !lastResult.completed && lastResult.code !== 'queued') {
        if (lastResult.code === 'no_target' || lastResult.code === 'invalid_entity') {
          block_missing_endpoint(claim, work, tick, work.goal.destination, `Delivery endpoint ${work.goal.destinationEntityName} became unavailable for ${work.id}`)
          return
        }
        if (lastResult.code === 'item_missing' || lastResult.code === 'nothing_moved') {
          block_material_shortage(claim, work, tick, work.goal.itemName, work.goal.count - destination.count, work.goal.destination, `Delivery could not move ${work.goal.itemName} for ${work.id}`)
          return
        }
        delete operationByClaim[claim.id]
      }
      dispatch_delivery(claim, work, tick)
      return
    }
    maybe_heartbeat_location(claim, work, tick, work.goal.destination, `Moved closer to delivery endpoint ${work.goal.destinationEntityName}`)
  }

  function process_craft(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'craft_items') return
    const context = context_for(claim.actorId)
    if (context === undefined) return
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) return
    const receipt = context.crafting.status().last_result
    if (receipt !== undefined && receipt.tick >= claim.acquiredTick) {
      if (receipt.completed && receipt.code === 'completed') {
        complete_craft(claim, work, tick)
        return
      }
      if (receipt.code !== 'queued' && receipt.code !== 'started') {
        if (receipt.code === 'not_enough_ingredients') {
          block_with_request(claim, work, tick, 'material_request',
            `Crafting ${work.goal.itemName} x${work.goal.count} lacks required ingredients; recipe planning is required`,
            'supply_shortage', { destination: work.location })
          return
        }
        if (receipt.code === 'recipe_locked' || receipt.code === 'recipe_unavailable') {
          block_with_request(claim, work, tick, 'decision_request',
            `Crafting recipe ${work.goal.itemName} is unavailable or locked`, 'blocker_discovered', { destination: work.location })
          return
        }
        block_with_request(claim, work, tick, 'assistance_request',
          `Crafting ${work.goal.itemName} failed with ${receipt.code}`, 'blocker_discovered', { destination: work.location })
        return
      }
    }
    dispatch_craft(claim, work)
  }

  function dispatch(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind === 'gather_resource') return dispatch_gather(claim, work, tick)
    if (work.goal.kind === 'acquire_items') return dispatch_acquire(claim, work, tick)
    if (work.goal.kind === 'deliver_items') return dispatch_delivery(claim, work, tick)
    if (work.goal.kind === 'craft_items') return dispatch_craft(claim, work)
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
    if (work.goal.kind === 'gather_resource') process_gather(claim, work, tick)
    else if (work.goal.kind === 'acquire_items') process_acquire(claim, work, tick)
    else if (work.goal.kind === 'deliver_items') process_delivery(claim, work, tick)
    else if (work.goal.kind === 'craft_items') process_craft(claim, work, tick)
    return true
  }

  return { supports: supports_item_work, dispatch, process, clear_claim_state }
}
