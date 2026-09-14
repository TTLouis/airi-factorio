import { create_request } from './blackboard'
import { release_claim } from './claims'
import type { new_actor_runtime_router } from './actor_runtime_router'
import type { RequestRecord, SimulationTick, SwarmStorage, WorkId, WorldLocation } from './types'

type ActorRuntimeRouter = ReturnType<typeof new_actor_runtime_router>

export interface ObservationBlockerInput {
  workId: WorkId
  description: string
  destination: WorldLocation
  priority: number
  tick: SimulationTick
}

export type ObservationBlockerResult
  = { ok: true, request: RequestRecord }
    | { ok: false, code: 'work_not_found' | 'work_terminal' | 'claim_release_failed' }

/**
 * Attach an evidence-seeking Request to Work. If the Work is currently owned,
 * cancel only that actor's volatile runtime task and release the Claim through
 * the normal state machine so another assignment cannot race stale controls.
 */
export function block_work_with_observation_request(
  swarm: SwarmStorage,
  router: ActorRuntimeRouter,
  input: ObservationBlockerInput,
): ObservationBlockerResult {
  const work = swarm.board.work[input.workId]
  if (work === undefined) return { ok: false, code: 'work_not_found' }
  if (work.status === 'completed' || work.status === 'cancelled') return { ok: false, code: 'work_terminal' }

  const claim = work.claimId !== undefined ? swarm.board.claims[work.claimId] : undefined
  const request = create_request(swarm, {
    kind: 'observation_request',
    requester: 'system',
    missionId: work.missionId,
    objectiveId: work.objectiveId,
    projectId: work.projectId,
    priority: input.priority,
    description: input.description,
    destination: input.destination,
    blocksWorkIds: [work.id],
    createdTick: input.tick,
  })

  if (claim !== undefined) {
    router.get_context(claim.actorId)?.manager.cancel_all_tasks()
    const released = release_claim(swarm, {
      claimId: claim.id,
      tick: input.tick,
      reason: 'blocker_discovered',
      blockerRequestId: request.id,
    })
    if (!released.ok) return { ok: false, code: 'claim_release_failed' }
  }

  return { ok: true, request }
}
