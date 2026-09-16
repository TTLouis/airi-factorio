import type { FrameGuiElement, LuaGuiElement, LuaPlayer } from 'factorio:runtime'

export const DEBUG_BUTTON_NAME = 'airi_task_board_debug'
export const DEBUG_CLOSE_BUTTON_NAME = 'airi_task_board_debug_close'
const DEBUG_ROOT_NAME = 'airi_task_board_debug_panel'
const DEBUG_BODY_NAME = 'airi_task_board_debug_body'
const DEBUG_WIDTH = 720
const DEBUG_KEY_WIDTH = 118
const DEBUG_VALUE_WIDTH = DEBUG_WIDTH - DEBUG_KEY_WIDTH - 54

declare const storage: {
  airi_task_board_debug_open?: Record<number, boolean>
  airi_task_board_ui_generation?: number
  airi_task_board_ui_revision?: number
  airi_task_board_ui?: any
  airi_task_board_ui_suppressed?: { goal_id: string, objective: string }
  airi_task_board_ui_last_seen?: { goal_id: string, objective: string }
  airi_task_board_ui_inputs?: any[]
}

export interface TaskBoardUiDebugSnapshot {
  request_id: string
  turn: number
  provider_model: string
  provider_round: number
  provider_latency_ms: number
  input_units: number
  cached_input_units: number
  output_units: number
  total_units: number
  last_tool: string
  last_event: string
  recovery_attempt: number
  last_error: string
  actor_id: number
  actor_epoch: number
}

function clean_text(value: unknown, max = 500) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}
function integer(value: unknown, fallback = 0) { return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback }
function valid_version(value: unknown) { return typeof value === 'number' && value === math.floor(value) && value >= 0 }

export function sanitize_debug_snapshot(value: any): TaskBoardUiDebugSnapshot {
  const debug = value !== null && typeof value === 'object' ? value : {}
  return {
    request_id: clean_text(debug.request_id, 120),
    turn: integer(debug.turn),
    provider_model: clean_text(debug.provider_model, 160),
    provider_round: integer(debug.provider_round),
    provider_latency_ms: integer(debug.provider_latency_ms),
    input_units: integer(debug.input_units),
    cached_input_units: integer(debug.cached_input_units),
    output_units: integer(debug.output_units),
    total_units: integer(debug.total_units),
    last_tool: clean_text(debug.last_tool, 120),
    last_event: clean_text(debug.last_event, 120),
    recovery_attempt: integer(debug.recovery_attempt),
    last_error: clean_text(debug.last_error, 500),
    actor_id: integer(debug.actor_id),
    actor_epoch: integer(debug.actor_epoch),
  }
}

export function accept_sync_version(generation: unknown, revision: unknown) {
  if (!valid_version(generation) || !valid_version(revision)) return true
  const incoming_generation = generation as number
  const incoming_revision = revision as number
  const current_generation = storage.airi_task_board_ui_generation ?? -1
  const current_revision = storage.airi_task_board_ui_revision ?? -1
  if (incoming_generation < current_generation) return false
  if (incoming_generation === current_generation && incoming_revision <= current_revision) return false
  storage.airi_task_board_ui_generation = incoming_generation
  storage.airi_task_board_ui_revision = incoming_revision
  return true
}

export function current_sync_version() {
  return { generation: storage.airi_task_board_ui_generation ?? 0, revision: storage.airi_task_board_ui_revision ?? 0 }
}

function snapshot_identity(board: any) {
  return { goal_id: clean_text(board?.goal_id, 100), objective: clean_text(board?.objective, 500) }
}
export function suppress_snapshot(board: any) {
  if (board === undefined || board === null) return
  storage.airi_task_board_ui_suppressed = snapshot_identity(board)
}
export function clear_snapshot_suppression() { storage.airi_task_board_ui_suppressed = undefined }
export function snapshot_is_suppressed(value: any) {
  const suppressed = storage.airi_task_board_ui_suppressed
  if (suppressed === undefined || value === undefined || value === null || typeof value !== 'object') return false
  const objective = clean_text(value.objective, 500)
  const goal_id = clean_text(value.goal_id, 100)
  if (suppressed.objective.length === 0 || objective !== suppressed.objective) return false
  return goal_id.length === 0 || goal_id === suppressed.goal_id
}

function terminate_is_queued() {
  for (const input of storage.airi_task_board_ui_inputs ?? []) {
    if (input?.kind === 'control' && input?.action === 'terminate') return true
  }
  return false
}

/**
 * Keep the UI projection monotonic around destructive clears without mutating
 * Factorio's `remote` object. The confirmed Terminate input creates a tombstone
 * before the runtime can drain it. We also learn a tombstone whenever a board
 * that was visible disappears, covering runtime-originated clears. If an old
 * heartbeat later republishes that same goal (including the plan-less live
 * projection with an empty goal id), clear it through the public remote
 * interface on the next deterministic game tick. A new durable goal id or a
 * different objective is accepted and becomes the new baseline.
 */
