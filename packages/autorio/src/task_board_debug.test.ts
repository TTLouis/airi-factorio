import { beforeEach, describe, expect, it } from 'vitest'
import {
  clear_snapshot_suppression,
  conversation_activity_keys,
  debug_activity_view,
  follow_button_caption,
  latest_ai_reply,
  snapshot_is_suppressed,
  suppress_snapshot,
  task_conversation_messages,
  toggle_debug_activity_follow,
  reset_task_conversation,
  sanitize_debug_snapshot,
} from './task_board_debug'

const store = () => (globalThis as any).storage as Record<string, any>

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('task board debug and UI freshness helpers', () => {
  it('sanitizes Jev decision diagnostics independently from planner diagnostics', () => {
    const debug = sanitize_debug_snapshot({
      provider_model: 'deepseek-chat',
      input_units: 100000,
      decision_provider: 'TypeSafe',
      decision_model: 'jev-latest',
      decision_shadow_intent: 'status_query',
      decision_active_intent: 'status_query',
      decision_confidence_percent: 109,
      decision_queue_conflict_percent: 17,
      decision_latency_ms: 84,
      decision_input_units: 120,
      decision_output_units: 20,
      decision_cost_micro_usd: 5,
      decision_error: '',
    })

    expect(debug.provider_model).toBe('deepseek-chat')
    expect(debug.input_units).toBe(100000)
    expect(debug.decision_provider).toBe('TypeSafe')
    expect(debug.decision_model).toBe('jev-latest')
    expect(debug.decision_shadow_intent).toBe('status_query')
    expect(debug.decision_active_intent).toBe('status_query')
    expect(debug.decision_confidence_percent).toBe(100)
    expect(debug.decision_queue_conflict_percent).toBe(17)
    expect(debug.decision_latency_ms).toBe(84)
    expect(debug.decision_input_units).toBe(120)
    expect(debug.decision_output_units).toBe(20)
    expect(debug.decision_cost_micro_usd).toBe(5)
  })

  it('uses concise follow captions', () => {
    expect(follow_button_caption(false)).toBe('FOLLOW')
    expect(follow_button_caption(true)).toBe('FOLLOWING')
  })

  it('keeps Debug execution-feed follow state independent and explicitly pausable', () => {
    expect(debug_activity_view(7)).toEqual({ follow: true, behind: false })
    expect(toggle_debug_activity_follow(7)).toMatchObject({ follow: false, behind: false })
    expect(toggle_debug_activity_follow(7)).toMatchObject({ follow: true, behind: true })
  })

  it('shows the explicit AIRI reply or falls back to the newest decision activity', () => {
    expect(latest_ai_reply({ response: 'Direct answer', activity: [{ kind: 'decision', text: 'Older answer' }] })).toBe('Direct answer')
    expect(latest_ai_reply({ activity: [
      { kind: 'decision', text: 'First answer' },
      { kind: 'observation', text: 'Observed something' },
      { kind: 'decision', text: 'Newest answer' },
    ] })).toBe('Newest answer')
    expect(latest_ai_reply({ activity: [
      { kind: 'system', text: 'Jev shadow: status_query · 91%' },
    ] })).toBe('')
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

  it('names the activity rows the conversation already shows so the feed can skip them', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { id: 'live_2', kind: 'observation', text: 'Tool getInventory', timestamp: '00:01:01' },
      { kind: 'decision', text: 'Boiler first.', timestamp: '00:01:02' },
      { kind: 'result', text: 'Autorio batch 1 completed: 1 task(s)', timestamp: '00:01:10' },
    ]
    expect(conversation_activity_keys({ goal_id: 'goal_power', objective: 'build power' })).toEqual({
      'id:live_1': true,
      'decision|00:01:02|Boiler first.': true,
    })
    expect(conversation_activity_keys(undefined)).toEqual({})
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

describe('current task conversation regression', () => {
  it('shows more than four visible user/assistant messages from the explicit task conversation', () => {
    const conversation = [
      { id: '1', role: 'user', sender: 'TTLouis', text: 'one' },
      { id: '2', role: 'assistant', sender: 'AIRI', text: 'two' },
      { id: '3', role: 'user', sender: 'TTLouis', text: 'three' },
      { id: '4', role: 'assistant', sender: 'AIRI', text: 'four' },
      { id: '5', role: 'user', sender: 'TTLouis', text: 'five' },
      { id: '6', role: 'assistant', sender: 'AIRI', text: 'six' },
      { id: '7', role: 'user', sender: 'TTLouis', text: 'seven' },
      { id: '8', role: 'assistant', sender: 'AIRI', text: 'eight' },
    ]
    expect(task_conversation_messages({ goal_id: 'goal-a', conversation_id: 'task-a', conversation }).map(message => message.text)).toEqual(
      ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
    )
  })

  it('New Task reset rebinds the view to a fresh conversation generation', () => {
    const old = { goal_id: 'goal-a', conversation_id: 'task-a', conversation: [
      { id: '1', role: 'user', sender: 'TTLouis', text: 'old request' },
      { id: '2', role: 'assistant', sender: 'AIRI', text: 'old answer' },
    ] }
    expect(task_conversation_messages(old)).toHaveLength(2)
    reset_task_conversation()
    const fresh = { goal_id: 'goal-b', conversation_id: 'task-b', conversation: [
      { id: '1', role: 'user', sender: 'TTLouis', text: 'fresh request' },
    ] }
    expect(task_conversation_messages(fresh).map(message => message.text)).toEqual(['fresh request'])
    expect(store().airi_task_board_conversation_id).toBe('task-b')
  })

  it('does not resurrect old activity-history messages after a fresh conversation sync', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_old_1', kind: 'observation', text: 'TTLouis: old request', timestamp: '00:00:01' },
      { kind: 'decision', text: 'old answer', timestamp: '00:00:02' },
    ]
    reset_task_conversation()
    const fresh = { goal_id: 'goal-b', conversation_id: 'task-b', conversation: [
      { id: 'new-1', role: 'user', sender: 'TTLouis', text: 'fresh request' },
      { id: 'new-2', role: 'assistant', sender: 'AIRI', text: 'fresh answer' },
    ] }
    expect(task_conversation_messages(fresh).map(message => message.text)).toEqual(['fresh request', 'fresh answer'])
    expect(task_conversation_messages(fresh).map(message => message.text)).toEqual(['fresh request', 'fresh answer'])
  })
})
