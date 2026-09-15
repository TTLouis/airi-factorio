import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  sanitize_task_board_ui_snapshot,
  task_board_ui_is_open,
  task_board_ui_terminate_is_armed,
  toggle_task_board_ui_open,
} from './task_board_ui'

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('in-game task board UI projection', () => {
  it('keeps bounded canonical progress, activity, and wanted-item fields', () => {
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
      activity: [
        { kind: 'observation', text: 'No boiler in inventory.' },
        { kind: 'decision', text: 'Craft a boiler before continuing.' },
        { kind: 'action', text: 'craft_item boiler x1' },
      ],
      wanted_items: [
        { name: 'boiler', count: 1, reason: 'planned craft' },
        { name: 'pipe', count: 5, reason: 'steam connection' },
      ],
    })
    expect(board).toMatchObject({
      status: 'blocked',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [{ id: 'step_1' }, { id: 'step_2' }, { id: 'step_3' }, { id: 'step_4' }, { id: 'step_5' }],
      activity: [
        { kind: 'observation', text: 'No boiler in inventory.' },
        { kind: 'decision', text: 'Craft a boiler before continuing.' },
        { kind: 'action', text: 'craft_item boiler x1' },
      ],
      wanted_items: [
        { name: 'boiler', count: 1 },
        { name: 'pipe', count: 5 },
      ],
    })
  })

  it('bounds malformed optional UI detail fields instead of trusting them', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal', objective: 'test', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Test', status: 'active' }],
      activity: [{ kind: 'private-chain-of-thought', text: 'Visible summary only' }],
      wanted_items: [{ name: 'iron-plate', count: -50, reason: 'test' }],
    })
    expect(board?.activity).toEqual([{ kind: 'note', text: 'Visible summary only' }])
    expect(board?.wanted_items).toEqual([{ name: 'iron-plate', count: 1, reason: 'test' }])
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

  it('keeps terminate confirmation scoped to one player and a short tick window', () => {
    ;(globalThis as any).storage.airi_task_board_terminate_confirm_until = { 1: 600, 2: 0 }
    expect(task_board_ui_terminate_is_armed(1, 599)).toBe(true)
    expect(task_board_ui_terminate_is_armed(1, 601)).toBe(false)
    expect(task_board_ui_terminate_is_armed(2, 1)).toBe(false)
  })

  it('does not erase Factorio GUI element types before chained add calls', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/const\s+\w+\s*:\s*any\s*=\s*player\.gui/)
    expect(source).not.toContain('const root: any')
  })

  it('only emits fixed UI control actions instead of arbitrary console commands', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain("type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow'")
    expect(source).toContain('[AIRI_UI_CONTROL]')
    expect(source).not.toContain('rcon.print')
  })
})
