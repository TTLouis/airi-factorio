import { describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

describe('task manager status snapshot', () => {
  it('reports idle state without exposing runtime objects', () => {
    const manager = new_task_manager(() => undefined)

    expect(manager.get_status_snapshot()).toEqual({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: undefined,
    })
  })

  it('reports the current task and queued task types', () => {
    const manager = new_task_manager(() => undefined)

    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 120,
    })
    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 60,
    })

    expect(manager.get_status_snapshot()).toEqual({
      task_state: TaskStates.WAITING,
      queue_empty: false,
      queue_length: 1,
      queued_task_types: [TaskStates.WAITING],
      current_task: {
        type: TaskStates.WAITING,
        remaining_ticks: 120,
      },
    })
  })

  it('reports crafting progress supplied by the crafting controller without starting native crafting itself', () => {
    const begin_crafting = vi.fn(() => 2)
    const get_crafting_queue_count = vi.fn(() => 2)
    const actor = {
      begin_crafting,
      get_crafting_queue_count,
    } as unknown as ControlledActor
    const manager = new_task_manager(() => actor)

    manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 2,
      crafted: 0,
    })

    // The task manager owns ordering/status only. Native admission/start is
    // performed later by crafting_controller.tick(). Simulate the controller's
    // bounded progress fields to verify the status snapshot contract.
    const task = manager.player_state.parameters_craft_item
    expect(task).toBeDefined()
    if (!task) {
      throw new Error('crafting task was not activated')
    }
    task.started = 2
    task.owns_native_queue = true

    expect(begin_crafting).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toEqual({
      task_state: TaskStates.CRAFTING,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: {
        type: TaskStates.CRAFTING,
        item_name: 'iron-gear-wheel',
        count: 2,
        crafted: 0,
        started: 2,
        owns_native_queue: true,
        queued_crafts: 2,
      },
    })
  })

  it('leaves native craft admission failure to the crafting controller instead of silently ending the task', () => {
    const actor = {
      begin_crafting: vi.fn(() => 0),
      get_crafting_queue_count: vi.fn(() => 0),
    } as unknown as ControlledActor
    const manager = new_task_manager(() => actor)

    manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 2,
      crafted: 0,
    })

    expect(actor.begin_crafting).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toEqual({
      task_state: TaskStates.CRAFTING,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: {
        type: TaskStates.CRAFTING,
        item_name: 'iron-gear-wheel',
        count: 2,
        crafted: 0,
        started: undefined,
        owns_native_queue: false,
        queued_crafts: 0,
      },
    })
  })

  it('clears current and queued task status when all tasks are cancelled', () => {
    const manager = new_task_manager(() => undefined)

    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 120,
    })
    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 60,
    })
    manager.cancel_all_tasks()

    expect(manager.get_status_snapshot()).toEqual({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: undefined,
    })
  })
})
