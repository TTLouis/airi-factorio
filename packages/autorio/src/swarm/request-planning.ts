import type { ActorCapability, RequestRecord, WorkGoal, WorkRequirements, WorldLocation } from './types'

export interface ProposedWorkSpec {
  sourceRequestId: string
  missionId?: string
  objectiveId?: string
  projectId?: string
  goal: WorkGoal
  requirements: WorkRequirements
  location?: WorldLocation
  priority: number
}

export type RequestPlanningResult
  = { kind: 'proposal', proposal: ProposedWorkSpec }
    | { kind: 'planner_required', reason: 'ambiguous_remedy' | 'strategic_decision' }
    | { kind: 'invalid_request', reason: 'missing_structured_fields' }
    | { kind: 'no_work_needed', reason: 'request_not_open' }

function proposal(
  request: RequestRecord,
  goal: WorkGoal,
  capabilities: ActorCapability[],
  location?: WorldLocation,
): RequestPlanningResult {
  return {
    kind: 'proposal',
    proposal: {
      sourceRequestId: request.id,
      missionId: request.missionId,
      objectiveId: request.objectiveId,
      projectId: request.projectId,
      goal,
      requirements: { capabilities },
      location,
      priority: request.priority,
    },
  }
}

/**
 * Derive only remedies that are deterministic from structured Request fields.
 * Ambiguous needs remain Requests for a higher-level planner instead of being
 * silently translated into an arbitrary factory change.
 */
export function derive_request_work_proposal(request: RequestRecord): RequestPlanningResult {
  if (request.status !== 'open') return { kind: 'no_work_needed', reason: 'request_not_open' }

  if (request.kind === 'observation_request') {
    if (request.destination === undefined) return { kind: 'invalid_request', reason: 'missing_structured_fields' }
    return proposal(
      request,
      { kind: 'survey_area', subject: request.description, area: request.destination },
      ['move', 'survey'],
      request.destination,
    )
  }

  if (request.kind === 'defense_request') {
    if (request.destination === undefined) return { kind: 'invalid_request', reason: 'missing_structured_fields' }
    return proposal(request, { kind: 'defend_area', area: request.destination }, ['move', 'combat'], request.destination)
  }

  if (request.kind === 'transport_request') {
    if (request.itemName === undefined || request.itemName === '' || request.count === undefined || request.count <= 0 || request.destination === undefined) {
      return { kind: 'invalid_request', reason: 'missing_structured_fields' }
    }
    return proposal(
      request,
      {
        kind: 'deliver_items',
        itemName: request.itemName,
        count: request.count,
        destination: request.destination,
      },
      ['move', 'transfer'],
      request.destination,
    )
  }

  if (request.kind === 'decision_request') return { kind: 'planner_required', reason: 'strategic_decision' }

  return { kind: 'planner_required', reason: 'ambiguous_remedy' }
}
