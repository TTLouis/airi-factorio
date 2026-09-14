import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { create_work } from './blackboard'
import { reconcile_recovered_agents } from './agent_reconciliation'
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

describe('dynamic work reassignment and recovery', () => {
  it('releases missing-actor work to another agent and restores the replaced agent to available', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    const firstAgent = create_agent(swarm, firstId)
    const secondAgent = create_agent(swarm, secondId)
    let firstActor: ControlledActor | undefined = fake_actor(101, -10, 0)
    const secondActor = fake_actor(202, 10, 0) as any
    const registry = new_actor_registry(swarm)
    registry.register_actor(firstId, { resolve: () => firstActor, capabilities: ['move', 'survey'] }, 1)
    registry.register_actor(secondId, { resolve: () => secondActor, capabilities: ['move', 'survey'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(firstId)
    router.attach(secondId)
    const area = { surfaceIndex: 1, position: { x: -7, y: 0 }, radius: 1.5 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'survey_area', subject: 'reassign me', area },
      requirements: { capabilities: ['move', 'survey'] },
      location: area,
      priority: 70,
      createdTick: 1,
    })
    const coordinator = new_work_coordinator(swarm, registry, router)

    coordinator.tick(1)
    const firstClaimId = swarm.board.work[work.id].claimId
    expect(firstClaimId).toBeDefined()
    expect(swarm.board.claims[firstClaimId!].actorId).toBe(firstId)

    firstActor = undefined
    ;(globalThis as any).game.tick = 2
    coordinator.tick(2)

    const reassignedClaimId = swarm.board.work[work.id].claimId
    expect(reassignedClaimId).toBeDefined()
    expect(reassignedClaimId).not.toBe(firstClaimId)
    expect(swarm.board.claims[reassignedClaimId!].actorId).toBe(secondId)
    expect(swarm.agents[firstAgent.id]).toMatchObject({ state: 'recovering', currentWorkId: undefined })
    expect(swarm.agents[secondAgent.id].currentWorkId).toBe(work.id)

    secondActor.position = { x: -7, y: 0 }
    ;(globalThis as any).game.tick = 3
    coordinator.tick(3)
    expect(swarm.board.work[work.id].status).toBe('completed')
    expect(swarm.agents[secondAgent.id].state).toBe('available')

    firstActor = fake_actor(303, 0, 0)
    ;(globalThis as any).game.tick = 4
    const beforeRecovery = registry.runtime_snapshot(firstId, 4)
    expect(beforeRecovery).toMatchObject({ state: 'online', bodyRevision: 2 })
    expect(swarm.agents[firstAgent.id].state).toBe('recovering')

    expect(reconcile_recovered_agents(swarm, registry, 4)).toEqual([firstAgent.id])
    expect(swarm.agents[firstAgent.id]).toMatchObject({ state: 'available', currentWorkId: undefined })
  })
})
