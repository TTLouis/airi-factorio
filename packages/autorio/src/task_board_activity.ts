import type { TaskBoardUiActivity } from './task_board_ui'

/**
 * Filtering and follow state for the console's Recent activity feed.
 *
 * Everything here is plain logic over synchronized `storage`, so every peer
 * reaches the same answer. It lives apart from task_board_ui because TSTL emits
 * each module-scope constant and helper as a Lua local, and that module is
 * already close to Factorio's 200-locals-per-function limit.
 */

type ActivityKind = TaskBoardUiActivity['kind']

export interface ActivityFilter { caption: string, flag: number, tooltip: string }

// Flags are powers of two combined by plain arithmetic, never bitwise operators:
// TSTL's JIT target emits `bit.band`, and Factorio's Lua has no `bit` library.
// Keep every visible caption to three glyphs so the auto-sized Factorio buttons
// stay visually uniform next to the hard-coded ALL button in task_board_ui.
export const ACTIVITY_FILTERS: ActivityFilter[] = [
  { caption: 'PLN', flag: 1, tooltip: 'Plan decisions' },
  { caption: 'OBS', flag: 2, tooltip: 'Observations and notes' },
  { caption: 'ACT', flag: 4, tooltip: 'Actions' },
  { caption: 'RES', flag: 8, tooltip: 'Results' },
  { caption: 'ISS', flag: 16, tooltip: 'Blockers and system events' },
]
export const ACTIVITY_FILTER_ALL = 31
const ACTIVITY_HISTORY_LIMIT = 160

export interface ActivityView {
  // Scroll to each new event as it arrives.
  follow: boolean
  // The cursor is over the feed, so it must not move under the player.
  hover: boolean
  // New rows were appended while the feed could not move; catch up once it can.
  behind: boolean
  // The last event the player has seen. Everything after it counts as new.
  seen_key?: string
}

declare const storage: {
  airi_task_board_activity_filter?: Record<number, number>
  airi_task_board_activity_filters?: Record<number, number>
  airi_task_board_activity_view?: Record<number, ActivityView>
  airi_task_board_activity_history?: TaskBoardUiActivity[]
}

function has_flag(mask: number, flag: number) { return math.floor(mask / flag) % 2 === 1 }

function kind_flag(kind: ActivityKind) {
  if (kind === 'decision') return 1
  if (kind === 'observation' || kind === 'note') return 2
  if (kind === 'action') return 4
  if (kind === 'result') return 8
  return 16
}

function normalize_mask(value: unknown) {
  return typeof value === 'number' && value === math.floor(value) && value >= 0 && value <= ACTIVITY_FILTER_ALL ? value : undefined
}

/**
 * The categories this player currently shows. A save from the single-select
 * drop-down stored an index into ALL, PLAN, OBS, ACTIONS, RESULTS, ISSUES; that
 * selection carries over as the equivalent single category.
 */
export function activity_filter_mask(player_index: number) {
  const current = normalize_mask(storage.airi_task_board_activity_filters?.[player_index])
  if (current !== undefined) return current
  const legacy = storage.airi_task_board_activity_filter?.[player_index]
  if (legacy === 2) return 1
  if (legacy === 3) return 2
  if (legacy === 4) return 4
  if (legacy === 5) return 8
  if (legacy === 6) return 16
  return ACTIVITY_FILTER_ALL
}

/** Toggle one category, or select every category when `flag` is ALL. */
export function toggle_activity_filter(player_index: number, flag: number) {
  const mask = activity_filter_mask(player_index)
  let next = ACTIVITY_FILTER_ALL
  if (flag !== ACTIVITY_FILTER_ALL) next = has_flag(mask, flag) ? mask - flag : mask + flag
  if (storage.airi_task_board_activity_filters === undefined) storage.airi_task_board_activity_filters = {}
  storage.airi_task_board_activity_filters[player_index] = next
  return next
}

export function activity_filter_selected(mask: number, flag: number) {
  return flag === ACTIVITY_FILTER_ALL ? mask === ACTIVITY_FILTER_ALL : has_flag(mask, flag)
}

export function activity_matches_mask(kind: ActivityKind, mask: number) { return has_flag(mask, kind_flag(kind)) }

