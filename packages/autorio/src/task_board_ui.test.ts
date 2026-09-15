import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  sanitize_task_board_ui_snapshot,
  task_board_ui_is_open,
  toggle_task_board_ui_open,
} from './task_board_ui'

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('in-game task board UI projection', () => {
  it('keeps bounded canonical progress and status fields', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_1',
      objective: 'Climb the technology tree',
      status: 'blocked',
      blocker: 'provider recovery exhausted',
      pause_reason: '',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [
        { id: 'step_1', description: 'Find stone', status: 'completed' },
        { id: 'step_2', description: 'Mine stone', status: 'completed' },
        { id: 'step_3', description: 'Trigger steam power', status: 'blocked' },
        { id: 'step_4', description: 'Build power', status: 'pending' },
        { id: 'step_5', description: 'Start research', status: 'pending' },
      ],
    })
    expect(board).toMatchObject({
      status: 'blocked',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [{ id: 'step_1' }, { id: 'step_2' }, { id: 'step_3' }, { id: 'step_4' }, { id: 'step_5' }],
    })
  })

  it('rejects malformed snapshots instead of creating a second source of truth', () => {
    expect(sanitize_task_board_ui_snapshot(undefined)).toBeUndefined()
    expect(sanitize_task_board_ui_snapshot({ status: 'active' })).toBeUndefined()
  })

  it('keeps the task board panel closed by default and toggles per player', () => {
    expect(task_board_ui_is_open(1)).toBe(false)
    expect(task_board_ui_is_open(2)).toBe(false)

    expect(toggle_task_board_ui_open(1)).toBe(true)
    expect(task_board_ui_is_open(1)).toBe(true)
    expect(task_board_ui_is_open(2)).toBe(false)

    expect(toggle_task_board_ui_open(1)).toBe(false)
    expect(task_board_ui_is_open(1)).toBe(false)
  })

  it('does not erase Factorio GUI element types before chained add calls', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/const\s+\w+\s*:\s*any\s*=\s*player\.gui/)
    expect(source).not.toContain('const root: any')
  })
})
