import { record_objective_acceptance } from './missions'
import type { EvidenceRef, ObjectiveId, SimulationTick, SwarmStorage } from './types'

function append_unique_evidence(target: EvidenceRef[], evidence: EvidenceRef) {
  for (const existing of target) {
    if (existing.kind === evidence.kind && existing.id === evidence.id && existing.tick === evidence.tick) return
  }
  target.push(evidence)
}

/**
 * Convert evidence-backed completion of mission-tracker Work into Objective
 * acceptance. Only objectives with exactly one explicit acceptance condition
 * are auto-resolved here; richer objectives remain under their dedicated
 * verifier/planner instead of being guessed from task completion.
 */
export function reconcile_mission_work_completion(
  swarm: SwarmStorage,
  tick: SimulationTick,
) {
  const satisfied: ObjectiveId[] = []
  const objectiveIds: ObjectiveId[] = []
  for (const id in swarm.objectives) objectiveIds.push(id)
  objectiveIds.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)

  for (const objectiveId of objectiveIds) {
    const objective = swarm.objectives[objectiveId]
    if (objective.status === 'satisfied' || objective.status === 'cancelled') continue
    if (objective.acceptance.length !== 1) continue

    let foundMissionWork = false
    let allCompleted = true
    const evidence: EvidenceRef[] = []
    for (const workId in swarm.board.work) {
      const work = swarm.board.work[workId]
      if (work.objectiveId !== objective.id || work.createdBy !== 'mission-tracker') continue
      foundMissionWork = true
      if (work.status !== 'completed' || work.evidence.length === 0) {
        allCompleted = false
        break
      }
      for (const ref of work.evidence) append_unique_evidence(evidence, ref)
    }
    if (!foundMissionWork || !allCompleted || evidence.length === 0) continue

    const condition = objective.acceptance[0]
    const result = record_objective_acceptance(swarm, objective.id, objective.revision, {
      conditionId: condition.id,
      satisfied: true,
      evidence,
      tick,
    })
    if (result.ok && result.objective.status === 'satisfied') satisfied.push(objective.id)
  }

  return satisfied
}
