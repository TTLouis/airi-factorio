import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { create_work } from './blackboard'
import { create_cooperative_craft_mission_workflow } from './production_workflow'
import { create_empty_swarm_storage } from './storage'
import { new_work_coordinator } from './work_coordinator'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.print = vi.fn()
})

function crafting_actor(items: Record<string, number>): ControlledActor {
  const inventory: any = {
    get_item_count: vi.fn((name: string) => items[name] ?? 0),
    get_contents: vi.fn(() => Object.keys(items).map(name => ({ name, count: items[name] }))),
  }
  const actor: any = {
    is_valid: true,
    character: {},
    surface: { index: 1 },
    force: {
      index: 1,
      recipes: {
        'stone-furnace': { enabled: true },
      },
    },
    position: { x: 0, y: 0 },
    get_main_inventory: vi.fn(() => inventory),
    update_selected_entity: vi.fn(),
    get_mining_state: vi.fn(() => ({ mining: false })),
    set_mining_state: vi.fn(),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    get_craftable_count: vi.fn((name: string) => name === 'stone-furnace' && (items.stone ?? 0) >= 5 ? 1 : 0),
    begin_crafting: vi.fn(({ count }: { count: number }) => {
      items.stone = math.max(0, (items.stone ?? 0) - 5 * count)
      items['stone-furnace'] = (items['stone-furnace'] ?? 0) + count
      return count
    }),
    cancel_crafting: vi.fn(),
    get_crafting_queue: vi.fn(() => []),
    get_crafting_queue_count: vi.fn(() => 0),
    owns_player_index: vi.fn(() => false),
    entity_build_args: vi.fn(() => ({ force: actor.force })),
    status_snapshot: vi.fn(() => ({
      kind: 'standalone_character',
      valid: true,
      name: 'AIRI-crafter',
      position: actor.position,
      has_character: true,
      actor_id: 501,
    })),
  }
  return actor as ControlledActor
}

describe('cooperative production work', () => {
  it('completes craft Work only from the actor-scoped native crafting receipt', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const items: Record<string, number> = { stone: 5, 'stone-furnace': 0 }
    const actor = crafting_actor(items)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => actor, capabilities: ['craft'] }, 1)
    const router = new_actor_runtime_router(registry)
    router.attach(actorId)
    const coordinator = new_work_coordinator(swarm, registry, router)
    const location = { surfaceIndex: 1, position: { x: 0, y: 0 }, radius: 2 }
    const work = create_work(swarm, {
      createdBy: 'system',
      goal: { kind: 'craft_items', itemName: 'stone-furnace', count: 1 },
      requirements: { capabilities: ['craft'] },
      location,
      priority: 60,
      createdTick: 1,
    })

    coordinator.tick(10)
    const context = router.get_context(actorId)!
    expect(swarm.board.work[work.id].status).toBe('active')
    expect(context.manager.player_state.task_state).toBe(TaskStates.CRAFTING)

    ;(globalThis as any).game.tick = 11
    context.crafting.tick(actor)
    expect(context.crafting.status().last_result?.code).toBe('completed')
    expect(items['stone-furnace']).toBe(1)

    coordinator.tick(12)
    expect(swarm.board.work[work.id].status).toBe('completed')
    expect(swarm.agents[agent.id].state).toBe('available')
    expect(swarm.board.work[work.id].evidence.length).toBeGreaterThan(0)
    const receiptObservation = Object.values(swarm.board.observations).find(value => value.subject.includes(work.id))
    expect(receiptObservation?.evidenceClass).toBe('operation_receipt')
    expect(receiptObservation?.data.producedCount).toBe(1)
  })

  it('compiles gather, handoff, pickup, and craft as one dependency chain under a mission objective', () => {
    const swarm = create_empty_swarm_storage()
    const resourceSource = { surfaceIndex: 1, position: { x: -6, y: 0 }, radius: 3 }
    const handoffLocation = { surfaceIndex: 1, position: { x: -1, y: 0 }, radius: 2 }
    const created = create_cooperative_craft_mission_workflow(swarm, {
      title: 'Cooperative stone furnace',
      priority: 70,
      resourceName: 'stone',
      rawItemName: 'stone',
      rawItemCount: 5,
      resourceSource,
      handoffEntityName: 'wooden-chest',
      handoffLocation,
      outputItemName: 'stone-furnace',
      outputCount: 1,
      createdBy: 'human',
      tick: 1,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(swarm.missions[created.missionId].status).toBe('active')
    expect(swarm.objectives[created.objectiveId].status).toBe('active')
    expect(swarm.board.work[created.gatherWorkId].goal.kind).toBe('gather_resource')
    expect(swarm.board.work[created.gatherWorkId].status).toBe('open')
    expect(swarm.board.work[created.deliveryWorkId].dependencies).toEqual([created.gatherWorkId])
    expect(swarm.board.work[created.deliveryWorkId].status).toBe('pending_dependency')
    expect(swarm.board.work[created.acquireWorkId].dependencies).toEqual([created.deliveryWorkId])
    expect(swarm.board.work[created.acquireWorkId].status).toBe('pending_dependency')
    expect(swarm.board.work[created.craftWorkId].dependencies).toEqual([created.acquireWorkId])
    expect(swarm.board.work[created.craftWorkId].status).toBe('pending_dependency')
    expect(swarm.board.work[created.craftWorkId].goal).toEqual({ kind: 'craft_items', itemName: 'stone-furnace', count: 1 })
  })
})
