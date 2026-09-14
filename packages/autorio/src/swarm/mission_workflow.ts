import { create_work } from './blackboard'
import { activate_objective, admit_mission, create_mission, create_objective } from './missions'
import type { AgentId, SimulationTick, SwarmStorage, WorldLocation } from './types'

export interface SurveyMissionTarget {
  x: number
  y: number
  surfaceIndex?: number
  radius?: number
  priority?: number
  label?: string
}

export interface CreateSurveyMissionWorkflowInput {
  title: string
  goal?: string
  priority: number
  targets: SurveyMissionTarget[]
  createdBy: 'human' | AgentId
  tick: SimulationTick
}

export type CreateSurveyMissionWorkflowResult
  = {
      ok: true
      missionId: string
      objectiveIds: string[]
      workIds: string[]
    }
    | {
      ok: false
      code: 'invalid_priority' | 'no_targets' | 'invalid_target'
      targetIndex?: number
    }

function valid_priority(value: number) {
  return typeof value === 'number' && value === value && value >= 0 && value <= 100
}

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value > -1000000 && value < 1000000
}

function target_location(target: SurveyMissionTarget): WorldLocation | undefined {
  const radius = target.radius ?? 1.5
  const surfaceIndex = target.surfaceIndex ?? 1
  if (!valid_coordinate(target.x) || !valid_coordinate(target.y)) return undefined
  if (typeof radius !== 'number' || radius !== radius || radius <= 0 || radius > 128) return undefined
  if (typeof surfaceIndex !== 'number' || surfaceIndex !== surfaceIndex || surfaceIndex <= 0) return undefined
  if (target.priority !== undefined && !valid_priority(target.priority)) return undefined
  return {
    surfaceIndex,
    position: { x: target.x, y: target.y },
    radius,
  }
}

/**
 * Deterministically compile a structured survey mission into one independently
 * claimable Objective + Work pair per target. This intentionally avoids natural
 * language planning: callers must provide the target locations explicitly.
 */
export function create_survey_mission_workflow(
  swarm: SwarmStorage,
  input: CreateSurveyMissionWorkflowInput,
): CreateSurveyMissionWorkflowResult {
  if (!valid_priority(input.priority)) return { ok: false, code: 'invalid_priority' }
  if (input.targets.length === 0) return { ok: false, code: 'no_targets' }

  const locations: WorldLocation[] = []
  for (let index = 0; index < input.targets.length; index += 1) {
    const location = target_location(input.targets[index])
    if (location === undefined) return { ok: false, code: 'invalid_target', targetIndex: index }
    locations.push(location)
  }

  const mission = create_mission(swarm, {
    title: input.title,
    priority: input.priority,
    goal: input.goal ?? `Survey ${input.targets.length} target locations`,
    createdBy: input.createdBy,
    tick: input.tick,
  })
  const admitted = admit_mission(swarm, mission.id, mission.revision, input.tick)
  if (!admitted.ok) throw new Error(`Could not admit newly created mission ${mission.id}: ${admitted.code}`)

  const objectiveIds: string[] = []
  const workIds: string[] = []

  for (let index = 0; index < input.targets.length; index += 1) {
    const target = input.targets[index]
    const location = locations[index]
    const label = target.label ?? `Survey target ${index + 1}`
    const acceptanceId = `survey-target-${index + 1}`
    const createdObjective = create_objective(swarm, {
      missionId: mission.id,
      description: label,
      priority: target.priority ?? input.priority,
      acceptance: [{
        id: acceptanceId,
        kind: 'world_state',
        description: `${label} reached and observed`,
        location,
      }],
    })
    if (!createdObjective.ok) throw new Error(`Could not create objective for mission ${mission.id}: ${createdObjective.code}`)

    const activated = activate_objective(swarm, createdObjective.objective.id, createdObjective.objective.revision)
    if (!activated.ok) throw new Error(`Could not activate objective ${createdObjective.objective.id}: ${activated.code}`)

    const work = create_work(swarm, {
      missionId: mission.id,
      objectiveId: activated.objective.id,
      createdBy: 'mission-tracker',
      goal: {
        kind: 'survey_area',
        subject: label,
        area: location,
      },
      requirements: { capabilities: ['move', 'survey'] },
      location,
      priority: target.priority ?? input.priority,
      createdTick: input.tick,
    })
    objectiveIds.push(activated.objective.id)
    workIds.push(work.id)
  }

  return {
    ok: true,
    missionId: mission.id,
    objectiveIds,
    workIds,
  }
}
