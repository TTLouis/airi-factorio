import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { create_work } from './blackboard'
import { create_empty_swarm_storage } from './storage'
import { new_work_coordinator } from './work_coordinator'

function fake_actor(id: number, x: number, y: number): ControlledActor {
  const actor: any = {
    is_valid: true,
    character: {},
    surface: { index: 1 },
    force: { index: 1 },
    position: { x, y },
    get_main_inventory: vi.fn(() => undefined),
    update_selected_entity: vi.fn(),
    get_mining_state: vi.fn(() => ({ mining: false })),
    set_mining_state: vi.fn(),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    get_craftable_count: vi.fn(() => 0),
    begin_crafting: vi.fn(() => 0),
    cancel_crafting: vi.fn(),
    get_crafting_queue: vi.fn(() => []),
    get_crafting_queue_count: vi.fn(() => 0),
    owns_player_index: vi.fn(() => false),
    entity_build_args: vi.fn(() => ({ force: actor.force })),
    status_snapshot: vi.fn(() => ({
      kind: 'standalone_character',
      valid: actor.is_valid,
      name: `AIRI-${id}`,
      position: actor.position,
      has_character: actor.character !== undefined,
      actor_id: id,
    })),
  }
  return actor as ControlledActor
}

function create_survey(swarm: ReturnType<typeof create_empty_swarm_storage>, x: number, y: number, tick = 1) {
  const area = { surfaceIndex: 1, position: { x, y }, radius: 1.5 }
  return create_work(swarm, {
    createdBy: 'system',
    goal: { kind: 'survey_area', subject: `survey ${x},${y}`, area },
    requirements: { capabilities: ['move', 'survey'] },
    location: area,
    priority: 50,
    createdTick: tick,
  })
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.print = vi.fn()
})

describe('runtime work coordinator', () => {
  it('assigns two survey jobs by locality and completes them with measured evidence', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    const firstAgent = create_agent(swarm, firstId)
    const secondAgent = create_agent(swarm, secondId)
    const firstActor = fake_actor(101, -10, 0) as any
    const secondActor = fake_actor(202, 10, 0) as any
    const registry = new_actor_registry(swarm)
    registry.register_actor(firstId, { resolve: () => firstActor, capabilities: ['move', 'survey'] }, 1)
    registry.register_actor(secondId, { resolve: () => secondActor, capabilities: ['move', 'survey'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(firstId)
    router.attach(secondId)
    const left = create_survey(swarm, -6, 0)
    const right = create_survey(swarm, 6, 0)
    const coordinator = new_work_coordinator(swarm, registry, router)

    const firstTick = coordinator.tick(10)
    expect(firstTick.assignments).toHaveLength(2)
    expect(swarm.agents[firstAgent.id].currentWorkId).toBe(left.id)
    expect(swarm.agents[secondAgent.id].currentWorkId).toBe(right.id)
    expect(swarm.board.work[left.id].status).toBe('active')
    expect(swarm.board.work[right.id].status).toBe('active')
    expect(router.get_context(firstId)!.manager.player_state.task_state).toBe(TaskStates.WALKING_DIRECT)
    expect(router.get_context(secondId)!.manager.player_state.task_state).toBe(TaskStates.WALKING_DIRECT)

    firstActor.position = { x: -6, y: 0 }
    secondActor.position = { x: 6, y: 0 }
    coordinator.tick(11)

    expect(swarm.board.work[left.id].status).toBe('completed')
    expect(swarm.board.work[right.id].status).toBe('completed')
    expect(swarm.board.work[left.id].evidence.length).toBeGreaterThan(0)
    expect(swarm.board.work[right.id].evidence.length).toBeGreaterThan(0)
    expect(Object.keys(swarm.board.claims)).toHaveLength(0)
    expect(swarm.agents[firstAgent.id].state).toBe('available')
    expect(swarm.agents[secondAgent.id].state).toBe('available')
    expect(router.get_context(firstId)!.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(router.get_context(secondId)!.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('renews a lease only after measured movement toward the survey target', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const actor = fake_actor(301, 0, 0) as any
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => actor, capabilities: ['move', 'survey'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(actorId)
    const work = create_survey(swarm, 10, 0)
    const coordinator = new_work_coordinator(swarm, registry, router, {
      leaseTicks: 100,
      heartbeatIntervalTicks: 30,
      minimumProgressDistance: 0.25,
    })

    coordinator.tick(1)
    const claimId = swarm.board.work[work.id].claimId!
    expect(swarm.board.claims[claimId].leaseUntilTick).toBe(101)

    actor.position = { x: 2, y: 0 }
    coordinator.tick(31)
    const claim = swarm.board.claims[claimId]
    expect(claim.lastProgressTick).toBe(31)
    expect(claim.leaseUntilTick).toBe(131)
    expect(claim.progress?.evidence?.length).toBeGreaterThan(0)
  })

  it('does not claim work for an actor already busy with manual runtime work', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const actor = fake_actor(401, 0, 0)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => actor, capabilities: ['move', 'survey'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(actorId)
    router.get_context(actorId)!.basic.submit_wait(10)
    const work = create_survey(swarm, 5, 0)
    const coordinator = new_work_coordinator(swarm, registry, router)

    const tick = coordinator.tick(2)
    expect(tick.assignments).toHaveLength(0)
    expect(swarm.board.work[work.id].status).toBe('open')
    expect(Object.keys(swarm.board.claims)).toHaveLength(0)
  })
})
