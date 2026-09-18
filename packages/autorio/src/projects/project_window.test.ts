import { beforeEach, describe, expect, it } from 'vitest'
import {
  project_by_id,
  project_history,
  projects_ui_is_open,
  record_project_snapshot,
  select_project,
  selected_project_id,
  toggle_projects_ui,
} from './project_window'

declare const globalThis: any

beforeEach(() => {
  globalThis.storage = {}
  globalThis.math = Math
})

function snapshot(goal_id: string, objective: string, activity: any[] = []) {
  return {
    goal_id,
    objective,
    response: '',
    status: 'active',
    blocker: '',
    pause_reason: '',
    completed_count: 1,
    total_steps: 3,
    active_index: 1,
    steps: [
      { id: 'observe', description: 'Observe the area', status: 'completed' },
      { id: 'build', description: 'Build the line', status: 'active' },
    ],
    activity,
  }
}

describe('project activity filters', () => {
  it('filters the Projects feed with its own toggles, routed by the console click handler', async () => {
    const { readFileSync } = await import('node:fs')
    const window_source = readFileSync(new URL('./project_window.ts', import.meta.url), 'utf8')
    const console_source = readFileSync(new URL('../task_board_ui.ts', import.meta.url), 'utf8')
    expect(window_source).toContain("tags: { airi_activity_filter: flag, airi_activity_surface: 'projects' }")
    expect(window_source).toContain("activity_state.activity_filter_mask(player_index, 'projects')")
    expect(window_source).toContain('activity_state.activity_matches_mask(entry.kind as TaskBoardUiActivity[\'kind\'], mask)')
    expect(window_source).toContain('(force_activity_latest || mask_changed)')
    expect(console_source).toContain("element.tags?.airi_activity_surface === 'projects') { activity_state.toggle_activity_filter(player.index, filter_flag, 'projects'); render_debug_popout(player); return }")
  })
})

describe('project history model', () => {
  it('ignores plan-less live snapshots without a durable goal id', () => {
    expect(record_project_snapshot(snapshot('', 'thinking'), 60)).toBe(false)
    expect(project_history()).toEqual([])
  })

  it('upserts one durable project per goal and keeps newest semantic update first', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power'), 60)
    record_project_snapshot(snapshot('goal-b', 'Build green circuits'), 120)
    record_project_snapshot({ ...snapshot('goal-a', 'Build power'), status: 'completed', completed_count: 3 }, 180)

    expect(project_history().map(project => project.id)).toEqual(['goal-a', 'goal-b'])
    expect(project_by_id('goal-a')?.status).toBe('completed')
    expect(project_by_id('goal-a')?.created_tick).toBe(60)
    expect(project_by_id('goal-a')?.updated_tick).toBe(180)
  })

  it('treats an unchanged heartbeat as a no-op', () => {
    expect(record_project_snapshot(snapshot('goal-a', 'Build power'), 60)).toBe(true)
    expect(record_project_snapshot(snapshot('goal-a', 'Build power'), 120)).toBe(false)
    expect(project_by_id('goal-a')?.updated_tick).toBe(60)
  })

  it('keeps completed projects frozen until their content actually changes', () => {
    const completed = { ...snapshot('goal-a', 'Build power'), status: 'completed', completed_count: 3, active_index: 2 }
    record_project_snapshot(completed, 60)
    record_project_snapshot(snapshot('goal-b', 'Build circuits'), 120)

    expect(record_project_snapshot(completed, 180)).toBe(false)
    expect(project_by_id('goal-a')?.updated_tick).toBe(60)
    expect(project_history().map(project => project.id)).toEqual(['goal-b', 'goal-a'])

    const changed = {
      ...completed,
      activity: [{ id: 'done', kind: 'result', text: 'Power build verified', timestamp: '00:03:00' }],
    }
    expect(record_project_snapshot(changed, 240)).toBe(true)
    expect(project_by_id('goal-a')?.updated_tick).toBe(240)
    expect(project_history().map(project => project.id)).toEqual(['goal-a', 'goal-b'])
  })

  it('merges retained activity without duplicating the same event', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power', [
      { id: 'request', kind: 'observation', text: 'Louis: build power', timestamp: '00:01:00' },
    ]), 60)
    record_project_snapshot(snapshot('goal-a', 'Build power', [
      { id: 'request', kind: 'observation', text: 'Louis: build power', timestamp: '00:01:00' },
      { id: 'reply', kind: 'decision', text: 'I will build power.', timestamp: '00:01:05' },
    ]), 120)

    expect(project_by_id('goal-a')?.activity).toHaveLength(2)
  })

  it('tracks project window open state and stable per-player selection', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power'), 60)
    record_project_snapshot(snapshot('goal-b', 'Build circuits'), 120)

    expect(projects_ui_is_open(1)).toBe(false)
    expect(toggle_projects_ui(1)).toBe(true)
    expect(projects_ui_is_open(1)).toBe(true)
    expect(selected_project_id(1, 'goal-a')).toBe('goal-a')
    expect(select_project(1, 'goal-b')).toBe(true)
    expect(selected_project_id(1, 'goal-a')).toBe('goal-b')
  })
})

describe('project conversation archive', () => {
  it('stores the explicit task conversation instead of reconstructing only the recent activity tail', () => {
    const conversation = Array.from({ length: 8 }, (_, index) => ({
      id: `message_${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      sender: index % 2 === 0 ? 'TTLouis' : 'AIRI',
      text: `message ${index + 1}`,
    }))
    record_project_snapshot({ ...snapshot('goal-a', 'Build power'), conversation }, 60)
    expect(project_by_id('goal-a')?.conversation.map(message => message.text)).toEqual([
      'message 1', 'message 2', 'message 3', 'message 4',
      'message 5', 'message 6', 'message 7', 'message 8',
    ])
  })
})
