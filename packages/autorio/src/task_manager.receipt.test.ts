import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
})

describe('Autorio task batch receipts', () => {
  it('prints one start receipt, tracks the full batch, and retains the completion receipt after returning idle', () => {
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

    expect((globalThis as any).game.print).toHaveBeenCalledTimes(1)
    expect((globalThis as any).game.print).toHaveBeenCalledWith(
      '[AUTORIO] Operation batch started: batch=1, first_task=walking_direct, tick=100',
    )
    expect(manager.get_status_snapshot().active_batch).toMatchObject({
      batch_id: 1,
      task_count: 2,
      task_types: [TaskStates.WALKING_DIRECT, TaskStates.WAITING],
    })

    manager.reset_task_state()
    manager.next_task()
    manager.reset_task_state()
    ;(globalThis as any).game.tick = 160
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
    expect((globalThis as any).game.print).toHaveBeenCalledWith(
      '[AUTORIO] All operations completed: batch=1, task_count=2, tasks=walking_direct,waiting, tick=160',
    )
  })

  it('prints and retains a cancelled batch receipt with the cancellation reason', () => {
    const manager = new_task_manager(() => actor())
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60, requested_ticks: 60 })
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120, requested_ticks: 120 })

    ;(globalThis as any).game.tick = 130
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
    expect((globalThis as any).game.print).toHaveBeenCalledWith(
      '[AUTORIO] Operation batch cancelled: batch=1, task_count=2, tasks=waiting,waiting, tick=130, reason=operation_failed',
    )
  })

  it('prints actor-loss cancellation immediately even if no model turn is available to explain it', () => {
    const manager = new_task_manager(() => actor())
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60, requested_ticks: 60 })

    ;(globalThis as any).game.tick = 145
    manager.discard_all_tasks_after_actor_loss()

    expect(manager.get_status_snapshot().last_cancelled_batch).toMatchObject({ reason: 'actor_loss' })
    expect((globalThis as any).game.print).toHaveBeenCalledWith(
      '[AUTORIO] Operation batch cancelled: batch=1, task_count=1, tasks=waiting, tick=145, reason=actor_loss',
    )
  })
})
