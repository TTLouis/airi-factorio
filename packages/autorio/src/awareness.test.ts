import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_awareness_controller } from './awareness'

function make_actor(kind = 'standalone_character') {
  const surface = {
    index: 1,
    request_to_generate_chunks: vi.fn(),
    force_generate_chunk_requests: vi.fn(),
  }
  const force = {
    chart: vi.fn(),
  }
  const actor = {
    position: { x: 40, y: -1 },
    surface,
    force,
    status_snapshot: vi.fn(() => ({
      kind,
      valid: true,
      name: 'AIRI',
      position: { x: 40, y: -1 },
      has_character: true,
      actor_id: 9,
    })),
  } as unknown as ControlledActor
  return { actor, surface, force }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('standalone NPC awareness bubble', () => {
  it('fully generates and charts exactly a 3x3 chunk window when entering a chunk', () => {
    const { actor, surface, force } = make_actor()
    const controller = new_awareness_controller()

    expect(controller.tick(actor)).toBe(true)
    expect(surface.request_to_generate_chunks).toHaveBeenCalledWith(actor.position, 1)
    expect(surface.force_generate_chunk_requests).toHaveBeenCalledTimes(1)
    expect(force.chart).toHaveBeenCalledWith(surface, {
      left_top: { x: 0, y: -64 },
      right_bottom: { x: 96, y: 32 },
    })
    expect(surface.request_to_generate_chunks.mock.invocationCallOrder[0]).toBeLessThan(surface.force_generate_chunk_requests.mock.invocationCallOrder[0]!)
    expect(surface.force_generate_chunk_requests.mock.invocationCallOrder[0]).toBeLessThan(force.chart.mock.invocationCallOrder[0]!)
  })

  it('does not repeat generation/chart work while AIRI remains in the same chunk', () => {
    const { actor, surface, force } = make_actor()
    const controller = new_awareness_controller()

    controller.tick(actor)
    ;(actor.position as any).x = 47
    ;(actor.position as any).y = -16
    expect(controller.tick(actor)).toBe(false)

    expect(surface.request_to_generate_chunks).toHaveBeenCalledTimes(1)
    expect(surface.force_generate_chunk_requests).toHaveBeenCalledTimes(1)
    expect(force.chart).toHaveBeenCalledTimes(1)
  })

  it('refreshes the awareness bubble after crossing a chunk boundary', () => {
    const { actor, surface, force } = make_actor()
    const controller = new_awareness_controller()

    controller.tick(actor)
    ;(actor.position as any).x = 64
    expect(controller.tick(actor)).toBe(true)

    expect(surface.request_to_generate_chunks).toHaveBeenCalledTimes(2)
    expect(surface.force_generate_chunk_requests).toHaveBeenCalledTimes(2)
    expect(force.chart).toHaveBeenLastCalledWith(surface, {
      left_top: { x: 32, y: -64 },
      right_bottom: { x: 128, y: 32 },
    })
  })

  it('does not add the NPC radar bubble to a connected human actor', () => {
    const { actor, surface, force } = make_actor('connected_player')
    const controller = new_awareness_controller()

    expect(controller.tick(actor)).toBe(false)
    expect(surface.request_to_generate_chunks).not.toHaveBeenCalled()
    expect(surface.force_generate_chunk_requests).not.toHaveBeenCalled()
    expect(force.chart).not.toHaveBeenCalled()
  })
})
