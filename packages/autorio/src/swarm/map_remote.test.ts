import type { LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from '../actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_swarm_map_service } from './map_remote'

function make_surface(index = 1) {
  return {
    index,
    name: 'nauvis',
    valid: true,
    find_entities_filtered: vi.fn(() => []),
  } as unknown as LuaSurface
}

function make_actor(surface: LuaSurface, forceIndex = 1) {
  return {
    is_valid: true,
    surface,
    force: {
      index: forceIndex,
      name: 'player',
      recipes: {},
      is_chunk_charted: vi.fn(() => true),
      is_chunk_visible: vi.fn(() => true),
    },
    position: { x: 0, y: 0 },
    status_snapshot: () => ({ actor_id: 101, kind: 'standalone_character', valid: true, name: 'AIRI', position: { x: 0, y: 0 } }),
  } as unknown as ControlledActor
}

function status(capabilities: Array<'inspect' | 'build'> = ['inspect', 'build'], bodyRevision = 3, physicalActorId = 101) {
  return {
    found: true,
    runtime: {
      agentId: 'agent-1',
      registered: true,
      capabilities,
      state: 'online',
      bodyRevision,
      physical: {
        physicalActorId,
        kind: 'standalone_character',
        forceIndex: 1,
        surfaceIndex: 1,
      },
    },
  }
}

beforeEach(() => {
  ;(globalThis as any).game.tick = 500
  ;(globalThis as any).game.surfaces = {}
  ;(globalThis as any).game.get_surface = vi.fn()
})

describe('swarm actor-scoped map service', () => {
  it('binds map context to the current logical actor and body revision', () => {
    const surface = make_surface()
    ;(globalThis as any).game.surfaces[1] = surface
    const actor = make_actor(surface)
    const service = new_swarm_map_service(() => status(['inspect', 'build'], 7, 101), () => actor)

    expect(service.context('actor-1')).toMatchObject({
      ok: true,
      policy: { actor_scoped: true, map_first: true },
      observer: { actor_id: 'actor-1', agent_id: 'agent-1', body_revision: 7 },
      physical_surface: { index: 1, name: 'nauvis' },
    })
  })

  it('requires inspect capability for map observations', () => {
    const surface = make_surface()
    ;(globalThis as any).game.surfaces[1] = surface
    const actor = make_actor(surface)
    const service = new_swarm_map_service(() => status(['build']), () => actor)

    expect(service.query_area('actor-1', 1, 0, 0)).toEqual({
      ok: false,
      code: 'missing_capability',
      actor_id: 'actor-1',
      required_capability: 'inspect',
      entities: [],
    })
  })

  it('attaches exact observer provenance to successful visible queries', () => {
    const surface = make_surface()
    ;(globalThis as any).game.surfaces[1] = surface
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)
    const actor = make_actor(surface)
    const service = new_swarm_map_service(() => status(['inspect'], 4, 101), () => actor)

    expect(service.query_area('actor-1', 1, 0, 0, 8, 4)).toMatchObject({
      ok: true,
      code: 'ok',
      returned_count: 0,
      observer: { actor_id: 'actor-1', agent_id: 'agent-1', body_revision: 4 },
    })
  })

  it('fails closed when the authoritative physical body cannot be reacquired', () => {
    const surface = make_surface()
    ;(globalThis as any).game.surfaces[1] = surface
    const service = new_swarm_map_service(() => status(['inspect'], 4, 101), () => undefined)

    expect(service.inspect_entity('actor-1', 42)).toEqual({
      ok: false,
      code: 'no_body',
      actor_id: 'actor-1',
      unit_number: 42,
    })
  })

  it('requires build capability before any remote machine mutation', () => {
    const surface = make_surface()
    ;(globalThis as any).game.surfaces[1] = surface
    const actor = make_actor(surface)
    const service = new_swarm_map_service(() => status(['inspect']), () => actor)

    expect(service.set_machine_recipe('actor-1', 42, 'electronic-circuit')).toEqual({
      accepted: false,
      completed: false,
      code: 'missing_capability',
      actor_id: 'actor-1',
      unit_number: 42,
      recipe_name: 'electronic-circuit',
    })
  })
})