export function reconcile_task_board_freshness() {
  const current = storage.airi_task_board_ui
  if (terminate_is_queued() && current !== undefined) {
    suppress_snapshot(current)
    storage.airi_task_board_ui_last_seen = snapshot_identity(current)
    return false
  }
  if (current === undefined) {
    if (storage.airi_task_board_ui_suppressed === undefined && storage.airi_task_board_ui_last_seen !== undefined) {
      storage.airi_task_board_ui_suppressed = storage.airi_task_board_ui_last_seen
    }
    return false
  }
  if (snapshot_is_suppressed(current)) {
    if (typeof remote !== 'undefined' && remote.interfaces?.autorio_task_board !== undefined) remote.call('autorio_task_board', 'clear')
    else storage.airi_task_board_ui = undefined
    return true
  }
  storage.airi_task_board_ui_last_seen = snapshot_identity(current)
  if (storage.airi_task_board_ui_suppressed !== undefined) clear_snapshot_suppression()
  return false
}

// New runtimes attach generation/revision numbers to every snapshot. Keep the
// watchdog as a rolling-upgrade fallback for an older unversioned supervisor.
if (typeof script !== 'undefined' && typeof defines !== 'undefined') {
  script.on_event(defines.events.on_tick, () => { reconcile_task_board_freshness() })
}

function ensure_debug_open_state() { if (storage.airi_task_board_debug_open === undefined) storage.airi_task_board_debug_open = {}; return storage.airi_task_board_debug_open }
export function debug_ui_is_open(player_index: number) { return storage.airi_task_board_debug_open?.[player_index] === true }
// Runtime diagnostics are intentionally bounded and ride the normal snapshot,
// so the poll schema stays unchanged and remains compatible with older eggs.
export function any_debug_ui_open(): any { return undefined }
export function toggle_debug_ui(player_index: number) { const next = !debug_ui_is_open(player_index); ensure_debug_open_state()[player_index] = next; return next }
export function close_debug_ui(player_index: number) { ensure_debug_open_state()[player_index] = false }
export function debug_button_caption(player_index: number) { return debug_ui_is_open(player_index) ? 'DEBUG ON' : 'DEBUG' }
export function follow_button_caption(active: boolean) { return active ? 'FOLLOWING' : 'FOLLOW' }

export function latest_ai_reply(board: any) {
  const direct = clean_text(board?.response, 2000)
  if (direct.length > 0) return direct
  const activity = Array.isArray(board?.activity) ? board.activity as any[] : []
  for (let index = activity.length - 1; index >= 0; index--) {
    if (activity[index]?.kind !== 'decision') continue
    const reply = clean_text(activity[index]?.text, 2000)
    if (reply.length > 0) return reply
  }
  return ''
}

export function render_ai_reply(parent: LuaGuiElement, response: string, width: number) {
  const section = parent.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame' })
  section.style.width = width
  section.style.horizontally_stretchable = false
  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: 'AIRI Reply', style: 'subheader_caption_label' })
  const body = section.add({ type: 'flow', direction: 'vertical' })
  body.style.padding = 10
  body.style.horizontally_stretchable = true
  const explicit = clean_text(response, 2000)
  const clean = explicit.length > 0 ? explicit : latest_ai_reply(storage.airi_task_board_ui)
  const label = body.add({ type: 'label', caption: clean.length > 0 ? clean : 'No AIRI reply yet.' })
  label.style.single_line = false
  label.style.maximal_width = width - 20
  if (clean.length === 0) label.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }
}

