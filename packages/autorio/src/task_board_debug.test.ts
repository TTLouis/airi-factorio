import { beforeEach, describe, expect, it } from 'vitest'
import {
  clear_snapshot_suppression,
  follow_button_caption,
  latest_ai_reply,
  snapshot_is_suppressed,
  suppress_snapshot,
  task_conversation_messages,
} from './task_board_debug'

const store = () => (globalThis as any).storage as Record<string, any>

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

  it('projects all player and AIRI messages for the current durable goal', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: old task', timestamp: '00:00:01' },
      { kind: 'decision', text: 'Old answer', timestamp: '00:00:02' },
      { id: 'live_2', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { id: 'live_3', kind: 'observation', text: 'Tool getInventory', timestamp: '00:01:01' },
      { kind: 'decision', text: 'I will build the boiler first.', timestamp: '00:01:02' },
      { id: 'live_4', kind: 'observation', text: 'TTLouis: continue', timestamp: '00:01:30' },
      { kind: 'decision', text: 'The boiler is done; next is steam.', timestamp: '00:01:31' },
    ]
    expect(task_conversation_messages({ goal_id: 'goal_power', objective: 'build power' })).toEqual([
      { key: 'id:live_2', role: 'user', sender: 'TTLouis', text: 'build power', timestamp: '00:01:00' },
      { key: 'decision|00:01:02|I will build the boiler first.', role: 'assistant', sender: 'AIRI', text: 'I will build the boiler first.', timestamp: '00:01:02' },
      { key: 'id:live_4', role: 'user', sender: 'TTLouis', text: 'continue', timestamp: '00:01:30' },
      { key: 'decision|00:01:31|The boiler is done; next is steam.', role: 'assistant', sender: 'AIRI', text: 'The boiler is done; next is steam.', timestamp: '00:01:31' },
    ])
  })

  it('starts a new conversation cursor when the durable goal changes', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { kind: 'decision', text: 'Power done.', timestamp: '00:01:10' },
    ]
    task_conversation_messages({ goal_id: 'goal_power', objective: 'build power' })
    store().airi_task_board_activity_history.push(
      { id: 'live_2', kind: 'observation', text: 'TTLouis: mine stone', timestamp: '00:02:00' },
      { kind: 'decision', text: 'Mining stone now.', timestamp: '00:02:01' },
    )
    expect(task_conversation_messages({ goal_id: 'goal_stone', objective: 'mine stone' }).map(message => message.text)).toEqual([
      'mine stone',
      'Mining stone now.',
    ])
  })

  it('hides retained task messages when there is no current task board', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { kind: 'decision', text: 'Power done.', timestamp: '00:01:10' },
    ]
    expect(task_conversation_messages(undefined)).toEqual([])
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
