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

  it('reports standalone crafting progress from the actor queue without exposing the queue itself', () => {
    const get_crafting_queue_count = vi.fn()
      .mockReturnValueOnce(1) // baseline before begin_crafting
      .mockReturnValue(3) // baseline + two newly queued crafts
    const begin_crafting = vi.fn(() => 2)
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

    expect(begin_crafting).toHaveBeenCalledWith({ count: 2, recipe: 'iron-gear-wheel' })
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
        queued_crafts: 3,
      },
    })
  })

  it('ends a crafting task immediately if the actor cannot queue any crafts', () => {
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

    expect(manager.get_status_snapshot()).toEqual({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: undefined,
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
