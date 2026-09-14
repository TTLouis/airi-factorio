import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.print = vi.fn()
})

describe('global actor-work assignment', () => {
  it('gives a single open job to the best-scoring actor instead of the first actor id', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    const firstAgent = create_agent(swarm, firstId)
    const secondAgent = create_agent(swarm, secondId)
    const firstActor = fake_actor(101, -10, 0)
    const secondActor = fake_actor(202, 8, 0)
    const registry = new_actor_registry(swarm)
    registry.register_actor(firstId, { resolve: () => firstActor, capabilities: ['move', 'survey'] }, 1)
    registry.register_actor(secondId, { resolve: () => secondActor, capabilities: ['move', 'survey'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(firstId)
    router.attach(secondId)

    const area = { surfaceIndex: 1, position: { x: 10, y: 0 }, radius: 1.5 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'survey_area', subject: 'nearest actor wins', area },
      requirements: { capabilities: ['move', 'survey'] },
      location: area,
      priority: 50,
      createdTick: 1,
    })
    const coordinator = new_work_coordinator(swarm, registry, router)

    const result = coordinator.tick(10)

    expect(result.assignments).toHaveLength(1)
    expect(result.assignments[0]).toMatchObject({ actorId: secondId, workId: work.id })
    expect(swarm.agents[firstAgent.id].state).toBe('available')
    expect(swarm.agents[firstAgent.id].currentWorkId).toBeUndefined()
    expect(swarm.agents[secondAgent.id].state).toBe('working')
    expect(swarm.agents[secondAgent.id].currentWorkId).toBe(work.id)
    expect(swarm.board.work[work.id].status).toBe('active')
  })
})
