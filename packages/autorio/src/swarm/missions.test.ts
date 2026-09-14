import { describe, expect, it } from 'vitest'
import {
  activate_objective,
  admit_mission,
  create_mission,
  create_objective,
  create_project,
  record_mission_acceptance,
  record_objective_acceptance,
  reevaluate_mission,
  set_mission_blockers,
  transition_project,
} from './missions'
import { create_empty_swarm_storage } from './storage'

const evidence = [{ kind: 'operation_receipt' as const, id: 'receipt-1', tick: 10 }]

describe('mission graph', () => {
  it('unlocks dependencies and re-evaluates the mission after the final objective', () => {
    const swarm = create_empty_swarm_storage()
    const mission = create_mission(swarm, { title: 'Green science', priority: 70, goal: 'sustain science', createdBy: 'human', tick: 1 })
    expect(admit_mission(swarm, mission.id, mission.revision, 2).ok).toBe(true)
    const first = create_objective(swarm, { missionId: mission.id, description: 'circuits', acceptance: [{ id: 'circuits-ok', kind: 'custom', description: 'circuits verified' }] })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = create_objective(swarm, { missionId: mission.id, description: 'science', dependencies: [first.objective.id], acceptance: [{ id: 'science-ok', kind: 'custom', description: 'science verified' }] })
    expect(second).toMatchObject({ ok: true, objective: { status: 'pending' } })
    if (!second.ok) return

    expect(record_objective_acceptance(swarm, first.objective.id, first.objective.revision, { conditionId: 'circuits-ok', satisfied: true, evidence, tick: 10 }).ok).toBe(true)
    expect(second.objective.status).toBe('ready')
    expect(activate_objective(swarm, second.objective.id, second.objective.revision).ok).toBe(true)
    expect(record_objective_acceptance(swarm, second.objective.id, second.objective.revision, { conditionId: 'science-ok', satisfied: true, evidence, tick: 11 }).ok).toBe(true)
    expect(mission.status).toBe('satisfied')
  })

  it('rejects objective dependencies owned by another mission', () => {
    const swarm = create_empty_swarm_storage()
    const firstMission = create_mission(swarm, { title: 'M1', priority: 50, goal: 'G1', createdBy: 'human', tick: 1 })
    const secondMission = create_mission(swarm, { title: 'M2', priority: 50, goal: 'G2', createdBy: 'human', tick: 1 })
    const dependency = create_objective(swarm, { missionId: firstMission.id, description: 'dependency' })
    expect(dependency.ok).toBe(true)
    if (!dependency.ok) return
    expect(create_objective(swarm, { missionId: secondMission.id, description: 'invalid', dependencies: [dependency.objective.id] })).toMatchObject({
      ok: false,
      code: 'dependency_mission_mismatch',
      dependencyId: dependency.objective.id,
    })
  })

  it('requires evidence before mission acceptance can satisfy the mission', () => {
    const swarm = create_empty_swarm_storage()
    const mission = create_mission(swarm, { title: 'Green science', priority: 70, goal: 'sustain science', acceptance: [{ id: 'rate', kind: 'custom', description: 'rate verified' }], createdBy: 'human', tick: 1 })
    expect(admit_mission(swarm, mission.id, mission.revision, 2).ok).toBe(true)
    expect(record_mission_acceptance(swarm, mission.id, mission.revision, { conditionId: 'rate', satisfied: true, evidence: [], tick: 3 }, 3)).toMatchObject({ ok: false, code: 'insufficient_evidence' })
    expect(record_mission_acceptance(swarm, mission.id, mission.revision, { conditionId: 'rate', satisfied: true, evidence, tick: 4 }, 4).ok).toBe(true)
    expect(mission.status).toBe('satisfied')
  })

  it('uses explicit blockers without letting an empty mission satisfy itself', () => {
    const swarm = create_empty_swarm_storage()
    const mission = create_mission(swarm, { title: 'M', priority: 50, goal: 'G', createdBy: 'human', tick: 1 })
    expect(admit_mission(swarm, mission.id, mission.revision, 2).ok).toBe(true)
    reevaluate_mission(swarm, mission.id, 3)
    expect(mission.status).toBe('active')
    expect(set_mission_blockers(swarm, mission.id, mission.revision, [{ kind: 'custom', description: 'supply shortage' }], 4).ok).toBe(true)
    expect(mission.status).toBe('blocked')
    expect(set_mission_blockers(swarm, mission.id, mission.revision, [], 5).ok).toBe(true)
    expect(mission.status).toBe('active')
  })

  it('enforces project transitions and evidence-backed completion', () => {
    const swarm = create_empty_swarm_storage()
    const mission = create_mission(swarm, { title: 'M', priority: 50, goal: 'G', createdBy: 'human', tick: 1 })
    const objective = create_objective(swarm, { missionId: mission.id, description: 'O' })
    expect(objective.ok).toBe(true)
    if (!objective.ok) return
    const project = create_project(swarm, { missionId: mission.id, objectiveId: objective.objective.id, title: 'P', scope: { description: 'bounded area' } })
    expect(project.ok).toBe(true)
    if (!project.ok) return

    expect(transition_project(swarm, project.project.id, project.project.revision, 'executing')).toMatchObject({ ok: false, code: 'invalid_transition' })
    expect(transition_project(swarm, project.project.id, project.project.revision, 'ready').ok).toBe(true)
    expect(transition_project(swarm, project.project.id, project.project.revision, 'executing').ok).toBe(true)
    expect(transition_project(swarm, project.project.id, project.project.revision, 'verifying').ok).toBe(true)
    expect(transition_project(swarm, project.project.id, project.project.revision, 'complete')).toMatchObject({ ok: false, code: 'insufficient_evidence' })
    expect(transition_project(swarm, project.project.id, project.project.revision, 'complete', evidence).ok).toBe(true)
  })
})
