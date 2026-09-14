import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { create_work } from './blackboard'
import { create_empty_swarm_storage } from './storage'
import { new_work_coordinator } from './work_coordinator'

function fixture(actorItems: Record<string, number>, chestItems: Record<string, number>) {
  const actorInventory: any = {
    get_item_count: vi.fn((name: string) => actorItems[name] ?? 0),
    get_contents: vi.fn(() => Object.keys(actorItems).map(name => ({ name, count: actorItems[name] }))),
  }
  const chestInventory: any = {
    get_item_count: vi.fn((name: string) => chestItems[name] ?? 0),
  }
  const chest: any = {
    name: 'wooden-chest',
    position: { x: 0, y: 0 },
    get_max_inventory_index: vi.fn(() => 1),
    get_inventory: vi.fn(() => chestInventory),
  }
  const surface: any = {
    index: 1,
    find_entities_filtered: vi.fn((options: any) => options.name === 'wooden-chest' ? [chest] : []),
  }
  const actor: any = {
    is_valid: true,
    character: {},
    surface,
    force: { index: 1 },
    position: { x: 0, y: 0 },
    get_main_inventory: vi.fn(() => actorInventory),
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
      name: 'AIRI-logistics',
      position: actor.position,
      has_character: true,
      actor_id: 101,
    })),
  }
  return { actor: actor as ControlledActor, actorItems, chestItems }
}

function setup_actor(actor: ControlledActor) {
  const swarm = create_empty_swarm_storage()
  const actorId = allocate_logical_actor_id(swarm)
  const agent = create_agent(swarm, actorId)
  const registry = new_actor_registry(swarm)
  registry.register_actor(actorId, { resolve: () => actor, capabilities: ['move', 'transfer'] }, 1)
  const router = new_actor_runtime_router(registry)
  router.attach(actorId)
  const coordinator = new_work_coordinator(swarm, registry, router)
  return { swarm, actorId, agent, router, coordinator }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.print = vi.fn()
})

describe('item logistics work', () => {
  it('picks up measured items from a structured handoff endpoint', () => {
    const f = fixture({ stone: 0 }, { stone: 5 })
    const { swarm, actorId, agent, router, coordinator } = setup_actor(f.actor)
    const source = { surfaceIndex: 1, position: { x: 0, y: 0 }, radius: 2 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'acquire_items', itemName: 'stone', count: 5, source, sourceEntityName: 'wooden-chest' },
      requirements: { capabilities: ['move', 'transfer'] },
      location: source,
      priority: 60,
      createdTick: 1,
    })

    coordinator.tick(10)
    expect(swarm.board.work[work.id].status).toBe('active')
    expect(swarm.agents[agent.id].currentWorkId).toBe(work.id)
    expect(router.get_context(actorId)!.manager.player_state.task_state).toBe(TaskStates.MOVING_ITEMS)

    f.actorItems.stone = 5
    f.chestItems.stone = 0
    coordinator.tick(11)

    expect(swarm.board.work[work.id].status).toBe('completed')
    expect(swarm.board.work[work.id].evidence.length).toBeGreaterThan(0)
    expect(swarm.agents[agent.id].state).toBe('available')
    const results = Object.values(swarm.board.results).filter(result => result.workId === work.id)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('success')
  })

  it('delivers carried items and requires destination inventory evidence', () => {
    const f = fixture({ stone: 5 }, { stone: 0 })
    const { swarm, actorId, agent, router, coordinator } = setup_actor(f.actor)
    const destination = { surfaceIndex: 1, position: { x: 0, y: 0 }, radius: 2 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'deliver_items', itemName: 'stone', count: 5, destination, destinationEntityName: 'wooden-chest' },
      requirements: { capabilities: ['move', 'transfer'] },
      location: destination,
      priority: 60,
      createdTick: 1,
    })

    coordinator.tick(10)
    expect(swarm.board.work[work.id].status).toBe('active')
    expect(router.get_context(actorId)!.manager.player_state.task_state).toBe(TaskStates.MOVING_ITEMS)

    f.actorItems.stone = 0
    f.chestItems.stone = 5
    coordinator.tick(11)

    expect(swarm.board.work[work.id].status).toBe('completed')
    expect(swarm.board.work[work.id].evidence.length).toBeGreaterThan(0)
    expect(swarm.agents[agent.id].state).toBe('available')
    const observation = Object.values(swarm.board.observations).find(value => value.subject.includes(work.id))
    expect(observation?.data.destinationInventoryCount).toBe(5)
  })

  it('blocks delivery with a material Request when the assigned carrier lacks the item', () => {
    const f = fixture({ stone: 0 }, { stone: 0 })
    const { swarm, coordinator } = setup_actor(f.actor)
    const destination = { surfaceIndex: 1, position: { x: 0, y: 0 }, radius: 2 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'deliver_items', itemName: 'stone', count: 5, destination, destinationEntityName: 'wooden-chest' },
      requirements: { capabilities: ['move', 'transfer'] },
      location: destination,
      priority: 60,
      createdTick: 1,
    })

    coordinator.tick(10)
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
