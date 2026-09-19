import { describe, expect, it } from 'vitest'
import { create_work, record_blackboard_event } from './blackboard'
import { build_message_board_snapshot, build_swarm_coordination_snapshot, query_blackboard_events } from './queries'
import { create_mission, create_objective, create_project } from './missions'
import { create_empty_swarm_storage } from './storage'

describe('bounded board queries', () => {
  it('reports lost cursors after retained history rotates', () => {
    const swarm = create_empty_swarm_storage()
    const first = record_blackboard_event(swarm, { recordId: 'x', event: 'created', tick: 1, revision: 1 })
    for (let i = 0; i < 520; i++) record_blackboard_event(swarm, { recordId: 'x', event: 'updated', tick: i + 2, revision: i + 2 })
    expect(query_blackboard_events(swarm, { afterEventId: first.id }).cursorLost).toBe(true)
  })

  it('builds a priority-ordered message board read model including dependency-pending work', () => {
    const swarm = create_empty_swarm_storage()
    create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'low' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    const high = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'high' }, requirements: { capabilities: [] }, priority: 99, createdTick: 1 })
    const pending = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'pending' }, requirements: { capabilities: [] }, priority: 50, dependencies: ['work-missing'], createdTick: 1 })
    const snapshot = build_message_board_snapshot(swarm, 4)
    expect(snapshot.work[0].id).toBe(high.id)
    expect(snapshot.work.some(work => work.id === pending.id)).toBe(true)
    expect(snapshot.counts.blockedWork).toBe(1)
  })
})


describe('swarm coordination snapshot', () => {
  it('keeps full counts while bounding canonical control-plane records', () => {
    const swarm = create_empty_swarm_storage()
    for (let i = 0; i < 5; i += 1) {
      create_mission(swarm, {
        title: `mission ${i}`,
        priority: 10 + i,
        goal: `goal ${i}`,
        createdBy: 'human',
        tick: i + 1,
      })
    }

    const snapshot = build_swarm_coordination_snapshot(swarm, 600, 2)
    expect(snapshot.schema).toBe('swarm_coordination_snapshot_v1')
    expect(snapshot.tick).toBe(600)
    expect(snapshot.limit).toBe(2)
    expect(snapshot.counts.missions).toBe(5)
    expect(snapshot.missions).toHaveLength(2)
  })

  it('projects mission/objective/project evidence without sharing mutable storage references', () => {
    const swarm = create_empty_swarm_storage()
    const mission = create_mission(swarm, {
      title: 'Automate science',
      priority: 90,
      goal: 'Sustain science production',
      acceptance: [{
        id: 'mission-rate',
        kind: 'world_state',
        description: 'Science line is operating',
        location: {
          surfaceIndex: 1,
          position: { x: 5, y: 6 },
          radius: 3,
        },
      }],
      createdBy: 'human',
      tick: 10,
    })
    const objectiveResult = create_objective(swarm, {
      missionId: mission.id,
      description: 'Establish steam power',
      acceptance: [{
        id: 'power-live',
        kind: 'world_state',
        description: 'Power is live',
      }],
    })
    if (!objectiveResult.ok) throw new Error(objectiveResult.code)
    const projectResult = create_project(swarm, {
      missionId: mission.id,
      objectiveId: objectiveResult.objective.id,
      title: 'Build steam plant',
      scope: {
        description: 'Steam plant footprint',
        allowedArea: {
          surfaceIndex: 1,
          position: { x: 20, y: 30 },
          radius: 8,
        },
        authorityTags: ['build'],
      },
    })
    if (!projectResult.ok) throw new Error(projectResult.code)

    const work = create_work(swarm, {
      missionId: mission.id,
      objectiveId: objectiveResult.objective.id,
      projectId: projectResult.project.id,
      createdBy: 'mission-tracker',
      goal: {
        kind: 'gather_resource',
        resourceName: 'iron-ore',
        itemName: 'iron-ore',
        count: 10,
        source: {
          surfaceIndex: 1,
          position: { x: 40, y: 50 },
          radius: 4,
        },
      },
      requirements: { capabilities: ['mine'] },
      priority: 80,
      createdTick: 20,
    })

    const snapshot = build_swarm_coordination_snapshot(swarm, 700, 12)
    snapshot.missions[0].objectiveIds.push('fake-objective')
    snapshot.missions[0].acceptance[0].location!.position.x = 999
    snapshot.projects[0].scope.allowedArea!.position.y = 999
    const projectedWork = snapshot.work.find(item => item.id === work.id)
    expect(projectedWork).toBeDefined()
    if (projectedWork?.goal.kind === 'gather_resource') projectedWork.goal.source.position.x = 999

    expect(swarm.missions[mission.id].objectiveIds).not.toContain('fake-objective')
    expect(swarm.missions[mission.id].acceptance[0].location!.position.x).toBe(5)
    expect(swarm.projects[projectResult.project.id].scope.allowedArea!.position.y).toBe(30)
    const storedGoal = swarm.board.work[work.id].goal
    expect(storedGoal.kind).toBe('gather_resource')
    if (storedGoal.kind === 'gather_resource') expect(storedGoal.source.position.x).toBe(40)
  })
})
