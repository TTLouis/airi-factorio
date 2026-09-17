import { beforeEach, describe, expect, it } from 'vitest'
import {
  chat_history,
  chat_message_key,
  chat_rows_diff,
  chat_should_scroll,
  chat_unseen,
  chat_view,
  record_airi_reply,
  record_chat_message,
  reset_chat_view,
  resume_chat_follow,
  set_chat_hover,
  stop_chat_follow,
} from './task_board_chat'

const store = (globalThis as any).storage as Record<string, any>

describe('task board chat history', () => {
  beforeEach(() => {
    delete store.airi_task_board_chat_history
    delete store.airi_task_board_chat_view
  })

  it('keeps a stable identity and ignores duplicate visible messages', () => {
    const message = { id: 'u1', role: 'user' as const, text: 'build power', timestamp: '00:00:01' }
    expect(chat_message_key(message)).toBe('id:u1')
    expect(record_chat_message(message)).toBe(true)
    expect(record_chat_message(message)).toBe(false)
    expect(chat_history()).toEqual([message])
  })

  it('does not turn repeated snapshot replies into repeated chat rows', () => {
    expect(record_airi_reply('g1', 'Working on it.', '00:00:02')).toBe(true)
    expect(record_airi_reply('g1', 'Working on it.', '00:00:03')).toBe(false)
    expect(record_airi_reply('g1', 'Done.', '00:00:04')).toBe(true)
    expect(chat_history().map(message => message.text)).toEqual(['Working on it.', 'Done.'])
  })

  it('bounds retained chat history', () => {
    for (let index = 0; index < 180; index++)
      record_chat_message({ id: `m${index}`, role: 'user', text: `${index}`, timestamp: '00:00:00' })
    expect(chat_history()).toHaveLength(160)
    expect(chat_history()[0].id).toBe('m20')
    expect(chat_history().at(-1)?.id).toBe('m179')
  })

  it('diffs append/trim updates without requiring a scroll-pane rebuild', () => {
    expect(chat_rows_diff(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toEqual({ drop: 0, append: 1 })
    expect(chat_rows_diff(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ drop: 1, append: 1 })
    expect(chat_rows_diff(['a', 'b'], ['x', 'y'])).toBeUndefined()
  })
})

describe('task board chat follow state', () => {
  beforeEach(() => { delete store.airi_task_board_chat_view })

  it('follows the newest message by default', () => {
    const view = chat_view(1)
    expect(view.follow).toBe(true)
    expect(chat_should_scroll(view, 1, 'a')).toBe(true)
    expect(chat_should_scroll(view, 0, 'a')).toBe(false)
  })

  it('stays where the player left it after manual scrolling and counts new messages', () => {
    const view = chat_view(1)
    expect(stop_chat_follow(1, 'b')).toBe(true)
    expect(chat_should_scroll(view, 2, 'd')).toBe(false)
    expect(chat_unseen(['a', 'b', 'c', 'd'], view.seen_key)).toEqual({ count: 2, overflow: false })
  })

  it('holds still on hover then catches up', () => {
    const view = set_chat_hover(1, true)
    expect(chat_should_scroll(view, 2, 'b')).toBe(false)
    expect(view.behind).toBe(true)
    set_chat_hover(1, false)
    expect(chat_should_scroll(view, 0, 'b')).toBe(true)
  })

  it('jumps to latest when follow is resumed', () => {
    stop_chat_follow(1, 'a')
    const view = resume_chat_follow(1, 'c')
    expect(chat_should_scroll(view, 0, 'c')).toBe(true)
  })

  it('resets a newly opened view to live mode', () => {
    stop_chat_follow(1, 'a')
    set_chat_hover(1, true)
    expect(reset_chat_view(1)).toEqual({ follow: true, hover: false, behind: false, seen_key: undefined })
  })
})
