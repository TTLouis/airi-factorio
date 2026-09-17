import type { LuaGuiElement, ScrollPaneGuiElement } from 'factorio:runtime'

import * as chat_state from './task_board_chat'

export const CHAT_UI = {
  section: 'airi_task_board_chat_section',
  header: 'airi_task_board_chat_header',
  live: 'airi_task_board_chat_live',
  count: 'airi_task_board_chat_count',
  empty: 'airi_task_board_chat_empty',
  scroll: 'airi_task_board_chat_scroll',
  table: 'airi_task_board_chat_table',
}

const CHAT_PADDING = 10
const CHAT_TIMESTAMP_WIDTH = 66
const CHAT_ROLE_WIDTH = 48

function add_row(table: LuaGuiElement, message: chat_state.TaskBoardChatMessage, width: number) {
  const timestamp = table.add({ type: 'label', caption: message.timestamp || '--:--:--', ignored_by_interaction: true })
  timestamp.style.minimal_width = CHAT_TIMESTAMP_WIDTH
  timestamp.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }

  const role = table.add({ type: 'label', caption: message.role === 'user' ? 'YOU' : 'AIRI', style: 'bold_label', ignored_by_interaction: true })
  role.style.minimal_width = CHAT_ROLE_WIDTH
  role.style.font_color = message.role === 'user' ? { r: 0.5, g: 0.72, b: 1 } : { r: 0.45, g: 0.85, b: 0.35 }

  const text = table.add({ type: 'label', caption: message.text, ignored_by_interaction: true })
  text.style.single_line = false
  text.style.maximal_width = width - 2 * CHAT_PADDING - CHAT_TIMESTAMP_WIDTH - CHAT_ROLE_WIDTH - 36
}

/**
 * Build a stable conversation pane once. Routine updates call refresh_chat so
 * the scroll-pane survives polling and the player's reading position is kept.
 */
export function render_chat(parent: LuaGuiElement, player_index: number, width: number, max_height: number) {
  const section = parent.add({ type: 'frame', name: CHAT_UI.section, direction: 'vertical', style: 'inside_shallow_frame' })
  section.style.width = width
  section.style.horizontally_stretchable = false

  const header = section.add({ type: 'frame', name: CHAT_UI.header, direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: 'Chat', style: 'subheader_caption_label' })
  const filler = header.add({ type: 'empty-widget' })
  filler.style.horizontally_stretchable = true
  header.add({ type: 'button', name: CHAT_UI.live, caption: 'LIVE', style: 'button' })
  const count = header.add({ type: 'label', name: CHAT_UI.count, caption: '', style: 'semibold_label' })
  count.style.left_padding = 6

  const body = section.add({ type: 'flow', direction: 'vertical' })
  body.style.padding = CHAT_PADDING
  body.style.vertical_spacing = 4
  body.style.horizontally_stretchable = true

  const empty = body.add({ type: 'label', name: CHAT_UI.empty, caption: 'No conversation yet.' })
  empty.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }

  const scroll = body.add({ type: 'scroll-pane', name: CHAT_UI.scroll, style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' })
  scroll.style.horizontally_stretchable = true
  scroll.style.maximal_height = max_height
  scroll.raise_hover_events = true

  const table = scroll.add({ type: 'table', name: CHAT_UI.table, column_count: 3, ignored_by_interaction: true, tags: { keys: [] } })
  table.style.horizontal_spacing = 8
  table.style.vertical_spacing = 4

  chat_state.reset_chat_view(player_index)
  refresh_chat(parent, player_index, width, max_height, true)
}

/** Incrementally refresh visible conversation rows without replacing the pane. */
export function refresh_chat(parent: LuaGuiElement, player_index: number, width: number, max_height: number, force_latest = false) {
  const section = parent[CHAT_UI.section]
  const header = section?.valid ? section[CHAT_UI.header] : undefined
  const body = section?.valid ? section.children[1] : undefined
  const empty = body?.valid ? body[CHAT_UI.empty] : undefined
  const scroll = body?.valid ? body[CHAT_UI.scroll] : undefined
  const table = scroll?.valid ? scroll[CHAT_UI.table] : undefined
  if (!header?.valid || !empty?.valid || !scroll?.valid || !table?.valid) return false

  const messages = chat_state.chat_history()
  const keys: string[] = []
  for (const message of messages) keys.push(chat_state.chat_message_key(message))

  empty.visible = messages.length === 0
  scroll.visible = messages.length > 0
  scroll.style.maximal_height = max_height

  const shown = (table.tags.keys ?? []) as string[]
  const diff = chat_state.chat_rows_diff(shown, keys)
  let appended = 0
  if (diff === undefined) {
    table.clear()
    for (const message of messages) add_row(table, message, width)
    appended = messages.length
  }
  else {
    const children = table.children
    for (let index = 0; index < diff.drop * 3 && index < children.length; index++) children[index].destroy()
    for (let index = messages.length - diff.append; index < messages.length; index++) add_row(table, messages[index], width)
    appended = diff.append
  }
  table.tags = { keys }

  const view = chat_state.chat_view(player_index)
  const last_key = keys.length > 0 ? keys[keys.length - 1] : undefined
  if (force_latest) chat_state.resume_chat_follow(player_index, last_key)
  if (chat_state.chat_should_scroll(view, appended, last_key)) (scroll as ScrollPaneGuiElement).scroll_to_bottom()

  const live = header[CHAT_UI.live]
  if (live?.valid) {
    const unseen = view.follow ? { count: 0, overflow: false } : chat_state.chat_unseen(keys, view.seen_key)
    live.caption = view.follow ? 'LIVE' : unseen.count > 0 ? `${unseen.count}${unseen.overflow ? '+' : ''} NEW` : 'PAUSED'
    live.tooltip = view.follow
      ? 'Following the newest conversation. Scrolling stops following.'
      : 'Conversation is staying where you left it. Click to jump to the newest message and resume following.'
  }
  const count = header[CHAT_UI.count]
  if (count?.valid) count.caption = `${messages.length} message${messages.length === 1 ? '' : 's'}`
  return true
}

export function chat_scroll(parent: LuaGuiElement) {
  const section = parent[CHAT_UI.section]
  const body = section?.valid ? section.children[1] : undefined
  const scroll = body?.valid ? body[CHAT_UI.scroll] : undefined
  return scroll?.valid ? scroll : undefined
}

export function last_shown_chat_key(parent: LuaGuiElement) {
  const scroll = chat_scroll(parent)
  const table = scroll?.valid ? scroll[CHAT_UI.table] : undefined
  const keys = table?.valid ? table.tags.keys as string[] | undefined : undefined
  return keys !== undefined && keys.length > 0 ? keys[keys.length - 1] : undefined
}

export function toggle_chat_follow(parent: LuaGuiElement, player_index: number) {
  const view = chat_state.chat_view(player_index)
  const last_key = last_shown_chat_key(parent)
  if (view.follow) chat_state.stop_chat_follow(player_index, last_key)
  else chat_state.resume_chat_follow(player_index, last_key)
  return view.follow
}

export function stop_chat_follow(parent: LuaGuiElement, player_index: number) {
  return chat_state.stop_chat_follow(player_index, last_shown_chat_key(parent))
}

export function set_chat_hover(player_index: number, hover: boolean) {
  return chat_state.set_chat_hover(player_index, hover)
}
