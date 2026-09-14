import type {
  AcceptanceCondition,
  AcceptanceEvaluation,
  AgentId,
  BlockerRef,
  EvidenceRef,
  Mission,
  Objective,
  Project,
  ProjectScope,
  ProjectStatus,
  SimulationTick,
  SwarmStorage,
} from './types'
import { allocate_swarm_id } from './storage'

function all_acceptance_satisfied(conditions: AcceptanceCondition[], state: Record<string, AcceptanceEvaluation>) {
  for (const condition of conditions) {
    const evaluation = state[condition.id]
    if (!evaluation || !evaluation.satisfied || evaluation.evidence.length === 0) return false
  }
  return true
}

function objective_dependencies_satisfied(swarm: SwarmStorage, objective: Objective) {
  for (const dependencyId of objective.dependencies) {
    if (swarm.objectives[dependencyId]?.status !== 'satisfied') return false
  }
  return true
}

function has_acceptance_condition(conditions: AcceptanceCondition[], conditionId: string) {
  for (const condition of conditions) if (condition.id === conditionId) return true
  return false
}

export interface CreateMissionInput {
  title: string
  priority: number
  goal: string
  acceptance?: AcceptanceCondition[]
  createdBy: 'human' | AgentId
  tick: SimulationTick
}

export function create_mission(swarm: SwarmStorage, input: CreateMissionInput) {
  const id = allocate_swarm_id('mission', swarm)
  const mission: Mission = {
    id,
    title: input.title,
    status: 'proposed',
    priority: input.priority,
    goal: input.goal,
    acceptance: input.acceptance ? [...input.acceptance] : [],
    acceptanceState: {},
    objectiveIds: [],
    blockers: [],
    createdBy: input.createdBy,
    createdTick: input.tick,
    updatedTick: input.tick,
    revision: 1,
  }
  swarm.missions[id] = mission
  return mission
}

export function admit_mission(swarm: SwarmStorage, missionId: string, expectedRevision: number, tick: SimulationTick) {
  const mission = swarm.missions[missionId]
  if (!mission) return { ok: false as const, code: 'not_found' as const }
  if (mission.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: mission.revision }
  if (mission.status !== 'proposed') return { ok: false as const, code: 'invalid_state' as const }
  mission.status = 'active'
  mission.updatedTick = tick
  mission.revision += 1
  return { ok: true as const, mission }
}

export function set_mission_blockers(swarm: SwarmStorage, missionId: string, expectedRevision: number, blockers: BlockerRef[], tick: SimulationTick) {
  const mission = swarm.missions[missionId]
  if (!mission) return { ok: false as const, code: 'not_found' as const }
  if (mission.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: mission.revision }
  if (mission.status === 'cancelled' || mission.status === 'failed' || mission.status === 'satisfied') {
    return { ok: false as const, code: 'terminal_state' as const }
  }
  mission.blockers = blockers.map(blocker => ({ ...blocker }))
  mission.updatedTick = tick
  mission.revision += 1
  reevaluate_mission(swarm, missionId, tick)
  return { ok: true as const, mission }
}

export interface CreateObjectiveInput {
  missionId: string
  description: string
  dependencies?: string[]
  acceptance?: AcceptanceCondition[]
  priority?: number
}

export function create_objective(swarm: SwarmStorage, input: CreateObjectiveInput) {
  const mission = swarm.missions[input.missionId]
  if (!mission) return { ok: false as const, code: 'mission_not_found' as const }
  if (mission.status === 'cancelled' || mission.status === 'failed' || mission.status === 'satisfied') {
    return { ok: false as const, code: 'mission_terminal' as const }
  }

  const dependencies = input.dependencies ? [...input.dependencies] : []
  for (const dependencyId of dependencies) {
    const dependency = swarm.objectives[dependencyId]
    if (!dependency) return { ok: false as const, code: 'dependency_not_found' as const, dependencyId }
    if (dependency.missionId !== mission.id) return { ok: false as const, code: 'dependency_mission_mismatch' as const, dependencyId }
  }

  const id = allocate_swarm_id('objective', swarm)
  const objective: Objective = {
    id,
    missionId: mission.id,
    description: input.description,
    status: 'pending',
    dependencies,
    acceptance: input.acceptance ? [...input.acceptance] : [],
    acceptanceState: {},
    evidence: [],
    projectIds: [],
    priority: input.priority ?? mission.priority,
    revision: 1,
  }
  swarm.objectives[id] = objective
  mission.objectiveIds.push(id)
  mission.revision += 1
  refresh_objective_state(swarm, id)
  return { ok: true as const, objective }
}

