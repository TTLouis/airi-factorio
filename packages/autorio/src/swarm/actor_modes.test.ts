import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_actor_scoped_defense_controller } from './defense_adapter'
import { new_actor_scoped_follow_controller } from './follow_adapter'
import { new_actor_scoped_navigation_obstacle_recovery } from './navigation_obstacle_recovery_adapter'
import { create_empty_swarm_storage } from './storage'

function fake_actor(id: number): ControlledActor {
  const actor: any = {
    is_valid: true,
    character: {},
    surface: { index: 1 },
    force: { index: 1 },
    position: { x: 0, y: 0 },
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    status_snapshot: vi.fn(() => ({
      kind: 'standalone_character',
      valid: true,
      name: `actor-${id}`,
      position: actor.position,
      has_character: true,
      actor_id: id,
    })),
  }
  return actor as ControlledActor
}

function fake_navigation() {
  return {
    submit_player: vi.fn(() => [true, 'Task started'] as [boolean, string]),
    status: vi.fn(() => ({
      task_active: false,
      state: 'idle',
      player_name: undefined,
      path: undefined,
      last_result: undefined,
    })),
  } as any
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.get_player = vi.fn(() => ({
    valid: true,
    connected: true,
    character: {},
    name: 'Louis',
    surface: { index: 1, name: 'nauvis' },
    position: { x: 2, y: 0 },
  }))
})

describe('actor-scoped persistent NPC modes', () => {
  it('isolates follow state and removes only the following actor from scheduler admission', () => {
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

    const first = new_actor_scoped_follow_controller(firstId, () => firstActor, fake_navigation())
    const second = new_actor_scoped_follow_controller(secondId, () => secondActor, fake_navigation())

    expect(first.submit('Louis', 4, false)[0]).toBe(true)
    expect(first.status()).toMatchObject({ active: true, target_player: 'Louis', clear_obstacles: false })
    expect(second.status()).toMatchObject({ active: false, state: 'stopped' })
    expect(registry.admission_snapshot(firstId, 1)?.available).toBe(false)
    expect(registry.admission_snapshot(secondId, 1)?.available).toBe(true)

    expect(first.stop()[0]).toBe(true)
    expect(registry.admission_snapshot(firstId, 1)?.available).toBe(true)
  })

  it('isolates auto-defense state and leaves the primary NPC singleton untouched', () => {
    const primary = { enabled: true, radius: 24, code: 'armed', updated_tick: 1 }
    ;(globalThis as any).storage.airi_defense_state = primary
    const firstActor = fake_actor(301)
    const secondActor = fake_actor(302)
    const first = new_actor_scoped_defense_controller('actor-1', () => firstActor)
    const second = new_actor_scoped_defense_controller('actor-2', () => secondActor)

    expect(first.set_enabled(false)[0]).toBe(true)
    expect(first.status().enabled).toBe(false)
    expect(second.status().enabled).toBe(true)
    expect((globalThis as any).storage.airi_defense_state).toBe(primary)
  })

  it('isolates natural obstacle-clearing policy and restores the primary singleton slots', () => {
    ;(globalThis as any).storage.airi_navigation_clear_obstacles = true
    const first = new_actor_scoped_navigation_obstacle_recovery('actor-1')
    const second = new_actor_scoped_navigation_obstacle_recovery('actor-2')

    expect(first.set_enabled(false)).toBe(false)
    expect(first.enabled()).toBe(false)
    expect(second.enabled()).toBe(true)
    expect((globalThis as any).storage.airi_navigation_clear_obstacles).toBe(true)
  })
})
