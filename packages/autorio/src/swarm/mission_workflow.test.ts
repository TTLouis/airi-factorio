import { describe, expect, it } from 'vitest'
import { create_survey_mission_workflow } from './mission_workflow'
import { create_empty_swarm_storage } from './storage'

describe('survey mission workflow compiler', () => {
  it('creates one active objective and open work item per structured target', () => {
    const swarm = create_empty_swarm_storage()
    const result = create_survey_mission_workflow(swarm, {
      title: 'Map both approaches',
      priority: 70,
      createdBy: 'human',
      tick: 10,
      targets: [
        { x: -8, y: -2, radius: 2, label: 'west approach' },
        { x: 8, y: 2, radius: 2, priority: 80, label: 'east approach' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.objectiveIds).toHaveLength(2)
    expect(result.workIds).toHaveLength(2)
    const mission = swarm.missions[result.missionId]
    expect(mission).toMatchObject({ status: 'active', priority: 70 })
    expect(mission.objectiveIds).toEqual(result.objectiveIds)

    const firstObjective = swarm.objectives[result.objectiveIds[0]]
    const secondObjective = swarm.objectives[result.objectiveIds[1]]
    expect(firstObjective).toMatchObject({ missionId: mission.id, status: 'active', priority: 70 })
    expect(secondObjective).toMatchObject({ missionId: mission.id, status: 'active', priority: 80 })
    expect(firstObjective.acceptance).toHaveLength(1)
    expect(secondObjective.acceptance).toHaveLength(1)

    const firstWork = swarm.board.work[result.workIds[0]]
    const secondWork = swarm.board.work[result.workIds[1]]
    expect(firstWork).toMatchObject({
      missionId: mission.id,
      objectiveId: firstObjective.id,
      status: 'open',
      priority: 70,
      goal: { kind: 'survey_area' },
    })
    expect(secondWork).toMatchObject({
      missionId: mission.id,
      objectiveId: secondObjective.id,
      status: 'open',
      priority: 80,
      goal: { kind: 'survey_area' },
    })
  })

  it('validates all targets before mutating mission state', () => {
    const swarm = create_empty_swarm_storage()
    const result = create_survey_mission_workflow(swarm, {
      title: 'Invalid survey',
      priority: 50,
      createdBy: 'human',
      tick: 1,
      targets: [
        { x: 0, y: 0 },
        { x: 5, y: 5, radius: 0 },
      ],
    })

    expect(result).toEqual({ ok: false, code: 'invalid_target', targetIndex: 1 })
    expect(Object.keys(swarm.missions)).toHaveLength(0)
    expect(Object.keys(swarm.objectives)).toHaveLength(0)
    expect(Object.keys(swarm.board.work)).toHaveLength(0)
  })
})
