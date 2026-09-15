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
    name: 'TTLouis',
    valid: true,
    connected: true,
    character: firstCharacter,
    surface: { index: 1, name: 'nauvis' },
    position: { x: 20, y: 0 },
  }
  ;(globalThis as any).game.get_player = vi.fn((name: string) => name === 'TTLouis' ? player : undefined)
  const navigate_to_player = vi.fn((_name: string, _reach_distance: number): [boolean, string] => [true, 'Task started'])
  const controller = new_follow_controller(() => actor, navigate_to_player)
  return { actor, player, firstCharacter, navigate_to_player, controller }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('persistent follow player lifecycle', () => {
  it('routes follow movement through shared navigation instead of direct collision-blind walking', () => {
    const c = context()
    expect(c.controller.submit('TTLouis', 4)[0]).toBe(true)

    c.controller.tick(c.actor)

    expect(c.navigate_to_player).toHaveBeenCalledWith('TTLouis', 4)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'following', last_navigation_tick: 0 })
    expect(c.actor.set_walking_state).not.toHaveBeenCalledWith(expect.objectContaining({ walking: true }))
  })

  it('keeps follow armed across disconnect and resumes path navigation after reconnect', () => {
    const c = context()
    expect(c.controller.submit('TTLouis', 4)[0]).toBe(true)
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'following' })
    expect(c.navigate_to_player).toHaveBeenCalledTimes(1)

    c.player.connected = false
    ;(globalThis as any).game.tick = 10
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'player_unavailable', player_name: 'TTLouis' })

    c.player.connected = true
    c.player.position.x = 30
    ;(globalThis as any).game.tick = 200
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'following' })
    expect(c.navigate_to_player).toHaveBeenCalledTimes(2)
  })

  it('keeps follow armed while the player is dead and reacquires the respawned character', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)

    c.player.character = undefined as any
    ;(globalThis as any).game.tick = 10
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'player_unavailable' })

    const respawnedCharacter = { valid: true, unit_number: 200 }
    c.player.character = respawnedCharacter as any
    c.player.position = { x: 12, y: 3 }
    ;(globalThis as any).game.tick = 20
    c.controller.tick(c.actor)

    expect(c.controller.status()).toMatchObject({
      active: true,
      code: 'following',
      player: { connected: true, has_character: true, position: { x: 12, y: 3 } },
    })
    expect(c.player.character).not.toBe(c.firstCharacter)
    expect(c.navigate_to_player).toHaveBeenCalledWith('TTLouis', 4)
  })

  it('pauses on another surface without cancelling the persistent follow intent', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)

    c.player.surface.index = 2
    c.player.surface.name = 'orbit'
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'different_surface' })

    c.player.surface.index = 1
    c.player.surface.name = 'nauvis'
    c.player.position = { x: 16, y: 0 }
    ;(globalThis as any).game.tick = 30
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'following' })
    expect(c.navigate_to_player).toHaveBeenCalledWith('TTLouis', 4)
  })

  it('can arm follow while an existing player is temporarily offline', () => {
    const c = context()
    c.player.connected = false
    c.player.character = undefined as any

    const result = c.controller.submit('TTLouis', 4)
    expect(result[0]).toBe(true)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'player_unavailable' })
    expect(c.navigate_to_player).not.toHaveBeenCalled()
  })

  it('backs off repeated navigation admission so an unreachable player does not thrash every idle tick', () => {
    const c = context()
    c.controller.submit('TTLouis', 4)

    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(1)

    ;(globalThis as any).game.tick = 30
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(1)

    ;(globalThis as any).game.tick = 120
    c.controller.tick(c.actor)
    expect(c.navigate_to_player).toHaveBeenCalledTimes(2)
  })
})
