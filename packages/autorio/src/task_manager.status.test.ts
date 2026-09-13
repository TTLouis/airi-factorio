import { describe, expect, it } from 'vitest'
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
