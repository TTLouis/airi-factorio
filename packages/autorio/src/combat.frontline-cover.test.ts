import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_combat_controller } from './combat'
import { new_task_manager } from './task_manager'

const LOCAL_SAFETY_WINDOW_TICKS = 120

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
})

function itemStack(name: string, count: number) {
  return { valid_for_read: true, name, count }
}

function inventory(items: any[] = []) {
  const value: any = items
  value.find_item_stack = vi.fn((name: string) => {
    const index = items.findIndex(item => item.valid_for_read && item.name === name && item.count > 0)
    return index >= 0 ? [items[index], index + 1] : [undefined, undefined]
  })
  value.remove = vi.fn(({ name, count }: { name: string, count: number }) => {
    const item = items.find(candidate => candidate.valid_for_read && candidate.name === name && candidate.count > 0)
    if (!item) return 0
    const removed = Math.min(item.count, count)
    item.count -= removed
    if (item.count <= 0) item.valid_for_read = false
    return removed
  })
  value.insert = vi.fn(({ name, count }: { name: string, count: number }) => {
    const existing = items.find(candidate => candidate.name === name)
    if (existing) {
      existing.valid_for_read = true
      existing.count += count
    }
    else {
      items.push(itemStack(name, count))
    }
    return count
  })
  return value
}

function enemy(unit_number: number, name: string, type: 'unit' | 'unit-spawner', x: number) {
  return {
    valid: true,
    name,
    type,
    unit_number,
    position: { x, y: 0 },
    health: type === 'unit' ? 30 : 350,
  } as any
}

function makeTurret(unit_number: number, position: { x: number, y: number }) {
  const ammo = inventory([])
  return {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { ...position },
    prototype: { turret_range: 18 },
    get_inventory: vi.fn(() => ammo),
    destroy: vi.fn(),
  } as any
}

function world(initialEnemies: any[], turretCount = 0) {
  let nextPathId = 100
  let miningState: any = { mining: false }
  const enemies = [...initialEnemies]
  const createdTurrets: any[] = []
  const main = inventory([
    ...(turretCount > 0 ? [itemStack('gun-turret', turretCount), itemStack('firearm-magazine', turretCount * 40)] : []),
  ])
  const guns: any = [{ valid_for_read: true }]
  const magazines: any = [{ valid_for_read: true }]
  const character: any = {
    health: 250,
    max_health: 250,
    selected_gun_index: 1,
    reach_distance: 8,
    prototype: {
      collision_box: [[-0.2, -0.2], [0.2, 0.2]],
      collision_mask: { layers: { player: true }, consider_tile_transitions: true },
    },
    can_shoot: vi.fn(() => false),
    get_inventory: vi.fn((index: unknown) => {
      if (index === (globalThis as any).defines.inventory.character_guns) return guns
      if (index === (globalThis as any).defines.inventory.character_ammo) return magazines
      return undefined
    }),
  }
  const surface: any = {
    find_entities_filtered: vi.fn((filter: any = {}) => {
      let found = enemies.filter(entity => entity.valid !== false && (entity.health === undefined || entity.health > 0))
      if (filter.type !== undefined) found = found.filter(entity => entity.type === filter.type)
      if (filter.position && typeof filter.radius === 'number') {
        found = found.filter(entity => {
          const dx = entity.position.x - filter.position.x
          const dy = entity.position.y - filter.position.y
          return Math.sqrt(dx * dx + dy * dy) <= filter.radius
        })
      }
      return found
    }),
    find_non_colliding_position: vi.fn((_name: string, position: { x: number, y: number }) => ({ ...position })),
    get_tile: vi.fn(() => ({ valid: true, collides_with: vi.fn(() => false) })),
    request_path: vi.fn(() => ++nextPathId),
    create_entity: vi.fn((args: any) => {
      const turret = makeTurret(500 + createdTurrets.length, args.position)
      createdTurrets.push(turret)
      return turret
    }),
  }
  const actor: any = {
    is_valid: true,
    character,
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    status_snapshot: () => ({ kind: 'standalone_character', actor_id: 42 }),
    set_walking_state: vi.fn(),
    set_shooting_state: vi.fn(),
    update_selected_entity: vi.fn(),
    get_main_inventory: () => main,
    get_mining_state: vi.fn(() => miningState),
    set_mining_state: vi.fn((state: any) => { miningState = state }),
    entity_build_args: () => ({ force: actor.force }),
  }
  Object.defineProperty(character, 'position', { get: () => actor.position })
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_combat_controller(get_actor, manager)
  return { actor, character, controller, createdTurrets, enemies, main, manager, surface }
}