export function refresh_objective_state(swarm: SwarmStorage, objectiveId: string) {
  const objective = swarm.objectives[objectiveId]
  if (!objective || objective.status === 'satisfied' || objective.status === 'cancelled' || objective.status === 'active' || objective.status === 'blocked') return objective
  const next = objective_dependencies_satisfied(swarm, objective) ? 'ready' : 'pending'
  if (objective.status !== next) {
    objective.status = next
    objective.revision += 1
  }
  return objective
}

export function activate_objective(swarm: SwarmStorage, objectiveId: string, expectedRevision: number) {
  const objective = swarm.objectives[objectiveId]
  if (!objective) return { ok: false as const, code: 'not_found' as const }
  if (objective.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: objective.revision }
  if (objective.status !== 'ready') return { ok: false as const, code: 'invalid_state' as const }
  if (!objective_dependencies_satisfied(swarm, objective)) return { ok: false as const, code: 'dependencies_unsatisfied' as const }
  objective.status = 'active'
  objective.revision += 1
  return { ok: true as const, objective }
}

export interface CreateProjectInput {
  missionId: string
  objectiveId?: string
  title: string
  scope: ProjectScope
}

export function create_project(swarm: SwarmStorage, input: CreateProjectInput) {
  const mission = swarm.missions[input.missionId]
  if (!mission) return { ok: false as const, code: 'mission_not_found' as const }
  if (mission.status === 'cancelled' || mission.status === 'failed' || mission.status === 'satisfied') {
    return { ok: false as const, code: 'mission_terminal' as const }
  }
  if (input.objectiveId) {
    const objective = swarm.objectives[input.objectiveId]
    if (!objective || objective.missionId !== mission.id) return { ok: false as const, code: 'objective_not_found' as const }
    if (objective.status === 'cancelled' || objective.status === 'satisfied') return { ok: false as const, code: 'objective_terminal' as const }
  }
  const id = allocate_swarm_id('project', swarm)
  const project: Project = {
    id,
    missionId: mission.id,
    objectiveId: input.objectiveId,
    title: input.title,
    status: 'planning',
    scope: { ...input.scope },
    revision: 1,
    workItemIds: [],
    reservationIds: [],
    evidence: [],
    blockers: [],
  }
  swarm.projects[id] = project
  if (input.objectiveId) {
    const objective = swarm.objectives[input.objectiveId]
    objective.projectIds.push(id)
    objective.revision += 1
  }
  return { ok: true as const, project }
}

const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  planning: ['ready', 'cancelled'],
  ready: ['executing', 'blocked', 'cancelled'],
  executing: ['blocked', 'verifying', 'cancelled'],
  blocked: ['ready', 'executing', 'cancelled'],
  verifying: ['executing', 'blocked', 'complete', 'cancelled'],
  complete: [],
  cancelled: [],
}

function transition_allowed(from: ProjectStatus, to: ProjectStatus) {
  for (const candidate of PROJECT_TRANSITIONS[from]) if (candidate === to) return true
  return false
}