function destroy_debug_popout(player: LuaPlayer) {
  const existing = player.gui.screen[DEBUG_ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  return location
}
function add_row(table: LuaGuiElement, key: string, value: string, tooltip?: string) {
  const left = table.add({ type: 'label', caption: key, style: 'semibold_label' }); left.style.minimal_width = DEBUG_KEY_WIDTH
  const right = table.add({ type: 'label', caption: value.length > 0 ? value : '—', tooltip }); right.style.single_line = false; right.style.maximal_width = DEBUG_VALUE_WIDTH
}
function sync_age(synced_tick: number | undefined) {
  if (synced_tick === undefined) return 'never'
  const seconds = math.floor(math.max(0, game.tick - synced_tick) / 60)
  return seconds < 60 ? `${seconds}s` : `${math.floor(seconds / 60)}m ${seconds % 60}s`
}

function fill_debug_body(body: LuaGuiElement, board: any, runtime: any, synced_tick: number | undefined) {
  body.clear()
  const note = body.add({ type: 'label', caption: 'Structured runtime diagnostics only — no hidden chain-of-thought or secrets are exposed.' })
  note.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }; note.style.single_line = false
  const table = body.add({ type: 'table', column_count: 2 }); table.style.horizontal_spacing = 12; table.style.vertical_spacing = 5
  const debug = board?.debug ?? {}; const follow = runtime?.follow; const world = runtime?.world_task; const version = current_sync_version()
  const step = board !== undefined && board.total_steps > 0 ? `${math.min(board.active_index + 1, board.total_steps)}/${board.total_steps} (${board.completed_count} done)` : '—'
  const phase = board?.agent?.phase ? String(board.agent.phase).toUpperCase() : 'IDLE'; const detail = clean_text(board?.agent?.detail, 300)
  const provider = clean_text(debug.provider_model, 160); const latency = integer(debug.provider_latency_ms)
  const tokens = integer(debug.total_units) > 0 ? `${integer(debug.input_units)} in / ${integer(debug.cached_input_units)} cached / ${integer(debug.output_units)} out / ${integer(debug.total_units)} total` : '—'
  const actor = integer(debug.actor_id) > 0 ? `${runtime?.actor_name ?? 'AIRI'} · id ${integer(debug.actor_id)} · epoch ${integer(debug.actor_epoch)}` : `${runtime?.actor_name ?? 'AIRI'} · ${runtime?.actor_kind ?? 'unknown'}`
  const world_text = world === undefined ? 'unknown' : `${clean_text(world.task_state, 48) || 'idle'} · queue ${integer(world.queue_length)}`
  const follow_text = follow?.active ? `active · ${clean_text(follow.target_player, 128) || 'target'}${typeof follow.current_distance === 'number' ? ` · ${math.floor(follow.current_distance * 10) / 10} tiles` : ''}` : 'inactive'
  const reply = latest_ai_reply(board)
  add_row(table, 'AI phase', detail.length > 0 ? `${phase} · ${detail}` : phase, detail)
  add_row(table, 'Goal', board?.status ? `${String(board.status).toUpperCase()} · ${clean_text(board.objective, 300) || clean_text(board.goal_id, 120)}` : 'none', clean_text(board?.objective, 500))
  add_row(table, 'AI reply', reply || '—', reply)
  add_row(table, 'Plan step', step)
  add_row(table, 'Request', clean_text(debug.request_id, 120) || '—')
  add_row(table, 'Turn', integer(debug.turn) > 0 ? `${integer(debug.turn)}` : '—')
  add_row(table, 'Provider', provider.length > 0 ? `${provider} · round ${integer(debug.provider_round) + 1}` : '—')
  add_row(table, 'Latency', latency > 0 ? `${latency} ms` : '—')
  add_row(table, 'Tokens', tokens)
  add_row(table, 'Last tool', clean_text(debug.last_tool, 120) || '—')
  add_row(table, 'Last event', clean_text(debug.last_event, 120) || '—')
  add_row(table, 'Recovery', integer(debug.recovery_attempt) > 0 ? `attempt ${integer(debug.recovery_attempt)}` : 'none')
  add_row(table, 'Actor', actor)
  add_row(table, 'World task', world_text)
  add_row(table, 'Follow', follow_text, clean_text(follow?.last_failure, 300))
  add_row(table, 'UI sync', `gen ${version.generation} · rev ${version.revision} · age ${sync_age(synced_tick)}`)
  if (clean_text(debug.last_error, 500).length > 0) add_row(table, 'Last error', clean_text(debug.last_error, 500), clean_text(debug.last_error, 500))
}

function build_debug_popout(player: LuaPlayer, board: any, runtime: any, synced_tick: number | undefined) {
  const previous_location = destroy_debug_popout(player)
  const root = player.gui.screen.add({ type: 'frame', name: DEBUG_ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' }); titlebar.style.horizontally_stretchable = true; titlebar.style.horizontal_spacing = 8; titlebar.drag_target = root
  titlebar.add({ type: 'label', caption: 'AIRI Debug', style: 'frame_title', ignored_by_interaction: true })
  const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true }); dragger.style.horizontally_stretchable = true; dragger.style.height = 24
  titlebar.add({ type: 'sprite-button', name: DEBUG_CLOSE_BUTTON_NAME, sprite: 'utility/close', style: 'frame_action_button', tooltip: 'Close AIRI Debug' })
  const body = root.add({ type: 'flow', name: DEBUG_BODY_NAME, direction: 'vertical' }); body.style.width = DEBUG_WIDTH; body.style.padding = 10; body.style.vertical_spacing = 8
  fill_debug_body(body, board, runtime, synced_tick); root.bring_to_front()
}

export function render_debug_popout(player: LuaPlayer, console_open: boolean, board: any, runtime: any, synced_tick: number | undefined) {
  if (!console_open || !debug_ui_is_open(player.index)) { destroy_debug_popout(player); return }
  const root = player.gui.screen[DEBUG_ROOT_NAME]; const body = root?.valid ? root[DEBUG_BODY_NAME] : undefined
  if (body?.valid) { fill_debug_body(body, board, runtime, synced_tick); return }
  build_debug_popout(player, board, runtime, synced_tick)
}
