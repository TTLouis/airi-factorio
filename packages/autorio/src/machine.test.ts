import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_machine_controller } from './machine'

function fixture({ occupied = false, machineType = 'assembling-machine' } = {}) {
  let selectedRecipe: { name: string } | undefined
  const inventory = {
    get_contents: () => occupied ? [{ name: 'iron-plate', quality: 'normal', count: 1 }] : [],
  }
  const machine: any = {
    valid: true,
    name: 'assembling-machine-1',
    type: machineType,
    unit_number: 77,
    position: { x: 4, y: 0 },
    get_max_inventory_index: () => 1,
    get_inventory: () => inventory,
    get_recipe: vi.fn(() => [selectedRecipe, undefined]),
    set_recipe: vi.fn((name: string) => {
      selectedRecipe = { name }
      return []
    }),
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    surface: {
      find_entities_filtered: vi.fn(() => [machine]),
    },
    force: {
      index: 1,
      recipes: {
        'iron-gear-wheel': { name: 'iron-gear-wheel', enabled: true },
        'advanced-circuit': { name: 'advanced-circuit', enabled: false },
      },
    },
    status_snapshot: () => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const controller = new_machine_controller(() => actor)
  return { actor, machine, controller, set selectedRecipe(value: { name: string } | undefined) { selectedRecipe = value } }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
})

describe('safe assembler recipe controller', () => {
  it('configures the nearest empty assembling machine and verifies the applied recipe', () => {
    const f = fixture()

    expect(f.controller.set_recipe('assembling-machine-1', 'iron-gear-wheel', 8)).toEqual([true, 'Machine recipe configured'])
    expect(f.machine.set_recipe).toHaveBeenCalledWith('iron-gear-wheel')
    expect(f.machine.get_recipe).toHaveBeenCalledTimes(2)
    expect(f.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      machine_name: 'assembling-machine-1',
      machine_unit_number: 77,
      recipe_name: 'iron-gear-wheel',
      radius: 8,
    })
  })

  it('is idempotent when the machine already has the requested recipe', () => {
    const f = fixture()
    f.selectedRecipe = { name: 'iron-gear-wheel' }

    expect(f.controller.set_recipe('assembling-machine-1', 'iron-gear-wheel')).toEqual([true, 'Machine already has requested recipe'])
    expect(f.machine.set_recipe).not.toHaveBeenCalled()
  })

  it('refuses to change a non-empty machine so recipe changes cannot discard ingredients', () => {
    const f = fixture({ occupied: true })

    expect(f.controller.set_recipe('assembling-machine-1', 'iron-gear-wheel')).toEqual([false, 'Refusing to change recipe on a non-empty machine'])
    expect(f.machine.set_recipe).not.toHaveBeenCalled()
    expect(f.controller.status().last_result).toMatchObject({ code: 'machine_not_empty', accepted: false })
  })

  it('rejects locked recipes and non-assembling targets before mutation', () => {
    const locked = fixture()
    expect(locked.controller.set_recipe('assembling-machine-1', 'advanced-circuit')).toEqual([false, 'Recipe is not enabled for actor force'])
    expect(locked.machine.set_recipe).not.toHaveBeenCalled()

    const furnace = fixture({ machineType: 'furnace' })
    expect(furnace.controller.set_recipe('assembling-machine-1', 'iron-gear-wheel')).toEqual([false, 'Target is not an assembling machine'])
    expect(furnace.machine.set_recipe).not.toHaveBeenCalled()
  })

  it('bounds local search radius and reports missing recipes', () => {
    const f = fixture()
    expect(f.controller.set_recipe('assembling-machine-1', 'iron-gear-wheel', 33)[0]).toBe(false)
    expect(f.controller.status().last_result?.code).toBe('invalid_radius')
    expect(f.controller.set_recipe('assembling-machine-1', 'does-not-exist')[0]).toBe(false)
    expect(f.controller.status().last_result?.code).toBe('recipe_missing')
  })
})
