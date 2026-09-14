import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_context } from './actor_runtime_context'
import { create_empty_swarm_storage } from './storage'

function fake_actor(id: number): ControlledActor {
  const actor: any = {
    is_valid: true,
    character: {},
    surface: { index: 1 },
    force: { index: 1 },
    position: { x: 0, y: 0 },
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

describe('per-logical-actor runtime context', () => {
  it('advances independent task queues without cross-actor state changes', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    create_agent(swarm, firstId)
    create_agent(swarm, secondId)
    const firstActor = fake_actor(101)
    const secondActor = fake_actor(202)
    const registry = new_actor_registry(swarm)
    registry.register_actor(firstId, { resolve: () => firstActor, capabilities: ['move'] }, 1)
    registry.register_actor(secondId, { resolve: () => secondActor, capabilities: ['move'] }, 1)

    const first = new_actor_runtime_context(firstId, registry)
    const second = new_actor_runtime_context(secondId, registry)
    first.basic.submit_wait(1)
    second.basic.submit_wait(3)

    first.tick()
    ;(globalThis as any).game.tick += 1
    first.tick()

    expect(first.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_empty: true })
    expect(second.manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.WAITING,
      current_task: { remaining_ticks: 3 },
    })
    expect(first.basic.status().last_result).toMatchObject({ code: 'completed', actor_id: 101 })
    expect(second.basic.status().last_result).toMatchObject({ code: 'queued', actor_id: 202 })
  })

  it('discards only the missing actor volatile queue and leaves swarm ownership for recovery', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    create_agent(swarm, firstId)
    create_agent(swarm, secondId)
    let firstActor: ControlledActor | undefined = fake_actor(301)
    const secondActor = fake_actor(302)
    const registry = new_actor_registry(swarm)
    registry.register_actor(firstId, { resolve: () => firstActor, capabilities: ['move'] }, 1)
    registry.register_actor(secondId, { resolve: () => secondActor, capabilities: ['move'] }, 1)
    const first = new_actor_runtime_context(firstId, registry)
    const second = new_actor_runtime_context(secondId, registry)

    first.basic.submit_wait(10)
    first.basic.submit_wait(10)
    second.basic.submit_wait(10)
    swarm.board.claims['claim-1'] = {
      id: 'claim-1',
      workId: 'work-1',
      agentId: 'agent-1',
      actorId: firstId,
      actorBodyRevision: 1,
      acquiredTick: 1,
      leaseUntilTick: 100,
      lastProgressTick: 1,
      workRevision: 1,
      state: 'active',
    }

    firstActor = undefined
    ;(globalThis as any).game.tick = 2
    expect(first.tick()).toBe(false)

    expect(first.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
    expect(second.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.WAITING, queue_length: 0 })
    expect(swarm.board.claims['claim-1']).toBeDefined()
    expect(swarm.actors[firstId]).toMatchObject({ state: 'missing', bodyRevision: 1 })
  })

  it('fails closed if force-scoped research is injected into an actor context', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const actor = fake_actor(401)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => actor, capabilities: ['move'] }, 1)
    const context = new_actor_runtime_context(actorId, registry)

    context.manager.add_task({ type: TaskStates.RESEARCHING, technology_name: 'automation' })
    expect(context.tick()).toBe(false)
    expect(context.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_empty: true })
  })
})
