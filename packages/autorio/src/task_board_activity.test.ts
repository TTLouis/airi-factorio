import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_FILTER_ALL,
  activity_filter_mask,
  activity_filter_selected,
  activity_key,
  activity_matches_mask,
  activity_rows_diff,
  activity_should_scroll,
  activity_unseen,
  activity_view,
  reset_activity_view,
  resume_activity_follow,
  set_activity_hover,
  stop_activity_follow,
  toggle_activity_filter,
} from './task_board_activity'

const store = (globalThis as any).storage as Record<string, any>

describe('recent activity filters', () => {
  beforeEach(() => {
    delete store.airi_task_board_activity_filter
    delete store.airi_task_board_activity_filters
  })

  it('shows everything until the player chooses otherwise', () => {
    expect(activity_filter_mask(1)).toBe(ACTIVITY_FILTER_ALL)
    for (const kind of ['decision', 'observation', 'note', 'action', 'result', 'blocker', 'system'] as const)
      expect(activity_matches_mask(kind, ACTIVITY_FILTER_ALL)).toBe(true)
  })

  it('lets several categories be on at once', () => {
    toggle_activity_filter(1, ACTIVITY_FILTER_ALL)
    // Start from nothing, then turn two categories on.
    toggle_activity_filter(1, 1); toggle_activity_filter(1, 2); toggle_activity_filter(1, 4); toggle_activity_filter(1, 8); toggle_activity_filter(1, 16)
    expect(activity_filter_mask(1)).toBe(0)
    toggle_activity_filter(1, 1)
    toggle_activity_filter(1, 8)
    const mask = activity_filter_mask(1)
    expect(activity_matches_mask('decision', mask)).toBe(true)
    expect(activity_matches_mask('result', mask)).toBe(true)
    expect(activity_matches_mask('observation', mask)).toBe(false)
    expect(activity_matches_mask('blocker', mask)).toBe(false)
    expect(activity_filter_selected(mask, 1)).toBe(true)
    expect(activity_filter_selected(mask, 2)).toBe(false)
    expect(activity_filter_selected(mask, ACTIVITY_FILTER_ALL)).toBe(false)

    // ALL restores every category in one click.
    toggle_activity_filter(1, ACTIVITY_FILTER_ALL)
    expect(activity_filter_mask(1)).toBe(ACTIVITY_FILTER_ALL)
    expect(activity_filter_selected(ACTIVITY_FILTER_ALL, ACTIVITY_FILTER_ALL)).toBe(true)
  })

  it('carries a single-select choice from an older save over as that one category', () => {
    store.airi_task_board_activity_filter = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 99 }
    expect(activity_filter_mask(1)).toBe(ACTIVITY_FILTER_ALL)
    expect(activity_filter_mask(2)).toBe(1)
    expect(activity_filter_mask(3)).toBe(2)
    expect(activity_filter_mask(4)).toBe(16)
    expect(activity_filter_mask(5)).toBe(ACTIVITY_FILTER_ALL)
    // Once the player touches the new filter, the new state wins.
    toggle_activity_filter(2, 4)
    expect(activity_filter_mask(2)).toBe(5)
  })

  it('keeps players independent', () => {
    toggle_activity_filter(1, 2)
    expect(activity_filter_mask(2)).toBe(ACTIVITY_FILTER_ALL)
  })
})

describe('recent activity rows', () => {
  it('identifies runtime events by id and derived ones by content', () => {
    expect(activity_key({ id: 'e1', kind: 'action', text: 'x' })).toBe('id:e1')
    expect(activity_key({ kind: 'system', text: 'Paused', timestamp: '00:01:00' })).toBe('system|00:01:00|Paused')
  })

  it('appends new rows and drops trimmed ones instead of rebuilding the feed', () => {
    expect(activity_rows_diff(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ drop: 0, append: 0 })
    expect(activity_rows_diff(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toEqual({ drop: 0, append: 1 })
    expect(activity_rows_diff(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])).toEqual({ drop: 1, append: 2 })
    expect(activity_rows_diff([], ['a', 'b'])).toEqual({ drop: 0, append: 2 })
  })

  it('rebuilds only when the rows on screen no longer line up with the feed', () => {
    // A filter change, or more new events than the feed holds.
    expect(activity_rows_diff(['a', 'c'], ['a', 'b', 'c'])).toBeUndefined()
    expect(activity_rows_diff(['a', 'b'], ['x', 'y'])).toBeUndefined()
    expect(activity_rows_diff(['a', 'b'], [])).toBeUndefined()
  })

  it('counts what arrived after the last event the player saw', () => {
    expect(activity_unseen(['a', 'b', 'c'], 'c')).toEqual({ count: 0, overflow: false })
    expect(activity_unseen(['a', 'b', 'c', 'd', 'e'], 'c')).toEqual({ count: 2, overflow: false })
    // Stopped while the feed was empty: everything shown is new.
    expect(activity_unseen(['a', 'b'], undefined)).toEqual({ count: 2, overflow: false })
    // The last seen event was trimmed away, so there may be more than shown.
    expect(activity_unseen(['x', 'y'], 'gone')).toEqual({ count: 2, overflow: true })
  })
})

describe('recent activity follow', () => {
  beforeEach(() => { delete store.airi_task_board_activity_view })

  it('follows by default and scrolls to each new event', () => {
    const view = activity_view(7)
    expect(view.follow).toBe(true)
    expect(activity_should_scroll(view, 1, 'a')).toBe(true)
    // A refresh with nothing new never moves the feed.
    expect(activity_should_scroll(view, 0, 'a')).toBe(false)
  })

  it('stops following as soon as the player scrolls, and stays put after that', () => {
    const view = activity_view(7)
    expect(stop_activity_follow(7, 'b')).toBe(true)
    expect(stop_activity_follow(7, 'c')).toBe(false)
    expect(view.seen_key).toBe('b')
    expect(activity_should_scroll(view, 3, 'e')).toBe(false)
    expect(activity_unseen(['a', 'b', 'c', 'd', 'e'], view.seen_key)).toEqual({ count: 3, overflow: false })
  })

  it('holds still while the cursor is on the feed and catches up once it leaves', () => {
    const view = set_activity_hover(7, true)
    expect(activity_should_scroll(view, 2, 'b')).toBe(false)
    expect(view.behind).toBe(true)
    set_activity_hover(7, false)
    expect(activity_should_scroll(view, 0, 'b')).toBe(true)
    expect(activity_should_scroll(view, 0, 'b')).toBe(false)
  })

  it('jumps back to the newest event when follow is turned back on', () => {
    stop_activity_follow(7, 'a')
    const view = resume_activity_follow(7, 'c')
    expect(view.follow).toBe(true)
    expect(activity_should_scroll(view, 0, 'c')).toBe(true)
  })

  it('starts a freshly opened console following again', () => {
    stop_activity_follow(7, 'a')
    set_activity_hover(7, true)
    const view = reset_activity_view(7)
    expect(view).toEqual({ follow: true, hover: false, behind: false, seen_key: undefined })
  })
})
