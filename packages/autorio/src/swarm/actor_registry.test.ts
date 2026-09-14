import type { ControlledActor } from '../actors/types'
import { describe, expect, it } from 'vitest'
import { allocate_logical_actor_id, create_agent } from './agents'
import { new_actor_registry } from './actor_registry'
import { create_empty_swarm_storage } from './storage'

function fake_actor(physicalActorId: number, kind = 'standalone-character', forceIndex = 1, valid = true, surfaceIndex = 1): ControlledActor {
  const status = {
    kind,
    valid,
    name: `${kind}-${physicalActorId}`,
    position: { x: 0, y: 0 },
    has_character: true,
    actor_id: physicalActorId,
  }
  return {
    is_valid: valid,
    character: valid ? {} as any : undefined,
    surface: { index: surfaceIndex } as any,
    force: { index: forceIndex } as any,
    position: { x: 0, y: 0 },
    get_main_inventory: () => undefined,
    update_selected_entity: () => {},
    get_mining_state: () => ({ mining: false } as any),
    set_mining_state: () => {},
    set_walking_state: () => {},
    set_shooting_state: () => {},
    get_craftable_count: () => 0,
    begin_crafting: () => 0,
    cancel_crafting: () => {},
    get_crafting_queue: () => [],
    get_crafting_queue_count: () => 0,
    owns_player_index: () => false,
    entity_build_args: () => ({ force: { index: forceIndex } as any }),
    status_snapshot: () => status,
  }
}

describe('logical actor registry', () => {
  it('rejects registration for an unknown logical actor', () => {
    const swarm = create_empty_swarm_storage()
    const registry = new_actor_registry(swarm)
    expect(registry.register_actor('actor-404', { resolve: () => fake_actor(1), capabilities: ['move'] }, 10))
      .toMatchObject({ ok: false, code: 'unknown_actor' })
  })

  it('binds physical identity without replacing the logical actor id', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const registry = new_actor_registry(swarm)

    expect(registry.register_actor(actorId, { resolve: () => fake_actor(101), capabilities: ['move', 'mine'] }, 20).ok).toBe(true)
    expect(registry.runtime_snapshot(actorId, 21)).toMatchObject({
      actorId,
      agentId: agent.id,
      registered: true,
      available: true,
      state: 'online',
      bodyRevision: 1,
      physical: { physicalActorId: 101, kind: 'standalone-character', forceIndex: 1, surfaceIndex: 1 },
    })
    expect(registry.admission_snapshot(actorId, 21)).toEqual({
      actorId,
      agentId: agent.id,
      available: true,
      capabilities: ['move', 'mine'],
      bodyRevision: 1,
    })
  })

  it('keeps body revision stable across registry recreation for the same body', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    const actor = fake_actor(55)

    const first = new_actor_registry(swarm)
    first.register_actor(actorId, { resolve: () => actor, capabilities: ['move'] }, 30)
    expect(swarm.actors[actorId].bodyRevision).toBe(1)

    const second = new_actor_registry(swarm)
    second.register_actor(actorId, { resolve: () => actor, capabilities: ['move'] }, 40)
    expect(swarm.actors[actorId].bodyRevision).toBe(1)
    expect(swarm.actors[actorId].physical?.physicalActorId).toBe(55)
  })

  it('does not bump generation for a temporary miss but does for replacement', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    let current: ControlledActor | undefined = fake_actor(7)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => current, capabilities: ['move'] }, 1)

    current = undefined
    registry.reconcile_actor(actorId, 2)
    expect(swarm.actors[actorId]).toMatchObject({ state: 'missing', bodyRevision: 1, missingSinceTick: 2 })

    current = fake_actor(7)
    registry.reconcile_actor(actorId, 3)
    expect(swarm.actors[actorId]).toMatchObject({ state: 'online', bodyRevision: 1 })

    current = fake_actor(8)
    registry.reconcile_actor(actorId, 4)
    expect(swarm.actors[actorId]).toMatchObject({
      state: 'online',
      bodyRevision: 2,
      physical: { physicalActorId: 8, surfaceIndex: 1 },
    })
  })

  it('treats moving the logical actor to another surface as a new body generation', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    create_agent(swarm, actorId)
    let current: ControlledActor | undefined = fake_actor(9, 'standalone-character', 1, true, 1)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => current, capabilities: ['move'] }, 1)

    current = fake_actor(9, 'standalone-character', 1, true, 2)
    registry.reconcile_actor(actorId, 2)

    expect(swarm.actors[actorId]).toMatchObject({
      bodyRevision: 2,
      physical: { physicalActorId: 9, surfaceIndex: 2 },
    })
  })

  it('makes admission unavailable while the bound agent is already committed', () => {
    const swarm = create_empty_swarm_storage()
    const actorId = allocate_logical_actor_id(swarm)
    const agent = create_agent(swarm, actorId)
    const registry = new_actor_registry(swarm)
    registry.register_actor(actorId, { resolve: () => fake_actor(11), capabilities: ['move'] }, 1)

    agent.state = 'working'
    agent.currentWorkId = 'work-1'
    expect(registry.admission_snapshot(actorId, 2)).toMatchObject({ available: false, bodyRevision: 1 })
  })

  it('tracks multiple logical actors independently', () => {
    const swarm = create_empty_swarm_storage()
    const firstId = allocate_logical_actor_id(swarm)
    const secondId = allocate_logical_actor_id(swarm)
    create_agent(swarm, firstId)
    create_agent(swarm, secondId)
    const registry = new_actor_registry(swarm)

    registry.register_actor(firstId, { resolve: () => fake_actor(101), capabilities: ['move'] }, 1)
    registry.register_actor(secondId, { resolve: () => fake_actor(202, 'standalone-character', 1, true, 2), capabilities: ['mine'] }, 1)

    expect(registry.list_admission_snapshots(2)).toEqual([
      expect.objectContaining({ actorId: firstId, bodyRevision: 1, capabilities: ['move'] }),
      expect.objectContaining({ actorId: secondId, bodyRevision: 1, capabilities: ['mine'] }),
    ])
    expect(registry.runtime_snapshot(secondId, 2)?.physical?.surfaceIndex).toBe(2)
  })
})
