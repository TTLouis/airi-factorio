import { describe, expect, it } from 'vitest'
import { create_survey_mission_workflow } from './mission_workflow'
import { reconcile_mission_work_completion } from './mission_completion'
import { post_observation } from './blackboard'
import { create_empty_swarm_storage } from './storage'

describe('mission work completion reconciliation', () => {
  it('satisfies evidence-backed single-condition objectives and then the mission', () => {
    const swarm = create_empty_swarm_storage()
    const workflow = create_survey_mission_workflow(swarm, {
      title: 'Survey checkpoint',
      priority: 60,
      createdBy: 'human',
      tick: 1,
      targets: [{ x: 5, y: 0, label: 'checkpoint' }],
    })
    expect(workflow.ok).toBe(true)
    if (!workflow.ok) return

    const work = swarm.board.work[workflow.workIds[0]]
    const observation = post_observation(swarm, {
      observer: 'system',
      subject: 'checkpoint reached',
      location: work.location,
      evidenceClass: 'measured',
      data: { reached: true },
      observedTick: 2,
    })
    work.status = 'completed'
    work.updatedTick = 2
    work.revision += 1
    work.evidence.push({ kind: 'observation', id: observation.id, tick: 2 })

    expect(reconcile_mission_work_completion(swarm, 3)).toEqual([workflow.objectiveIds[0]])
    expect(swarm.objectives[workflow.objectiveIds[0]].status).toBe('satisfied')
    expect(swarm.missions[workflow.missionId].status).toBe('satisfied')
  })
})
