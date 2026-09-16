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

describe('project history model', () => {
  it('ignores plan-less live snapshots without a durable goal id', () => {
    expect(record_project_snapshot(snapshot('', 'thinking'), 60)).toBe(false)
    expect(project_history()).toEqual([])
  })

  it('upserts one durable project per goal and keeps newest first', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power'), 60)
    record_project_snapshot(snapshot('goal-b', 'Build green circuits'), 120)
    record_project_snapshot({ ...snapshot('goal-a', 'Build power'), status: 'completed', completed_count: 3 }, 180)

    expect(project_history().map(project => project.id)).toEqual(['goal-a', 'goal-b'])
    expect(project_by_id('goal-a')?.status).toBe('completed')
    expect(project_by_id('goal-a')?.created_tick).toBe(60)
    expect(project_by_id('goal-a')?.updated_tick).toBe(180)
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
