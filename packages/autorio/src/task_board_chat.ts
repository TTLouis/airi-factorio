export type TaskBoardChatRole = 'user' | 'airi'

export interface TaskBoardChatMessage {
  id: string
  role: TaskBoardChatRole
  text: string
  timestamp: string
}

export interface TaskBoardChatView {
  follow: boolean
  hover: boolean
  behind: boolean
  seen_key?: string
}

const CHAT_HISTORY_LIMIT = 160

declare const storage: {
  airi_task_board_chat_history?: TaskBoardChatMessage[]
  airi_task_board_chat_view?: Record<number, TaskBoardChatView>
}

function ensure_history() {
  if (storage.airi_task_board_chat_history === undefined) storage.airi_task_board_chat_history = []
  return storage.airi_task_board_chat_history
}

function ensure_views() {
  if (storage.airi_task_board_chat_view === undefined) storage.airi_task_board_chat_view = {}
  return storage.airi_task_board_chat_view
}

export function chat_message_key(message: TaskBoardChatMessage) {
  return message.id.length > 0 ? `id:${message.id}` : `${message.role}|${message.timestamp}|${message.text}`
}

export function chat_history() {
  return storage.airi_task_board_chat_history ?? []
}

/**
 * Append one durable visible conversation item. Callers own identity creation;
 * duplicate IDs/content are ignored so a repeated heartbeat cannot create a
 * fake second message. The history is bounded independently from Activity.
 */
export function record_chat_message(message: TaskBoardChatMessage) {
  const history = ensure_history()
  const key = chat_message_key(message)
  for (let index = history.length - 1; index >= 0; index--) {
    if (chat_message_key(history[index]) === key) return false
  }
  history.push(message)
  while (history.length > CHAT_HISTORY_LIMIT) history.shift()
  return true
}

/**
 * Record the latest model-visible reply only when it changed. Snapshot polling
 * can repeat the same response many times; chat should not treat that as new.
 */
export function record_airi_reply(goal_id: string, response: string, timestamp: string) {
  if (response.length === 0) return false
  const history = chat_history()
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message.role !== 'airi') continue
    if (message.text === response) return false
    break
  }
  return record_chat_message({
    id: `airi:${goal_id}:${timestamp}:${response}`,
    role: 'airi',
    text: response,
    timestamp,
  })
}

export function chat_view(player_index: number): TaskBoardChatView {
  const views = ensure_views()
  let view = views[player_index]
  if (view === undefined) {
    view = { follow: true, hover: false, behind: false }
    views[player_index] = view
  }
  return view
}

export function reset_chat_view(player_index: number) {
  const view = chat_view(player_index)
  view.follow = true
  view.hover = false
  view.behind = false
  view.seen_key = undefined
  return view
}

export function stop_chat_follow(player_index: number, last_shown_key: string | undefined) {
  const view = chat_view(player_index)
  if (!view.follow) return false
  view.follow = false
  view.behind = false
  view.seen_key = last_shown_key
  return true
}

export function resume_chat_follow(player_index: number, last_shown_key: string | undefined) {
  const view = chat_view(player_index)
  view.follow = true
  view.behind = true
  view.seen_key = last_shown_key
  return view
}

export function set_chat_hover(player_index: number, hover: boolean) {
  const view = chat_view(player_index)
  view.hover = hover
  return view
}

export function chat_unseen(keys: string[], seen_key: string | undefined) {
  if (seen_key === undefined) return { count: keys.length, overflow: false }
  for (let index = keys.length - 1; index >= 0; index--) {
    if (keys[index] === seen_key) return { count: keys.length - 1 - index, overflow: false }
  }
  return { count: keys.length, overflow: keys.length > 0 }
}

export function chat_should_scroll(view: TaskBoardChatView, appended: number, last_key: string | undefined) {
  if (!view.follow) return false
  view.seen_key = last_key
  if (view.hover) {
    if (appended > 0) view.behind = true
    return false
  }
  const scroll = appended > 0 || view.behind
  view.behind = false
  return scroll
}

/** Same suffix/prefix diff used by Activity; keeps the scroll-pane alive. */
export function chat_rows_diff(shown: string[], wanted: string[]) {
  for (let overlap = math.min(shown.length, wanted.length); overlap >= 0; overlap--) {
    if (overlap === 0 && shown.length > 0) return undefined
    let matches = true
    for (let index = 0; index < overlap; index++) {
      if (shown[shown.length - overlap + index] !== wanted[index]) { matches = false; break }
    }
    if (matches) return { drop: shown.length - overlap, append: wanted.length - overlap }
  }
  return undefined
}
