import { TaskStates } from '../types'
import { get_actor_inventory_items } from '../utils/inventory'
import { complete_work_from_result, post_observation, post_result } from './blackboard'
import { activate_claim, claim_work, heartbeat_claim, release_claim } from './claims'
import type { new_actor_registry } from './actor_registry'
import type { new_actor_runtime_router } from './actor_runtime_router'
import { new_item_work_executor, supports_item_work } from './item_work_executor'
import { rank_work_candidates } from './selection'
import type { ActorAdmissionSnapshot, ActorId, ClaimId, SimulationTick, SwarmStorage, WorkClaim, WorkId, WorkItem } from './types'

type ActorRegistry = ReturnType<typeof new_actor_registry>
type ActorRuntimeRouter = ReturnType<typeof new_actor_runtime_router>

export interface WorkCoordinatorOptions {
  leaseTicks?: number
  heartbeatIntervalTicks?: number
  minimumProgressDistance?: number
}

const DEFAULT_LEASE_TICKS = 600
const DEFAULT_HEARTBEAT_INTERVAL_TICKS = 30
const DEFAULT_MINIMUM_PROGRESS_DISTANCE = 0.25
const DEFAULT_SURVEY_RADIUS = 1.5

function squared_distance(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function supports_runtime_execution(work: WorkItem) {
  return work.goal.kind === 'survey_area' || supports_item_work(work)
}

function survey_radius(work: WorkItem) {
  if (work.goal.kind !== 'survey_area') return DEFAULT_SURVEY_RADIUS
  return work.goal.area.radius ?? DEFAULT_SURVEY_RADIUS
}

function inventory_snapshot(actor: ReturnType<ActorRegistry['resolve_actor']>) {
  const result: Record<string, number> = {}
  if (actor === undefined) return result
  for (const item of get_actor_inventory_items(actor)) result[item.name] = item.count
  return result
}

export function new_work_coordinator(
  swarm: SwarmStorage,
  registry: ActorRegistry,
  router: ActorRuntimeRouter,
  options: WorkCoordinatorOptions = {},
) {
  const leaseTicks = options.leaseTicks ?? DEFAULT_LEASE_TICKS
  const heartbeatIntervalTicks = options.heartbeatIntervalTicks ?? DEFAULT_HEARTBEAT_INTERVAL_TICKS
  const minimumProgressDistance = options.minimumProgressDistance ?? DEFAULT_MINIMUM_PROGRESS_DISTANCE
  const lastDistanceByClaim: Record<ClaimId, number> = {}
  const itemExecutor = new_item_work_executor(swarm, registry, router, {
    leaseTicks,
    heartbeatIntervalTicks,
    minimumProgressDistance,
  })

  function context_for(actorId: ActorId) {
    return router.get_context(actorId)
  }

  function cancel_context_work(actorId: ActorId) {
    const context = context_for(actorId)
    if (context === undefined) return
    context.manager.cancel_all_tasks()
  }

  function dispatch_survey(claim: WorkClaim, work: WorkItem) {
    if (work.goal.kind !== 'survey_area') return { ok: false as const, code: 'unsupported_work' as const }
    const context = context_for(claim.actorId)
    if (context === undefined) return { ok: false as const, code: 'actor_not_attached' as const }
    if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) {
      return { ok: false as const, code: 'actor_busy' as const }
    }
    const actor = registry.resolve_actor(claim.actorId, game.tick)
    if (actor === undefined || !actor.is_valid || actor.character === undefined) {
      return { ok: false as const, code: 'no_body' as const }
    }
    context.manager.add_task({
      type: TaskStates.WALKING_DIRECT,
      target_position: {
        x: work.goal.area.position.x,
        y: work.goal.area.position.y,
      },
    })
    const dx = actor.position.x - work.goal.area.position.x
    const dy = actor.position.y - work.goal.area.position.y
    lastDistanceByClaim[claim.id] = Math.sqrt(dx * dx + dy * dy)
    return { ok: true as const }
  }

  function complete_survey(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'survey_area') return { ok: false as const, code: 'unsupported_work' as const }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return { ok: false as const, code: 'no_body' as const }

    cancel_context_work(claim.actorId)
    const target = work.goal.area.position
    const dx = actor.position.x - target.x
    const dy = actor.position.y - target.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    const observation = post_observation(swarm, {
      observer: claim.agentId,
      subject: `survey target reached for ${work.id}`,
      location: work.goal.area,
      evidenceClass: 'measured',
      data: {
        actorX: actor.position.x,
        actorY: actor.position.y,
        targetX: target.x,
        targetY: target.y,
        distance,
      },
      observedTick: tick,
    })
    const evidence = [{ kind: 'observation' as const, id: observation.id, tick }]
    const result = post_result(swarm, {
      workId: work.id,
      agentId: claim.agentId,
      status: 'success',
      evidence,
      summary: `Reached survey target at measured distance ${distance}`,
      tick,
    })
    const completed = complete_work_from_result(swarm, work.id, work.revision, result.id, tick)
    if (completed.ok) delete lastDistanceByClaim[claim.id]
    return completed
  }

  function maybe_heartbeat(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind !== 'survey_area') return
    if (tick - claim.lastProgressTick < heartbeatIntervalTicks) return
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return
    const target = work.goal.area.position
    const dx = actor.position.x - target.x
    const dy = actor.position.y - target.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    const previous = lastDistanceByClaim[claim.id]
    if (previous === undefined) {
      lastDistanceByClaim[claim.id] = distance
      return
    }
    if (previous - distance < minimumProgressDistance) return

    const observation = post_observation(swarm, {
      observer: claim.agentId,
      subject: `survey progress for ${work.id}`,
      location: work.goal.area,
      evidenceClass: 'measured',
      data: {
        actorX: actor.position.x,
        actorY: actor.position.y,
        targetX: target.x,
        targetY: target.y,
        distance,
      },
      observedTick: tick,
    })
    const evidence = [{ kind: 'observation' as const, id: observation.id, tick }]
    const heartbeat = heartbeat_claim(swarm, {
      claimId: claim.id,
      tick,
      leaseTicks,
      bodyRevision: claim.actorBodyRevision,
      usefulProgress: true,
      summary: `Survey distance reduced to ${distance}`,
      evidence,
    })
    if (heartbeat.ok) lastDistanceByClaim[claim.id] = distance
  }

  function process_survey_claim(claim: WorkClaim, tick: SimulationTick) {
    const work = swarm.board.work[claim.workId]
    if (work === undefined || work.goal.kind !== 'survey_area') return
    const runtime = registry.runtime_snapshot(claim.actorId, tick)
    if (runtime === undefined || !runtime.registered || runtime.state !== 'online') {
      cancel_context_work(claim.actorId)
      release_claim(swarm, { claimId: claim.id, tick, reason: 'actor_recovery' })
      delete lastDistanceByClaim[claim.id]
      return
    }
    if (runtime.bodyRevision !== claim.actorBodyRevision) {
      cancel_context_work(claim.actorId)
      release_claim(swarm, { claimId: claim.id, tick, reason: 'actor_recovery' })
      delete lastDistanceByClaim[claim.id]
      return
    }
    if (claim.leaseUntilTick <= tick) {
      cancel_context_work(claim.actorId)
      release_claim(swarm, { claimId: claim.id, tick, reason: 'no_progress_timeout' })
      delete lastDistanceByClaim[claim.id]
      return
    }
    const actor = registry.resolve_actor(claim.actorId, tick)
    if (actor === undefined || !actor.is_valid) return

    const radius = survey_radius(work)
    if (squared_distance(
      actor.position.x,
      actor.position.y,
      work.goal.area.position.x,
      work.goal.area.position.y,
    ) <= radius * radius) {
      complete_survey(claim, work, tick)
      return
    }

    if (claim.state === 'claimed') {
      const activated = activate_claim(swarm, claim.id, tick)
      if (!activated.ok) return
    }

    const context = context_for(claim.actorId)
    if (context === undefined) return
    if (context.manager.player_state.task_state === TaskStates.IDLE && context.manager.is_task_queue_empty()) {
      dispatch_survey(claim, work)
      return
    }
    maybe_heartbeat(claim, work, tick)
  }

  function dispatch_work(claim: WorkClaim, work: WorkItem, tick: SimulationTick) {
    if (work.goal.kind === 'survey_area') return dispatch_survey(claim, work)
    return itemExecutor.dispatch(claim, work, tick)
  }

  interface AssignmentCandidate {
    admission: ActorAdmissionSnapshot
    workId: WorkId
    finalScore: number
  }

  function collect_assignment_candidates(tick: SimulationTick) {
    const candidates: AssignmentCandidate[] = []
    for (const admission of registry.list_admission_snapshots(tick)) {
      if (!admission.available) continue
      const context = context_for(admission.actorId)
      if (context === undefined) continue
      if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) continue
      const actor = registry.resolve_actor(admission.actorId, tick)
      if (actor === undefined || !actor.is_valid) continue
      const agent = swarm.agents[admission.agentId]
      if (agent === undefined || agent.state !== 'available') continue

      const ranked = rank_work_candidates(swarm, {
        agentId: admission.agentId,
        actorId: admission.actorId,
        capabilities: admission.capabilities,
        location: {
          surfaceIndex: actor.surface.index,
          position: { x: actor.position.x, y: actor.position.y },
        },
        inventory: inventory_snapshot(actor),
        currentWorkId: agent.currentWorkId,
      }, {}, 128)

      for (const candidate of ranked) {
        const work = swarm.board.work[candidate.workId]
        if (work === undefined || !supports_runtime_execution(work)) continue
        candidates.push({ admission, workId: work.id, finalScore: candidate.finalScore })
      }
    }
    candidates.sort((left, right) =>
      right.finalScore - left.finalScore
      || (left.admission.actorId < right.admission.actorId ? -1 : left.admission.actorId > right.admission.actorId ? 1 : 0)
      || (left.workId < right.workId ? -1 : left.workId > right.workId ? 1 : 0))
    return candidates
  }

  function assign_open_work(tick: SimulationTick) {
    const assignments: Array<{ actorId: ActorId, workId: WorkId, claimId: ClaimId }> = []
    const assignedActors: Record<ActorId, boolean> = {}
    const assignedWorks: Record<WorkId, boolean> = {}

    for (const candidate of collect_assignment_candidates(tick)) {
      const admission = candidate.admission
      if (assignedActors[admission.actorId] === true || assignedWorks[candidate.workId] === true) continue

      const context = context_for(admission.actorId)
      if (context === undefined) continue
      if (context.manager.player_state.task_state !== TaskStates.IDLE || !context.manager.is_task_queue_empty()) continue
      const actor = registry.resolve_actor(admission.actorId, tick)
      if (actor === undefined || !actor.is_valid) continue
      const agent = swarm.agents[admission.agentId]
      if (agent === undefined || agent.state !== 'available') continue
      const work = swarm.board.work[candidate.workId]
      if (work === undefined || work.status !== 'open' || !supports_runtime_execution(work)) continue

      const claimed = claim_work(swarm, {
        workId: work.id,
        expectedRevision: work.revision,
        actor: admission,
        tick,
        leaseTicks,
      })
      if (!claimed.ok) continue
      const activated = activate_claim(swarm, claimed.claim.id, tick)
      if (!activated.ok) {
        release_claim(swarm, { claimId: claimed.claim.id, tick, reason: 'voluntary' })
        continue
      }
      const dispatched = dispatch_work(claimed.claim, work, tick)
      if (!dispatched.ok) {
        release_claim(swarm, { claimId: claimed.claim.id, tick, reason: 'voluntary' })
        itemExecutor.clear_claim_state(claimed.claim.id)
        continue
      }

      assignedActors[admission.actorId] = true
      assignedWorks[work.id] = true
      assignments.push({ actorId: admission.actorId, workId: work.id, claimId: claimed.claim.id })
    }
    return assignments
  }

  function tick(tick: SimulationTick) {
    const claimIds: ClaimId[] = []
    for (const id in swarm.board.claims) claimIds.push(id)
    claimIds.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    for (const claimId of claimIds) {
      const claim = swarm.board.claims[claimId]
      if (claim === undefined) continue
      const work = swarm.board.work[claim.workId]
      if (work === undefined) continue
      if (work.goal.kind === 'survey_area') process_survey_claim(claim, tick)
      else itemExecutor.process(claim, work, tick)
    }
    return { assignments: assign_open_work(tick) }
  }

  return {
    tick,
  }
}
