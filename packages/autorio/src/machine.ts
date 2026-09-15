import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { distance } from './utils/math'

const MAX_MACHINE_RADIUS = 32

type MachineCode = 'completed' | 'no_actor' | 'invalid_radius' | 'recipe_missing' | 'recipe_locked'
  | 'machine_not_found' | 'not_assembling_machine' | 'machine_not_empty' | 'set_recipe_failed'

interface MachineResult {
  accepted: boolean
  completed: boolean
  code: MachineCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  machine_name?: string
  machine_unit_number?: number
  machine_position?: { x: number, y: number }
  recipe_name?: string
  radius?: number
}

declare const storage: {
  airi_last_machine_result?: MachineResult
}

function valid_radius(radius: number) {
  return typeof radius === 'number'
    && radius === math.floor(radius)
    && radius >= 1
    && radius <= MAX_MACHINE_RADIUS
}

function machine_is_empty(entity: LuaEntity) {
  const max_index = entity.get_max_inventory_index()
  for (let index = 1; index <= max_index; index++) {
    const inventory = entity.get_inventory(index)
    if (!inventory) continue
    for (const _item of inventory.get_contents()) return false
  }
  return true
}

function nearest_machine(actor: ControlledActor, machine_name: string, radius: number) {
  const matches = actor.surface.find_entities_filtered({
    position: actor.position,
    radius,
    name: machine_name,
    force: actor.force,
  })
  let nearest: LuaEntity | undefined
  let nearest_distance = math.huge
  for (const entity of matches) {
    const candidate = distance(actor.position, entity.position)
    if (candidate < nearest_distance) {
      nearest = entity
      nearest_distance = candidate
    }
  }
  return nearest
}

function record(actor: ControlledActor | undefined, accepted: boolean, completed: boolean, code: MachineCode, details: Partial<MachineResult> = {}) {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: MachineResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    ...details,
  }
  storage.airi_last_machine_result = result
  return result
}

export function new_machine_controller(get_actor: () => ControlledActor | undefined) {
  function set_recipe(machine_name: string, recipe_name: string, radius: number = 8): [boolean, string] {
    if (!valid_radius(radius)) {
      record(get_actor(), false, false, 'invalid_radius', { machine_name, recipe_name, radius })
      return [false, 'radius must be an integer from 1 to 32']
    }

    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character) {
      record(actor, false, false, 'no_actor', { machine_name, recipe_name, radius })
      return [false, 'No controlled actor']
    }

    const recipe = actor.force.recipes[recipe_name]
    if (!recipe) {
      record(actor, false, false, 'recipe_missing', { machine_name, recipe_name, radius })
      return [false, 'Recipe does not exist for actor force']
    }
    if (!recipe.enabled) {
      record(actor, false, false, 'recipe_locked', { machine_name, recipe_name, radius })
      return [false, 'Recipe is not enabled for actor force']
    }

    const machine = nearest_machine(actor, machine_name, radius)
    if (!machine) {
      record(actor, false, false, 'machine_not_found', { machine_name, recipe_name, radius })
      return [false, 'No matching nearby machine']
    }
    if (machine.type !== 'assembling-machine') {
      record(actor, false, false, 'not_assembling_machine', {
        machine_name,
        machine_unit_number: machine.unit_number,
        machine_position: machine.position,
        recipe_name,
        radius,
      })
      return [false, 'Target is not an assembling machine']
    }

    const [current_recipe] = machine.get_recipe()
    if (current_recipe?.name === recipe_name) {
      record(actor, true, true, 'completed', {
        machine_name,
        machine_unit_number: machine.unit_number,
        machine_position: machine.position,
        recipe_name,
        radius,
      })
      return [true, 'Machine already has requested recipe']
    }

    if (!machine_is_empty(machine)) {
      record(actor, false, false, 'machine_not_empty', {
        machine_name,
        machine_unit_number: machine.unit_number,
        machine_position: machine.position,
        recipe_name,
        radius,
      })
      return [false, 'Refusing to change recipe on a non-empty machine']
    }

    machine.set_recipe(recipe_name)
    const [applied_recipe] = machine.get_recipe()
    if (applied_recipe?.name !== recipe_name) {
      record(actor, false, false, 'set_recipe_failed', {
        machine_name,
        machine_unit_number: machine.unit_number,
        machine_position: machine.position,
        recipe_name,
        radius,
      })
      return [false, 'Machine did not accept requested recipe']
    }

    record(actor, true, true, 'completed', {
      machine_name,
      machine_unit_number: machine.unit_number,
      machine_position: machine.position,
      recipe_name,
      radius,
    })
    return [true, 'Machine recipe configured']
  }

  function status() {
    return {
      actor: get_actor()?.status_snapshot(),
      last_result: storage.airi_last_machine_result,
    }
  }

  return { set_recipe, status }
}
