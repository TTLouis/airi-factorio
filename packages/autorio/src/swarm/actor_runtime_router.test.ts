import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStates } from '../types'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_runtime_router } from './actor_runtime_router'
import { create_empty_swarm_storage } from './storage'

function fake_actor(id: number, playerIndex?: number): ControlledActor {
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
    owns_player_index: vi.fn((candidate: number) => playerIndex !== undefined && candidate === playerIndex),
    entity_build_args: vi.fn(() => ({ force: actor.force })),
    status_snapshot: vi.fn(() => ({
      kind: playerIndex === undefined ? 'standalone_character' : 'connected_player',
      valid: true,
      name: `actor-${id}`,
      position: actor.position,
      has_character: true,
      actor_id: id,
    })),
  }
  return actor as ControlledActor
}

function setup_two_actors() {
  const swarm = create_empty_swarm_storage()
  const firstId = allocate_logical_actor_id(swarm)
  const secondId = allocate_logical_actor_id(swarm)
  create_agent(swarm, firstId)
  create_agent(swarm, secondId)
  const first = fake_actor(101, 7)
  const second = fake_actor(202)
  const registry = new_actor_registry(swarm)
  registry.register_actor(firstId, { resolve: () => first, capabilities: ['move', 'mine'] }, 1)
  registry.register_actor(secondId, { resolve: () => second, capabilities: ['move', 'mine'] }, 1)
  return { swarm, registry, firstId, secondId, first, second }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.print = vi.fn()
})

describe('actor runtime router', () => {
  it('attaches registered actors and ticks them in deterministic logical-id order', () => {
    const { registry, firstId, secondId } = setup_two_actors()
    const router = new_actor_runtime_router(registry)
    expect(router.attach(secondId).ok).toBe(true)
    expect(router.attach(firstId).ok).toBe(true)

    router.get_context(firstId)!.basic.submit_wait(1)
    router.get_context(secondId)!.basic.submit_wait(3)
    const firstTick = router.tick_all()

    expect(firstTick.map(item => item.actorId)).toEqual([firstId, secondId])
    expect(router.get_context(firstId)!.manager.get_status_snapshot().current_task).toMatchObject({ remaining_ticks: 0 })
    expect(router.get_context(secondId)!.manager.get_status_snapshot().current_task).toMatchObject({ remaining_ticks: 2 })
  })

  it('refuses to detach a busy actor context', () => {
    const { registry, firstId } = setup_two_actors()
    const router = new_actor_runtime_router(registry)
    router.attach(firstId)
    router.get_context(firstId)!.basic.submit_wait(10)

    expect(router.detach(firstId)).toEqual({ ok: false, code: 'actor_busy' })
    expect(router.get_context(firstId)).toBeDefined()
  })

  it('routes a player-mined event only to the context that owns that player index', () => {
    const { registry, firstId, secondId } = setup_two_actors()
    const router = new_actor_runtime_router(registry)
    router.attach(firstId)
    router.attach(secondId)

    expect(router.on_player_mined_entity(7)).toEqual({ handled: true, actorId: firstId })
    expect(router.on_player_mined_entity(999)).toEqual({ handled: false, code: 'not_owned' })
  })

  it('routes a path result by request ownership and rejects ambiguous ownership', () => {
    const { registry, firstId, secondId } = setup_two_actors()
    const router = new_actor_runtime_router(registry)
    router.attach(firstId)
    router.attach(secondId)
    const first = router.get_context(firstId)!
    const second = router.get_context(secondId)!

    first.manager.add_task({
      type: TaskStates.WALKING_TO_ENTITY,
      entity_name: 'iron-chest',
      search_radius: 20,
      path: null,
      path_drawn: false,
      path_index: 1,
      calculating_path: true,
      target_position: { x: 1, y: 1 },
      owner_actor_id: 101,
      owner_actor_kind: 'connected_player',
      owner_force_index: 1,
      path_request_id: 77,
      path_attempts: 1,
    })

    expect(router.on_path_finished({ id: 88 } as any)).toEqual({ handled: false, code: 'not_owned' })

    second.manager.add_task({
      type: TaskStates.WALKING_TO_ENTITY,
      entity_name: 'iron-chest',
      search_radius: 20,
      path: null,
      path_drawn: false,
      path_index: 1,
      calculating_path: true,
      target_position: { x: 1, y: 1 },
      owner_actor_id: 202,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      path_request_id: 77,
      path_attempts: 1,
    })

    expect(router.on_path_finished({ id: 77 } as any)).toEqual({ handled: false, code: 'ambiguous_owner' })
  })
})