function tick(c: ReturnType<typeof world>, count = 1) {
  ;(globalThis as any).game.tick += count
  c.controller.tick(c.actor)
}

describe('sacrificial combat support frontline', () => {
  it('places a support turret between AIRI and a static nest', () => {
    const nest = enemy(10, 'biter-spawner', 'unit-spawner', 30)
    const c = world([nest], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)

    expect(c.createdTurrets).toHaveLength(1)
    expect(c.createdTurrets[0].position.x).toBeGreaterThan(c.actor.position.x)
    expect(c.createdTurrets[0].position.x).toBeLessThan(nest.position.x)
    expect(c.createdTurrets[0].position).toEqual({ x: 12, y: 0 })
  })

  it('establishes support for ranged mobile pressure outside panic distance', () => {
    const spitter = enemy(20, 'medium-spitter', 'unit', 20)
    const c = world([spitter], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)

    expect(c.createdTurrets).toHaveLength(1)
    expect(c.createdTurrets[0].position).toEqual({ x: 6, y: 0 })
    expect(c.controller.status()).toMatchObject({
      target: { unit_number: 20, name: 'medium-spitter' },
      support_stage_started: true,
      encounter_owned_turret_count: 1,
    })
  })

  it('retreats behind the support line instead of standing in front under ranged pressure', () => {
    const spitter = enemy(30, 'medium-spitter', 'unit', 20)
    const c = world([spitter], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.createdTurrets).toHaveLength(1)

    c.actor.position = { x: 10, y: 0 }
    tick(c)

    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 10, y: 0 },
      goal: { x: 3.5, y: 0 },
      radius: 1.5,
    }))
    expect(c.controller.status()).toMatchObject({
      path: { mode: 'retreat', target_position: { x: 3.5, y: 0 } },
    })
  })

  it('re-establishes destroyed support before blindly advancing when inventory permits', () => {
    const spitter = enemy(40, 'big-spitter', 'unit', 20)
    const c = world([spitter], 2)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    expect(c.createdTurrets).toHaveLength(1)

    c.createdTurrets[0].valid = false
    tick(c)

    expect(c.createdTurrets).toHaveLength(2)
    expect(c.createdTurrets[1].position.x).toBeGreaterThan(c.actor.position.x)
    expect(c.controller.status()).toMatchObject({ encounter_owned_turret_count: 1, turrets_placed: 2 })
    expect(c.surface.request_path).not.toHaveBeenCalled()
  })

  it('preserves panic-range mobile preemption ahead of support placement', () => {
    const nest = enemy(50, 'biter-spawner', 'unit-spawner', 30)
    const c = world([nest], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.enemies.push(enemy(51, 'small-biter', 'unit', 6))
    tick(c)

    expect(c.createdTurrets).toHaveLength(0)
    expect(c.controller.status()).toMatchObject({ target: { unit_number: 51, name: 'small-biter' } })

    tick(c)
    expect(c.surface.request_path).toHaveBeenLastCalledWith(expect.objectContaining({
      start: { x: 0, y: 0 },
      goal: { x: -6, y: 0 },
      radius: 1.5,
    }))
    expect(c.controller.status()).toMatchObject({ path: { mode: 'retreat', target_position: { x: -6, y: 0 } } })
  })

  it('still recovers surviving encounter-owned support during cleanup', () => {
    const nest = enemy(60, 'biter-spawner', 'unit-spawner', 30)
    const c = world([nest], 1)

    c.controller.submit_clear(80)
    c.controller.tick(c.actor)
    c.actor.position = { x: 6, y: 0 }
    tick(c)
    expect(c.createdTurrets).toHaveLength(1)

    nest.valid = false
    tick(c)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'safety', combat_safety_goal: 'cleanup' })

    tick(c, LOCAL_SAFETY_WINDOW_TICKS)
    expect(c.controller.status()).toMatchObject({ combat_phase: 'cleanup', encounter_owned_turret_count: 1 })
    expect(c.actor.set_mining_state).toHaveBeenCalledWith(expect.objectContaining({ mining: true }))
  })
})
