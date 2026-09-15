import { beforeEach, describe, expect, it } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_crafting_controller } from './crafting'
import { new_actor_scoped_combat_controller } from './swarm/combat_adapter'
import { new_actor_scoped_navigation_controller } from './swarm/navigation_adapter'
import { new_task_manager } from './task_manager'

function isolated_manager() {
  return new_task_manager(() => undefined, { bindGlobalActorLifecycle: false })
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 42
})

describe('actor-scoped controller persistence', () => {
  it('isolates basic operation receipts and operation ids by logical actor key', () => {
    const first = new_basic_operation_controller(() => undefined, isolated_manager(), { persistenceKey: 'actor-1' })
    const second = new_basic_operation_controller(() => undefined, isolated_manager(), { persistenceKey: 'actor-2' })

    first.submit_wait(0)
    second.submit_mining('iron-ore', 0)

    expect(first.status()).toMatchObject({ last_result: { code: 'invalid_ticks' }, next_operation_id: 0 })
    expect(second.status()).toMatchObject({ last_result: { code: 'invalid_count' }, next_operation_id: 0 })
    expect((globalThis as any).storage.airi_last_basic_operation_result).toBeUndefined()
  })

  it('isolates navigation receipts by logical actor key without overwriting the singleton receipt', () => {
    const first = new_actor_scoped_navigation_controller('actor-1', () => undefined, isolated_manager())
    const second = new_actor_scoped_navigation_controller('actor-2', () => undefined, isolated_manager())

    first.submit('', 10)
    second.submit('iron-ore', 0)

    expect(first.status().last_result).toMatchObject({ code: 'invalid_entity_name' })
    expect(second.status().last_result).toMatchObject({ code: 'invalid_radius' })
    expect((globalThis as any).storage.airi_last_navigation_result).toBeUndefined()
  })

  it('isolates crafting receipts and ownership slots by logical actor key', () => {
    const first = new_crafting_controller(() => undefined, isolated_manager(), { persistenceKey: 'actor-1' })
    const second = new_crafting_controller(() => undefined, isolated_manager(), { persistenceKey: 'actor-2' })

    first.submit('iron-gear-wheel', 0)
    second.submit('iron-gear-wheel', 1)

    expect(first.status().last_result).toMatchObject({ code: 'invalid_count' })
    expect(second.status().last_result).toMatchObject({ code: 'no_actor' })
    expect(first.status().persisted_owner).toBeUndefined()
    expect(second.status().persisted_owner).toBeUndefined()
    expect((globalThis as any).storage.airi_last_crafting_result).toBeUndefined()
    expect((globalThis as any).storage.airi_owned_crafting).toBeUndefined()
  })

  it('isolates combat receipts by logical actor key without overwriting the singleton receipt', () => {
    const first = new_actor_scoped_combat_controller('actor-1', () => undefined, isolated_manager())
    const second = new_actor_scoped_combat_controller('actor-2', () => undefined, isolated_manager())

    first.submit(0)
    second.submit(50)

    expect(first.status().last_result).toMatchObject({ code: 'invalid_radius' })
    expect(second.status().last_result).toMatchObject({ code: 'no_actor' })
    expect((globalThis as any).storage.airi_last_combat_result).toBeUndefined()
  })
})
