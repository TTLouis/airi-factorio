import type { SwarmStorage } from './types'
import { validate_objective_dependency_graph, validate_work_dependency_graph } from './graphs'

export type SwarmInvariantSeverity = 'error' | 'warning'

export interface SwarmInvariantIssue {
  severity: SwarmInvariantSeverity
  code: string
  recordId: string
  relatedId?: string
  message: string
}

function has_id(values: string[], id: string) {
  for (const value of values) if (value === id) return true
  return false
}

function known_condition(conditions: { id: string }[], id: string) {
  for (const condition of conditions) if (condition.id === id) return true
  return false
}

export function audit_swarm_invariants(swarm: SwarmStorage) {
  const issues: SwarmInvariantIssue[] = []
  const claimsByAgent: Record<string, string> = {}
  const claimsByActor: Record<string, string> = {}

  function add(severity: SwarmInvariantSeverity, code: string, recordId: string, message: string, relatedId?: string) {
    issues.push({ severity, code, recordId, relatedId, message })
  }

  for (const workId in swarm.board.work) {
    const work = swarm.board.work[workId]
    if (work.missionId && !swarm.missions[work.missionId]) add('error', 'work_mission_missing', work.id, 'Work references a missing mission.', work.missionId)
    if (work.objectiveId && !swarm.objectives[work.objectiveId]) add('error', 'work_objective_missing', work.id, 'Work references a missing objective.', work.objectiveId)
    if (work.projectId) {
      const project = swarm.projects[work.projectId]
      if (!project) add('error', 'work_project_missing', work.id, 'Work references a missing project.', work.projectId)
      else if (!has_id(project.workItemIds, work.id)) add('warning', 'project_work_link_missing', work.id, 'Project does not list work that references it.', project.id)
    }
    if (work.claimId) {
      const claim = swarm.board.claims[work.claimId]
      if (!claim) add('error', 'work_claim_missing', work.id, 'Work references a missing claim.', work.claimId)
      else if (claim.workId !== work.id) add('error', 'work_claim_mismatch', work.id, 'Work and claim do not reference each other.', claim.id)
    }
    if ((work.status === 'claimed' || work.status === 'active') && !work.claimId) {
      add('error', 'executing_work_without_claim', work.id, 'Claimed/active work has no claim reference.')
    }
    for (const requestId of work.blockingRequests) {
      const request = swarm.board.requests[requestId]
      if (!request) add('error', 'work_blocker_missing_request', work.id, 'Work references a missing blocking request.', requestId)
      else if (!has_id(request.blocksWorkIds, work.id)) add('warning', 'work_request_link_asymmetric', work.id, 'Work/request blocker relationship is not reciprocal.', requestId)
    }
  }

  for (const claimId in swarm.board.claims) {
    const claim = swarm.board.claims[claimId]
    const priorAgentClaim = claimsByAgent[claim.agentId]
    if (priorAgentClaim) add('error', 'agent_multiple_claims', claim.id, 'Agent owns more than one active claim.', priorAgentClaim)
    else claimsByAgent[claim.agentId] = claim.id
    const priorActorClaim = claimsByActor[claim.actorId]
    if (priorActorClaim) add('error', 'actor_multiple_claims', claim.id, 'Actor owns more than one active claim.', priorActorClaim)
    else claimsByActor[claim.actorId] = claim.id

    const work = swarm.board.work[claim.workId]
    if (!work) add('error', 'claim_work_missing', claim.id, 'Claim references missing work.', claim.workId)
    else {
      if (work.claimId !== claim.id) add('error', 'claim_work_mismatch', claim.id, 'Claim is not the claim referenced by its work.', work.id)
      if (work.status !== 'claimed' && work.status !== 'active') add('error', 'claim_work_status_mismatch', claim.id, 'Claim exists for work that is not claimed/active.', work.id)
    }
    const agent = swarm.agents[claim.agentId]
    if (!agent) add('warning', 'claim_agent_missing', claim.id, 'Claim owner has no persisted agent record.', claim.agentId)
    else if (agent.actorId && agent.actorId !== claim.actorId) add('warning', 'claim_actor_binding_changed', claim.id, 'Claim actor differs from the agent current actor binding.', agent.actorId)
  }

  for (const requestId in swarm.board.requests) {
    const request = swarm.board.requests[requestId]
    if (request.missionId && !swarm.missions[request.missionId]) add('error', 'request_mission_missing', request.id, 'Request references a missing mission.', request.missionId)
    if (request.objectiveId && !swarm.objectives[request.objectiveId]) add('error', 'request_objective_missing', request.id, 'Request references a missing objective.', request.objectiveId)
    if (request.projectId && !swarm.projects[request.projectId]) add('error', 'request_project_missing', request.id, 'Request references a missing project.', request.projectId)
    for (const workId of request.blocksWorkIds) {
      const work = swarm.board.work[workId]
      if (!work) add('error', 'request_blocked_work_missing', request.id, 'Request references missing blocked work.', workId)
      else if (!has_id(work.blockingRequests, request.id)) add('warning', 'request_work_link_asymmetric', request.id, 'Request/work blocker relationship is not reciprocal.', workId)
    }
    for (const workId of request.satisfyingWorkIds) {
      if (!swarm.board.work[workId]) add('warning', 'request_satisfying_work_missing', request.id, 'Request references missing satisfying work.', workId)
    }
  }

  for (const agentId in swarm.agents) {
    const agent = swarm.agents[agentId]
    if (agent.currentWorkId && !swarm.board.work[agent.currentWorkId]) {
      add('warning', 'agent_current_work_missing', agent.id, 'Agent commitment references missing work.', agent.currentWorkId)
    }
    if (agent.state === 'working' && !agent.currentWorkId) {
      add('warning', 'working_agent_without_work', agent.id, 'Agent is marked working without a current work item.')
    }
  }

  for (const objectiveId in swarm.objectives) {
    const objective = swarm.objectives[objectiveId]
    const mission = swarm.missions[objective.missionId]
    if (!mission) add('error', 'objective_mission_missing', objective.id, 'Objective references missing mission.', objective.missionId)
    else if (!has_id(mission.objectiveIds, objective.id)) add('warning', 'mission_objective_link_missing', objective.id, 'Mission does not list this objective.', mission.id)
    for (const conditionId in objective.acceptanceState) {
      if (!known_condition(objective.acceptance, conditionId)) add('warning', 'objective_unknown_acceptance_state', objective.id, 'Objective contains evaluation for an unknown acceptance condition.', conditionId)
    }
    for (const projectId of objective.projectIds) {
      const project = swarm.projects[projectId]
      if (!project) add('error', 'objective_project_missing', objective.id, 'Objective lists a missing project.', projectId)
      else if (project.objectiveId !== objective.id) add('error', 'objective_project_mismatch', objective.id, 'Objective lists a project bound elsewhere.', project.id)
    }
  }

  for (const missionId in swarm.missions) {
    const mission = swarm.missions[missionId]
    for (const objectiveId of mission.objectiveIds) {
      const objective = swarm.objectives[objectiveId]
      if (!objective) add('error', 'mission_objective_missing', mission.id, 'Mission lists a missing objective.', objectiveId)
      else if (objective.missionId !== mission.id) add('error', 'mission_objective_mismatch', mission.id, 'Mission lists an objective owned by another mission.', objectiveId)
    }
    for (const conditionId in mission.acceptanceState) {
      if (!known_condition(mission.acceptance, conditionId)) add('warning', 'mission_unknown_acceptance_state', mission.id, 'Mission contains evaluation for an unknown acceptance condition.', conditionId)
    }
  }

  for (const projectId in swarm.projects) {
    const project = swarm.projects[projectId]
    if (!swarm.missions[project.missionId]) add('error', 'project_mission_missing', project.id, 'Project references missing mission.', project.missionId)
    if (project.objectiveId) {
      const objective = swarm.objectives[project.objectiveId]
      if (!objective) add('error', 'project_objective_missing', project.id, 'Project references missing objective.', project.objectiveId)
      else {
        if (objective.missionId !== project.missionId) add('error', 'project_objective_mission_mismatch', project.id, 'Project objective belongs to another mission.', objective.id)
        if (!has_id(objective.projectIds, project.id)) add('warning', 'objective_project_link_missing', project.id, 'Objective does not list this project.', objective.id)
      }
    }
    for (const workId of project.workItemIds) {
      const work = swarm.board.work[workId]
      if (!work) add('error', 'project_work_missing', project.id, 'Project lists missing work.', workId)
      else if (work.projectId !== project.id) add('error', 'project_work_mismatch', project.id, 'Project lists work bound to another project.', work.id)
    }
  }

  const graphIssues = [...validate_work_dependency_graph(swarm), ...validate_objective_dependency_graph(swarm)]
  for (const issue of graphIssues) {
    add('error', `${issue.graph}_${issue.code}`, issue.recordId, `${issue.graph} dependency graph issue: ${issue.code}.`, issue.dependencyId)
  }

  issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1
    const ar = a.relatedId ?? ''
    const br = b.relatedId ?? ''
    return ar < br ? -1 : ar > br ? 1 : 0
  })
  return issues
}
