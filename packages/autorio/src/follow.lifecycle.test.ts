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
  const controller = new_follow_controller(() => actor)
  return { actor, player, firstCharacter, controller }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('persistent follow player lifecycle', () => {
  it('keeps follow armed across disconnect and resumes after reconnect', () => {
    const c = context()
    expect(c.controller.submit('TTLouis', 4)[0]).toBe(true)
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'following' })

    c.player.connected = false
    ;(globalThis as any).game.tick = 10
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'player_unavailable', player_name: 'TTLouis' })

    c.player.connected = true
    c.player.position.x = 30
    ;(globalThis as any).game.tick = 20
    c.controller.tick(c.actor)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'following' })
    expect(c.actor.set_walking_state).toHaveBeenLastCalledWith(expect.objectContaining({ walking: true }))
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
  })

  it('can arm follow while an existing player is temporarily offline', () => {
    const c = context()
    c.player.connected = false
    c.player.character = undefined as any

    const result = c.controller.submit('TTLouis', 4)
    expect(result[0]).toBe(true)
    expect(c.controller.status()).toMatchObject({ active: true, code: 'player_unavailable' })
  })
})
