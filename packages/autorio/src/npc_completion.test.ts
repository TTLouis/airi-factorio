import { beforeEach, describe, expect, it, vi } from 'vitest'
import { set_actor_mode } from './actors/actor_controller'
import { task_manager } from './control'
import { get_handler } from './test-event-registry'
import { TaskStates } from './types'

beforeEach(() => {
  task_manager.cancel_all_tasks()
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).storage.airi_actor_mode = 'player'
  ;(globalThis as any).storage.standalone_character_unit_number = undefined
  ;(globalThis as any).serpent = {
    line: (value: unknown) => JSON.stringify(value),
    block: (value: unknown) => JSON.stringify(value),
  }
})

function configureNpcWorld(resource?: Record<string, any>) {
  const force: Record<string, any> = {
    name: 'player',
    technologies: {},
    recipes: {},
    current_research: undefined,
    research_progress: 0,
    get_spawn_position: () => ({ x: 0, y: 0 }),
  }

  let character_created = false
  const character: Record<string, any> = {
    valid: true,
    unit_number: 42,
    name: 'character',
    type: 'character',
    position: { x: 0, y: 0 },
    force,
    mining_state: { mining: false, position: { x: 0, y: 0 } },
    walking_state: { walking: false, direction: 'north' },
    shooting_state: { state: 'not_shooting', position: { x: 0, y: 0 } },
    crafting_queue: [],
    update_selected_entity: vi.fn(),
    get_main_inventory: vi.fn(() => ({
      get_item_count: vi.fn(() => 0),
    })),
  }

  character.begin_crafting = vi.fn(({ count, recipe }: { count: number, recipe: string }) => {
    character.crafting_queue = [{ index: 1, recipe, count, prerequisite: false }]
    return count
  })

  const surface: Record<string, any> = {
    name: 'nauvis',
    daytime: 0,
    wind_speed: 0,
    wind_orientation: 0,
    find_non_colliding_position: vi.fn(() => ({ x: 0, y: 0 })),
    create_entity: vi.fn(({ name }: { name: string }) => {
      if (name !== 'character') {
        return undefined
      }
      character_created = true
      return character
    }),
    find_entities_filtered: vi.fn((filter: Record<string, any>) => {
      if (filter.force === 'enemy') {
        return []
      }
      if (filter.name === 'character') {
        return character_created ? [character] : []
      }
      if (resource && filter.name === resource.name && resource.valid !== false) {
        return [resource]
      }
      return []
    }),
  }

  character.surface = surface
  if (resource) {
    resource.surface = surface
  }

  ;(globalThis as any).game.surfaces[1] = surface
  ;(globalThis as any).game.forces = { player: force }

  set_actor_mode('npc')
  return { character, force, surface }
}

describe('standalone NPC completion polling', () => {
  it('counts real resource depletion and keeps mining across multiple cycles without LuaPlayer events', () => {
    const resource: Record<string, any> = {
      valid: true,
      name: 'iron-ore',
      type: 'resource',
      position: { x: 1, y: 0 },
      amount: 10,
    }
    const { character } = configureNpcWorld(resource)
    const on_tick = get_handler('on_tick')

    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name: 'iron-ore',
      count: 2,
    })

    on_tick({})
    expect(character.update_selected_entity).toHaveBeenCalledWith(resource.position)
    expect(character.mining_state.mining).toBe(true)
    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(2)

    const selections_after_start = character.update_selected_entity.mock.calls.length
    resource.amount = 9
    on_tick({})
    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(1)
    expect(task_manager.player_state.task_state).toBe(TaskStates.MINING)
    expect(character.mining_state.mining).toBe(true)
    expect(character.update_selected_entity.mock.calls.length).toBeGreaterThan(selections_after_start)

    resource.amount = 8
    on_tick({})
    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(character.mining_state.mining).toBe(false)
  })

  it('finishes standalone crafting when its own crafting queue drains', () => {
    const { character } = configureNpcWorld()
    const on_tick = get_handler('on_tick')

    task_manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 2,
      crafted: 0,
    })

    expect(character.begin_crafting).toHaveBeenCalledWith({ count: 2, recipe: 'iron-gear-wheel' })
    expect(task_manager.player_state.task_state).toBe(TaskStates.CRAFTING)

    on_tick({})
    expect(task_manager.player_state.task_state).toBe(TaskStates.CRAFTING)

    character.crafting_queue = []
    on_tick({})
    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })
})

describe('connected player completion compatibility', () => {
  it('finishes a one-count mining task on the final player mining event', () => {
    const player: Record<string, any> = {
      valid: true,
      index: 1,
      name: 'AIRI',
      character: {},
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => [] },
      force: {},
      mining_state: { mining: true, position: { x: 1, y: 0 } },
      crafting_queue: [],
      begin_crafting: vi.fn(() => 0),
    }
    ;(globalThis as any).game.connected_players = [player]
    set_actor_mode('player')

    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name: 'iron-ore',
      count: 1,
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 1 })

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(player.mining_state.mining).toBe(false)
  })
})
