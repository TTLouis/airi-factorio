import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { new_standalone_actor_pool } from './standalone_actor_pool'
import { create_empty_swarm_storage } from './storage'

function make_surface(index: number, startUnitNumber = 100) {
  const entities: any[] = []
  let nextUnitNumber = startUnitNumber
  const surface: any = {
    index,
    entities,
    find_entities_filtered: vi.fn((query: { name?: string }) => query.name === 'character' ? [...entities] : []),
    create_entity: vi.fn((params: { position: { x: number, y: number }, force: any }) => {
      const entity: any = {
        valid: true,
        unit_number: nextUnitNumber++,
        position: { x: params.position.x, y: params.position.y },
        surface,
        force: params.force,
        selected: undefined,
        mining_state: { mining: false },
        character_mining_progress: 0,
        crafting_queue: [],
        update_selected_entity: vi.fn(),
        get_main_inventory: vi.fn(() => undefined),
        get_craftable_count: vi.fn(() => 0),
        begin_crafting: vi.fn(() => 0),
        cancel_crafting: vi.fn(),
      }
      entities.push(entity)
      return entity
    }),
  }
  return surface
}

function remove_body(surface: any, unitNumber: number) {
  const index = surface.entities.findIndex((entity: any) => entity.unit_number === unitNumber)
  if (index < 0) return false
  surface.entities[index].valid = false
  surface.entities.splice(index, 1)
  return true
}

beforeEach(() => {
  ;(globalThis as any).storage = { standalone_character_unit_number: 999 }
})

