import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_follow_controller } from './follow'

function context() {
  const actorPosition = { x: 0, y: 0 }
  const actor = {
    is_valid: true,
    character: { valid: true },
    surface: { index: 1 },
    position: actorPosition,
    set_walking_state: vi.fn(),
    status_snapshot: vi.fn(() => ({ actor_id: 18, kind: 'standalone_character', valid: true, has_character: true })),
  } as unknown as ControlledActor
  const firstCharacter = { valid: true, unit_number: 100 }
  const player = {
    name: 'TTLouis', valid: true, connected: true, character: firstCharacter,
    surface: { index: 1, name: 'nauvis' }, position: { x: 20, y: 0 },
  }
  const navStatus: any = { task_active: false, state: 'idle', last_result: undefined }
  ;(globalThis as any).game.get_player = vi.fn((name: string) => name === 'TTLouis' ? player : undefined)
  ;(globalThis as any).remote.interfaces = { autorio_navigation: {} }
  ;(globalThis as any).remote.call = vi.fn((name: string, method: string) => name === 'autorio_navigation' && method === 'status' ? navStatus : undefined)
  const navigate_to_player = vi.fn((_name: string, _reach_distance: number): [boolean, string] => {
    navStatus.task_active = true
    navStatus.state = 'navigating'
    navStatus.player_name = 'TTLouis'
    navStatus.persistent_follow = true
    navStatus.path = { attempts: 1, waypoints_remaining: 3, physical_last_progress_tick: (globalThis as any).game.tick }
    return [true, 'Task started']
  })
  const controller = new_follow_controller(() => actor, navigate_to_player)
  return { actor, actorPosition, player, firstCharacter, navStatus, navigate_to_player, controller }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('persistent follow player lifecycle', () => {
  it('routes follow movement through shared navigation and reports a live healthy controller', () => {
    const c = context()
    expect(c.controller.submit('TTLouis', 4)[0]).toBe(true)
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledWith('TTLouis', 4)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'following', code: 'following', healthy: true, controller_live: true, last_navigation_tick: 0 })
    expect(c.actor.set_walking_state).not.toHaveBeenCalledWith(expect.objectContaining({ walking: true }))
  })

  it('does not re-admit navigation while the live follow navigation task is running', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.controller.tick(c.actor)
    ;(globalThis as any).game.tick = 200
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(1)
    expect(c.controller.status().healthy).toBe(true)
  })

  it('repairs stale active follow state that has no live navigation controller', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.navStatus.task_active = false
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(1)
    expect(c.controller.status()).toMatchObject({ healthy: true, state: 'following' })
  })

  it('keeps follow armed across disconnect and resumes path navigation after reconnect', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.controller.tick(c.actor)
    c.navStatus.task_active = false
    c.player.connected = false
    ;(globalThis as any).game.tick = 10
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'paused', code: 'player_unavailable', healthy: false })

    c.player.connected = true
    c.player.position.x = 30
    ;(globalThis as any).game.tick = 200
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'following' })
    expect(c.navigate_to_player).toHaveBeenCalledTimes(2)
  })

  it('keeps follow armed while the player is dead and reacquires the respawned character', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.player.character = undefined as any
    ;(globalThis as any).game.tick = 10
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'paused', code: 'player_unavailable' })

    c.player.character = { valid: true, unit_number: 200 } as any
    c.player.position = { x: 12, y: 3 }
    ;(globalThis as any).game.tick = 20
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'following', player: { connected: true, has_character: true, position: { x: 12, y: 3 } } })
    expect(c.player.character).not.toBe(c.firstCharacter)
  })

  it('pauses on another surface without cancelling the persistent follow intent', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.player.surface.index = 2
    c.player.surface.name = 'orbit'
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'paused', code: 'different_surface' })

    c.player.surface.index = 1
    c.player.surface.name = 'nauvis'
    c.player.position = { x: 16, y: 0 }
    ;(globalThis as any).game.tick = 30
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'following' })
  })

  it('can arm follow while an existing player is temporarily offline', () => {
    const c = context()
    c.player.connected = false
    c.player.character = undefined as any
    const result = c.controller.submit('TTLouis', 4)
    expect(result[0]).toBe(true)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'paused', code: 'player_unavailable', healthy: false })
    expect(c.navigate_to_player).not.toHaveBeenCalled()
  })

  it('stops immediately, exposes stopped health, and a later submit starts real navigation again', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.controller.tick(c.actor)
    c.navStatus.task_active = false
    expect(c.controller.stop()[0]).toBe(true)
    expect(c.controller.status()).toMatchObject({ active: false, state: 'stopped', code: 'stopped', healthy: false })
    expect(c.actor.set_walking_state).toHaveBeenCalledWith(expect.objectContaining({ walking: false }))

    ;(globalThis as any).game.tick = 200
    expect(c.controller.submit('TTLouis', 4)[0]).toBe(true)
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(2)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'following', healthy: true })
  })

  it('keeps bounded navigation failure blocked until the target materially moves', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)
    c.controller.tick(c.actor)
    c.navStatus.task_active = false
    c.navStatus.state = 'blocked'
    c.navStatus.last_result = { code: 'unreachable', blocked_reason: 'unreachable', player_name: 'TTLouis', tick: 100 }
    ;(globalThis as any).game.tick = 200
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, state: 'blocked', code: 'navigation_blocked', healthy: false, blocked_reason: 'unreachable' })
    const calls = c.navigate_to_player.mock.calls.length

    ;(globalThis as any).game.tick = 400
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(calls)

    c.player.position.x += 8
    ;(globalThis as any).game.tick = 600
    c.controller.tick(c.actor)
    expect(c.navigate_to_player.mock.calls.length).toBeGreaterThan(calls)
  })
})
