import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { create_work } from './blackboard'
import { create_empty_swarm_storage } from './storage'
import { new_work_coordinator } from './work_coordinator'

function fake_actor(id: number, inventoryCounts: Record<string, number>): ControlledActor {
  const inventory: any = {
    get_item_count: vi.fn((name: string) => inventoryCounts[name] ?? 0),
    get_contents: vi.fn(() => Object.keys(inventoryCounts).map(name => ({ name, count: inventoryCounts[name] }))),
  }
  const actor: any = {
    is_valid: true,
    character: {},
    surface: { index: 1 },
    force: { index: 1 },
    position: { x: 0, y: 0 },
    get_main_inventory: vi.fn(() => inventory),
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
      valid: true,
      name: `AIRI-${id}`,
      position: actor.position,
      has_character: true,
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

describe('resource gathering work', () => {
  it('claims nearby gather work and completes only after measured inventory satisfies the target', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const inventory: Record<string, number> = { stone: 0 }
    const actor = fake_actor(101, inventory)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => actor, capabilities: ['move', 'mine'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(actorId)
    const source = { surfaceIndex: 1, position: { x: 0, y: 0 }, radius: 3 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'gather_resource', resourceName: 'stone', itemName: 'stone', count: 5, source },
      requirements: { capabilities: ['move', 'mine'] },
      location: source,
      priority: 60,
      createdTick: 1,
    })
    const coordinator = new_work_coordinator(swarm, registry, router)

    const assigned = coordinator.tick(10)
    expect(assigned.assignments).toHaveLength(1)
    expect(swarm.board.work[work.id].status).toBe('active')
    expect(swarm.agents[agent.id].currentWorkId).toBe(work.id)
    expect(router.get_context(actorId)!.manager.player_state.task_state).toBe(TaskStates.MINING)

    inventory.stone = 5
    coordinator.tick(11)

    expect(swarm.board.work[work.id].status).toBe('completed')
    expect(swarm.board.work[work.id].evidence.length).toBeGreaterThan(0)
    expect(Object.keys(swarm.board.claims)).toHaveLength(0)
    expect(swarm.agents[agent.id].state).toBe('available')
    const results = Object.values(swarm.board.results).filter(result => result.workId === work.id)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('success')
  })

  it('turns an exhausted or missing resource source into a structured material blocker', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const actor = fake_actor(202, { stone: 0 }) as any
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => actor, capabilities: ['move', 'mine'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(actorId)
    const source = { surfaceIndex: 1, position: { x: 0, y: 0 }, radius: 3 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'gather_resource', resourceName: 'stone', itemName: 'stone', count: 5, source },
      requirements: { capabilities: ['move', 'mine'] },
      location: source,
      priority: 60,
      createdTick: 1,
    })
    const coordinator = new_work_coordinator(swarm, registry, router)

    coordinator.tick(10)
    const context = router.get_context(actorId)!
    const task = context.manager.player_state.parameters_mine_entity!
    context.basic.fail(actor, task, 'no_target')
    coordinator.tick(11)

    expect(swarm.board.work[work.id].status).toBe('blocked')
    expect(swarm.board.work[work.id].claimId).toBeUndefined()
    const requests = Object.values(swarm.board.requests)
    expect(requests).toHaveLength(1)
    expect(requests[0].kind).toBe('material_request')
    expect(requests[0].itemName).toBe('stone')
    expect(requests[0].blocksWorkIds).toContain(work.id)
  })
})