describe('standalone swarm actor pool', () => {
  it('creates a registered body without touching legacy singleton persistence', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const registry = new_actor_registry(swarm)
    const pool = new_standalone_actor_pool(swarm, registry)
    const surface = make_surface(1, 101)
    const force = { index: 1 }
    ;(globalThis as any).game = { ...(globalThis as any).game, surfaces: { 1: surface } }

    expect(pool.register_actor(actorId, ['move', 'mine'], 1).ok).toBe(true)
    const created = pool.create_body(actorId, surface, force as any, { x: 4, y: 8 }, 2)

    expect(created.ok).toBe(true)
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(999)
    expect(registry.runtime_snapshot(actorId, 3)).toMatchObject({
      actorId,
      agentId: agent.id,
      state: 'online',
      bodyRevision: 1,
      physical: {
        physicalActorId: 101,
        kind: 'standalone_character',
        forceIndex: 1,
        surfaceIndex: 1,
      },
    })
  })

  it('creates two logical actors with independent physical bodies', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    create_agent(swarm, firstId)
    create_agent(swarm, secondId)
    const registry = new_actor_registry(swarm)
    const pool = new_standalone_actor_pool(swarm, registry)
    const surface = make_surface(1, 200)
    const force = { index: 1 }
    ;(globalThis as any).game = { ...(globalThis as any).game, surfaces: { 1: surface } }

    pool.register_actor(firstId, ['move'], 1)
    pool.register_actor(secondId, ['mine'], 1)
    expect(pool.create_body(firstId, surface, force as any, { x: 0, y: 0 }, 2).ok).toBe(true)
    expect(pool.create_body(secondId, surface, force as any, { x: 10, y: 0 }, 2).ok).toBe(true)

    expect(registry.runtime_snapshot(firstId, 3)?.physical?.physicalActorId).toBe(200)
    expect(registry.runtime_snapshot(secondId, 3)?.physical?.physicalActorId).toBe(201)
    expect(pool.resolve_body(firstId)?.status_snapshot().actor_id).toBe(200)
    expect(pool.resolve_body(secondId)?.status_snapshot().actor_id).toBe(201)
  })

  it('reacquires the same persisted body after registry and pool recreation', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const surface = make_surface(1, 300)
    const force = { index: 1 }
    ;(globalThis as any).game = { ...(globalThis as any).game, surfaces: { 1: surface } }

    const firstRegistry = new_actor_registry(swarm)
    const firstPool = new_standalone_actor_pool(swarm, firstRegistry)
    firstPool.register_actor(actorId, ['move'], 1)
    firstPool.create_body(actorId, surface, force as any, { x: 0, y: 0 }, 2)
    expect(swarm.actors[actorId].bodyRevision).toBe(1)

    const secondRegistry = new_actor_registry(swarm)
    const secondPool = new_standalone_actor_pool(swarm, secondRegistry)
    const registered = secondPool.register_actor(actorId, ['move'], 100)

    expect(registered.ok).toBe(true)
    expect(secondPool.resolve_body(actorId)?.status_snapshot().actor_id).toBe(300)
    expect(swarm.actors[actorId].bodyRevision).toBe(1)
  })

  it('increments body generation only when a dead body is actually replaced', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const registry = new_actor_registry(swarm)
    const pool = new_standalone_actor_pool(swarm, registry)
    const surface = make_surface(1, 400)
    const force = { index: 1 }
    ;(globalThis as any).game = { ...(globalThis as any).game, surfaces: { 1: surface } }

    pool.register_actor(actorId, ['move'], 1)
    pool.create_body(actorId, surface, force as any, { x: 0, y: 0 }, 2)
    expect(swarm.actors[actorId].bodyRevision).toBe(1)

    expect(remove_body(surface, 400)).toBe(true)
    registry.reconcile_actor(actorId, 3)
    expect(swarm.actors[actorId]).toMatchObject({ state: 'missing', bodyRevision: 1 })

    const replaced = pool.create_body(actorId, surface, force as any, { x: 1, y: 1 }, 4)
    expect(replaced.ok).toBe(true)
    expect(swarm.actors[actorId]).toMatchObject({
      state: 'online',
      bodyRevision: 2,
      physical: { physicalActorId: 401 },
    })
  })

  it('refuses replacement while a claim still belongs to the missing body generation', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const registry = new_actor_registry(swarm)
    const pool = new_standalone_actor_pool(swarm, registry)
    const surface = make_surface(1, 500)
    const force = { index: 1 }
    ;(globalThis as any).game = { ...(globalThis as any).game, surfaces: { 1: surface } }

    pool.register_actor(actorId, ['move'], 1)
    pool.create_body(actorId, surface, force as any, { x: 0, y: 0 }, 2)
    remove_body(surface, 500)
    registry.reconcile_actor(actorId, 3)

    swarm.board.claims['claim-1'] = {
      id: 'claim-1',
      workId: 'work-1',
      agentId: agent.id,
      actorId,
      actorBodyRevision: 1,
      acquiredTick: 2,
      leaseUntilTick: 100,
      lastProgressTick: 2,
      workRevision: 1,
      state: 'active',
    }

    expect(pool.create_body(actorId, surface, force as any, { x: 2, y: 2 }, 4))
      .toMatchObject({ ok: false, code: 'actor_has_active_claim' })
    expect(surface.entities).toHaveLength(0)

    delete swarm.board.claims['claim-1']
    expect(pool.create_body(actorId, surface, force as any, { x: 2, y: 2 }, 5).ok).toBe(true)
    expect(swarm.actors[actorId].bodyRevision).toBe(2)
  })

  it('does not reacquire a persisted body whose force no longer matches', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const surface = make_surface(1, 600)
    const originalForce = { index: 1 }
    ;(globalThis as any).game = { ...(globalThis as any).game, surfaces: { 1: surface } }

    const firstRegistry = new_actor_registry(swarm)
    const firstPool = new_standalone_actor_pool(swarm, firstRegistry)
    firstPool.register_actor(actorId, ['move'], 1)
    firstPool.create_body(actorId, surface, originalForce as any, { x: 0, y: 0 }, 2)
    surface.entities[0].force = { index: 2 }

    const secondRegistry = new_actor_registry(swarm)
    const secondPool = new_standalone_actor_pool(swarm, secondRegistry)
    secondPool.register_actor(actorId, ['move'], 3)

    expect(secondPool.resolve_body(actorId)).toBeUndefined()
    expect(swarm.actors[actorId]).toMatchObject({ state: 'missing', bodyRevision: 1 })
  })
})
