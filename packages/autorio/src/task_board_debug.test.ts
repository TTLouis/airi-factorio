import { beforeEach, describe, expect, it } from 'vitest'
import {
  clear_snapshot_suppression,
  follow_button_caption,
  latest_ai_reply,
  snapshot_is_suppressed,
  suppress_snapshot,
} from './task_board_debug'

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('task board debug and UI freshness helpers', () => {
  it('uses concise follow captions', () => {
    expect(follow_button_caption(false)).toBe('FOLLOW')
    expect(follow_button_caption(true)).toBe('FOLLOWING')
  })

  it('shows the explicit AIRI reply or falls back to the newest decision activity', () => {
    expect(latest_ai_reply({ response: 'Direct answer', activity: [{ kind: 'decision', text: 'Older answer' }] })).toBe('Direct answer')
    expect(latest_ai_reply({ activity: [
      { kind: 'decision', text: 'First answer' },
      { kind: 'observation', text: 'Observed something' },
      { kind: 'decision', text: 'Newest answer' },
    ] })).toBe('Newest answer')
  })

  it('rejects a delayed projection of a cleared goal but accepts a genuinely new goal', () => {
    suppress_snapshot({ goal_id: 'goal_old', objective: 'Build green circuits' })
    expect(snapshot_is_suppressed({ goal_id: 'goal_old', objective: 'Build green circuits' })).toBe(true)
    expect(snapshot_is_suppressed({ goal_id: '', objective: 'Build green circuits' })).toBe(true)
    expect(snapshot_is_suppressed({ goal_id: 'goal_new', objective: 'Build green circuits' })).toBe(false)
    expect(snapshot_is_suppressed({ goal_id: '', objective: 'Build red circuits' })).toBe(false)
    clear_snapshot_suppression()
    expect(snapshot_is_suppressed({ goal_id: '', objective: 'Build green circuits' })).toBe(false)
  })
})