/**
 * Stable identity for one rendered row. The runtime gives live events an id;
 * derived entries without one fall back to their content, which is stable
 * because timestamps are stamped once and then preserved.
 */
export function activity_key(entry: TaskBoardUiActivity) {
  return entry.id !== undefined && entry.id.length > 0 ? `id:${entry.id}` : `${entry.kind}|${entry.timestamp ?? ''}|${entry.text}`
}

/**
 * Snapshots intentionally carry only a small recent activity window so RCON
 * payloads stay bounded. Preserve those windows locally in synchronized mod
 * storage so the UI can scroll farther back without making every heartbeat
 * larger. Duplicate overlap between snapshots is ignored by stable activity key.
 */
export function merge_activity_history(incoming: TaskBoardUiActivity[]) {
  if (storage.airi_task_board_activity_history === undefined) storage.airi_task_board_activity_history = []
  const history = storage.airi_task_board_activity_history
  for (const entry of incoming) {
    const key = activity_key(entry)
    let seen = false
    for (let index = history.length - 1; index >= 0; index--) {
      if (activity_key(history[index]) !== key) continue
      seen = true
      break
    }
    if (!seen) history.push(entry)
  }
  while (history.length > ACTIVITY_HISTORY_LIMIT) history.shift()
  return history
}

export function activity_history() { return storage.airi_task_board_activity_history ?? [] }

/**
 * How to turn the rows on screen into the rows that should be there without
 * rebuilding the feed, which is what would throw away the player's scroll.
 *
 * The feed only ever grows at the end and is trimmed from the front, so the
 * rows that survive are a suffix of what is shown that is also a prefix of what
 * should be shown. Returns how many leading rows to drop and how many trailing
 * entries to append, or undefined when the two lists do not line up and the
 * feed has to be rebuilt.
 */
export function activity_rows_diff(shown: string[], wanted: string[]) {
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

/**
 * New events the player has not seen: those after `seen_key`. When that event
 * has already been trimmed out of the feed, every row shown is new and there
 * may be more that were never shown, which `overflow` reports.
 */
export function activity_unseen(keys: string[], seen_key: string | undefined) {
  if (seen_key === undefined) return { count: keys.length, overflow: false }
  for (let index = keys.length - 1; index >= 0; index--) {
    if (keys[index] === seen_key) return { count: keys.length - 1 - index, overflow: false }
  }
  return { count: keys.length, overflow: keys.length > 0 }
}

export function activity_view(player_index: number): ActivityView {
  if (storage.airi_task_board_activity_view === undefined) storage.airi_task_board_activity_view = {}
  let view = storage.airi_task_board_activity_view[player_index]
  if (view === undefined) {
    view = { follow: true, hover: false, behind: false }
    storage.airi_task_board_activity_view[player_index] = view
  }
  return view
}

/** A freshly opened feed, or one whose contents a filter change replaced. */
export function reset_activity_view(player_index: number) {
  const view = activity_view(player_index)
  view.follow = true
  view.hover = false
  view.behind = false
  view.seen_key = undefined
  return view
}

/**
 * Take follow away the moment the player scrolls the feed themselves,
 * remembering the newest event they could see at that point.
 */
export function stop_activity_follow(player_index: number, last_shown_key: string | undefined) {
  const view = activity_view(player_index)
  if (!view.follow) return false
  view.follow = false
  view.behind = false
  view.seen_key = last_shown_key
  return true
}

/**
 * Jump back to the newest event and keep following from there. The feed is
 * marked behind so the next refresh scrolls even though nothing new arrived.
 */
export function resume_activity_follow(player_index: number, last_shown_key: string | undefined) {
  const view = activity_view(player_index)
  view.follow = true
  view.behind = true
  view.seen_key = last_shown_key
  return view
}

export function set_activity_hover(player_index: number, hover: boolean) {
  const view = activity_view(player_index)
  view.hover = hover
  return view
}

/**
 * Whether the feed should scroll to its newest row after a refresh. Records
 * anything the player still has to catch up on, and keeps `seen_key` at the
 * newest row for as long as the feed is following.
 */
export function activity_should_scroll(view: ActivityView, appended: number, last_key: string | undefined) {
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
