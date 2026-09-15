import type { ControlledActor } from './actors/types'
import { describe, expect, it, vi } from 'vitest'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function actor() {
  return {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
  } as unknown as ControlledActor
}

describe('Autorio task batch receipts', () => {
  it('tracks the full submitted task batch and retains a completion receipt after returning idle', () => {
    const controlled = actor()
    const manager = new_task_manager(() => controlled)

    manager.add_task({
      type: TaskStates.WALKING_DIRECT,
      target_position: { x: 1, y: 0 },
    })
    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 60,
      requested_ticks: 60,
    })

    expect(manager.get_status_snapshot().active_batch).toMatchObject({
      batch_id: 1,
      task_count: 2,
      task_types: [TaskStates.WALKING_DIRECT, TaskStates.WAITING],
    })

    manager.reset_task_state()
    manager.next_task()
    manager.reset_task_state()
    manager.next_task()

    expect(manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      active_batch: undefined,
      last_completed_batch: {
        batch_id: 1,
        task_count: 2,
        task_types: [TaskStates.WALKING_DIRECT, TaskStates.WAITING],
      },
    })
  })

  it('retains a cancelled batch receipt with the cancellation reason', () => {
    const manager = new_task_manager(() => actor())
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60, requested_ticks: 60 })
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120, requested_ticks: 120 })

    manager.cancel_all_tasks('operation_failed')

    expect(manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      active_batch: undefined,
      last_cancelled_batch: {
        batch_id: 1,
        task_count: 2,
        task_types: [TaskStates.WAITING, TaskStates.WAITING],
        reason: 'operation_failed',
      },
    })
  })
})