export function transition_project(
  swarm: SwarmStorage,
  projectId: string,
  expectedRevision: number,
  nextStatus: ProjectStatus,
  evidence: EvidenceRef[] = [],
) {
  const project = swarm.projects[projectId]
  if (!project) return { ok: false as const, code: 'not_found' as const }
  if (project.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: project.revision }
  if (!transition_allowed(project.status, nextStatus)) return { ok: false as const, code: 'invalid_transition' as const }
  if (nextStatus === 'complete' && evidence.length === 0) return { ok: false as const, code: 'insufficient_evidence' as const }
  project.status = nextStatus
  for (const ref of evidence) project.evidence.push(ref)
  project.revision += 1
  return { ok: true as const, project }
}

export function record_objective_acceptance(swarm: SwarmStorage, objectiveId: string, expectedRevision: number, evaluation: AcceptanceEvaluation) {
  const objective = swarm.objectives[objectiveId]
  if (!objective) return { ok: false as const, code: 'not_found' as const }
  if (objective.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: objective.revision }
  if (objective.status === 'cancelled') return { ok: false as const, code: 'terminal_state' as const }
  if (!has_acceptance_condition(objective.acceptance, evaluation.conditionId)) return { ok: false as const, code: 'unknown_condition' as const }
  if (evaluation.satisfied && evaluation.evidence.length === 0) return { ok: false as const, code: 'insufficient_evidence' as const }

  objective.acceptanceState[evaluation.conditionId] = evaluation
  objective.revision += 1
  for (const evidence of evaluation.evidence) objective.evidence.push(evidence)
  if (objective_dependencies_satisfied(swarm, objective) && all_acceptance_satisfied(objective.acceptance, objective.acceptanceState)) {
    objective.status = 'satisfied'
    for (const id in swarm.objectives) {
      const candidate = swarm.objectives[id]
      for (const dependencyId of candidate.dependencies) if (dependencyId === objective.id) refresh_objective_state(swarm, candidate.id)
    }
    reevaluate_mission(swarm, objective.missionId, evaluation.tick)
  }
  return { ok: true as const, objective }
}

export function record_mission_acceptance(swarm: SwarmStorage, missionId: string, expectedRevision: number, evaluation: AcceptanceEvaluation, tick: SimulationTick) {
  const mission = swarm.missions[missionId]
  if (!mission) return { ok: false as const, code: 'not_found' as const }
  if (mission.revision !== expectedRevision) return { ok: false as const, code: 'revision_mismatch' as const, currentRevision: mission.revision }
  if (mission.status === 'cancelled' || mission.status === 'failed' || mission.status === 'satisfied') return { ok: false as const, code: 'terminal_state' as const }
  if (!has_acceptance_condition(mission.acceptance, evaluation.conditionId)) return { ok: false as const, code: 'unknown_condition' as const }
  if (evaluation.satisfied && evaluation.evidence.length === 0) return { ok: false as const, code: 'insufficient_evidence' as const }

  mission.acceptanceState[evaluation.conditionId] = evaluation
  mission.updatedTick = tick
  mission.revision += 1
  reevaluate_mission(swarm, missionId, tick)
  return { ok: true as const, mission }
}

export function reevaluate_mission(swarm: SwarmStorage, missionId: string, tick: SimulationTick) {
  const mission = swarm.missions[missionId]
  if (!mission || mission.status === 'cancelled' || mission.status === 'failed' || mission.status === 'proposed') return mission
  let allObjectivesSatisfied = true
  for (const objectiveId of mission.objectiveIds) {
    if (swarm.objectives[objectiveId]?.status !== 'satisfied') allObjectivesSatisfied = false
  }
  const acceptanceSatisfied = all_acceptance_satisfied(mission.acceptance, mission.acceptanceState)
  const hasAcceptanceBasis = mission.objectiveIds.length > 0 || mission.acceptance.length > 0
  const next = hasAcceptanceBasis && allObjectivesSatisfied && acceptanceSatisfied ? 'satisfied' : mission.blockers.length > 0 ? 'blocked' : 'active'
  if (mission.status !== next) {
    mission.status = next
    mission.updatedTick = tick
    mission.revision += 1
  }
  return mission
}
