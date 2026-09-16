import type { MapPositionStruct } from 'factorio:prototype'
import type { CameraGuiElement, FrameGuiElement, LuaEntity, LuaGuiElement, LuaPlayer, LuaSurface, SpriteButtonGuiElement, SpritePath, TextFieldGuiElement } from 'factorio:runtime'

import { peek_controlled_actor } from './actors/actor_controller'
import { create_learning_remote_interface, handle_learning_ui_click, handle_task_board_learning_transition, render_learning_status } from './learning_pipeline'
import { create_skill_remote_interface, handle_skill_export_click, render_learn_area_button, render_skill_export_section } from './skills'
import { get_actor_inventory_items } from './utils/inventory'

const BUTTON_NAME = 'airi_task_board_button'
const MOD_GUI_LEGACY_FLOW_NAME = 'mod_gui_button_flow'
const MOD_GUI_TOP_FRAME_NAME = 'mod_gui_top_frame'
const MOD_GUI_INNER_FRAME_NAME = 'mod_gui_inner_frame'
const ROOT_NAME = 'airi_task_board_panel'
const COLUMNS_NAME = 'airi_task_board_columns'
const LEFT_COLUMN_NAME = 'airi_task_board_left_column'
const LEFT_DYNAMIC_NAME = 'airi_task_board_left_dynamic'
const RIGHT_COLUMN_NAME = 'airi_task_board_right_column'
const RIGHT_RESOURCES_NAME = 'airi_task_board_right_resources'
const PROMPT_SECTION_NAME = 'airi_task_board_prompt_section'
const PROMPT_FLOW_NAME = 'airi_task_board_prompt_flow'
// The preview is refreshed in place rather than rebuilt, so every element the
// refresh has to find needs a stable name.
const PREVIEW_SECTION_NAME = 'airi_task_board_preview_section'
const PREVIEW_HEADER_NAME = 'airi_task_board_preview_header'
const PREVIEW_BODY_NAME = 'airi_task_board_preview_body'
const PREVIEW_POSITION_NAME = 'airi_task_board_preview_position'
const PREVIEW_CAMERA_FRAME_NAME = 'airi_task_board_preview_camera_frame'
const PREVIEW_CAMERA_NAME = 'airi_task_board_preview_camera'
const PREVIEW_ZOOM_SLIDER_NAME = 'airi_task_board_preview_zoom'
const PREVIEW_ZOOM_VALUE_NAME = 'airi_task_board_preview_zoom_value'
const SKILLS_ROOT_NAME = 'airi_task_board_skills_panel'
const SKILLS_BODY_NAME = 'airi_task_board_skills_body'
const SKILLS_BUTTON_NAME = 'airi_task_board_skills'
const SKILLS_CLOSE_BUTTON_NAME = 'airi_task_board_skills_close'
const SKILLS_POPOUT_TITLE = 'Area Learning & Skills'
const BUTTON_SPRITE: SpritePath = 'item/logistic-robot'
const CLOSE_BUTTON_NAME = 'airi_task_board_close'
const PAUSE_BUTTON_NAME = 'airi_task_board_pause'
const TERMINATE_BUTTON_NAME = 'airi_task_board_terminate'
const FOLLOW_BUTTON_NAME = 'airi_task_board_follow'
const PROMPT_FIELD_NAME = 'airi_task_board_prompt'
const PROMPT_SEND_BUTTON_NAME = 'airi_task_board_prompt_send'
const MAX_STEPS = 24
const MAX_ACTIVITY = 12
const MAX_INVENTORY_ITEMS = 24
const MAX_WANTED_ITEMS = 16
const MAX_TEXT = 500
const MAX_PROMPT_TEXT = 4000
const UI_INPUT_QUEUE_LIMIT = 32
// The console asks for a snapshot rather than only waiting to be handed one: a
// push-only feed leaves `storage.airi_task_board_ui` untouched whether AIRI is
// idle or gone, so the two are indistinguishable. The request rides the input
// drain the runtime already performs, so it costs no extra round trip.
const POLL_REQUEST_TICKS = 60
// Roughly forty unanswered drains. Past this the last snapshot is history, not
// status, and the console has to say so instead of repeating it as current.
const SYNC_STALE_TICKS = 10 * 60
const TERMINATE_CONFIRM_TICKS = 5 * 60
const LEFT_COLUMN_WIDTH = 640
const PREVIEW_COLUMN_WIDTH = 640
const COLUMN_SPACING = 12
const HALF_SECTION_WIDTH = (LEFT_COLUMN_WIDTH - COLUMN_SPACING) / 2
const SECTION_PADDING = 10
const KEY_COLUMN_WIDTH = 64
const HALF_VALUE_WIDTH = HALF_SECTION_WIDTH - 2 * SECTION_PADDING - KEY_COLUMN_WIDTH - 12
const SLOT_SIZE = 40
const SLOT_COLUMNS = 6
const SLOT_ROWS = 2
const SCROLLBAR_WIDTH = 12
// The console is exactly as tall as its left column, because the world preview
// stretches to match it. So the two tracker scroll panes and the camera's floor
// are what decide the window's height, and sizing them from the player's own
// display lets a large screen be used properly without producing a window a
// small screen cannot show. Both display properties are synchronized, so this
// stays identical on every peer.
const CONSOLE_SCREEN_FRACTION = 0.92
// Deliberately generous estimate of everything in the left column that is not a
// tracker list: titlebar, the status/controls row, section headers, progress
// bar, divider, the inventory row and the prompt. Overestimating costs a little
// height; underestimating would push the window past the bottom of the screen.
const CONSOLE_FIXED_HEIGHT = 620
const TRACKER_LIST_MIN_TOTAL = 306
const TRACKER_LIST_MAX_TOTAL = 900
const TRACKER_STEPS_SHARE = 0.43
const PREVIEW_CAMERA_WIDTH = PREVIEW_COLUMN_WIDTH - 2 * SECTION_PADDING
const PREVIEW_CAMERA_MIN_HEIGHT = 360
const PREVIEW_CAMERA_MAX_HEIGHT = 900
const PREVIEW_CAMERA_SCREEN_FRACTION = 0.5
const PREVIEW_ZOOM_DEFAULT = 0.75
const PREVIEW_ZOOM_MIN = 0.25
const PREVIEW_ZOOM_MAX = 2
const PREVIEW_ZOOM_STEP = 0.05
const COMPACT_BUTTON_HEIGHT = 32
const COMPACT_BUTTON_SPACING = 6
// Every control is the same size. Two sizes across two rows read as a ragged
// grid, and sizing each button to its own caption made the panel look
// accidental. Two of these plus the gap exactly fill the section's inner width.
const COMPACT_BUTTON_WIDTH = (HALF_SECTION_WIDTH - 2 * SECTION_PADDING - COMPACT_BUTTON_SPACING) / 2
const PROMPT_SEND_WIDTH = 84
const PROMPT_FIELD_WIDTH = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 8 - PROMPT_SEND_WIDTH
const SKILLS_POPOUT_WIDTH = 720

type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow'
type TaskBoardUiActivityKind = 'observation' | 'decision' | 'action' | 'result' | 'blocker' | 'system' | 'note'
type TaskBoardUiAgentPhase = 'idle' | 'thinking' | 'observing' | 'executing' | 'waiting' | 'error'
type Tone = 'good' | 'info' | 'warn' | 'bad' | 'muted'

const TONE_COLORS: Record<Tone, { r: number, g: number, b: number }> = {
  good: { r: 0.45, g: 0.85, b: 0.35 },
  info: { r: 0.5, g: 0.72, b: 1 },
  warn: { r: 1, g: 0.8, b: 0.3 },
  bad: { r: 1, g: 0.42, b: 0.35 },
  muted: { r: 0.68, g: 0.68, b: 0.68 },
}

const TONE_SPRITES: Record<Tone, SpritePath> = {
  good: 'utility/status_working',
  info: 'utility/status_blue',
  warn: 'utility/status_yellow',
  bad: 'utility/status_not_working',
  muted: 'utility/status_inactive',
}

export interface TaskBoardUiStep { id: string, description: string, status: 'pending' | 'active' | 'completed' | 'blocked' | 'paused' }
export interface TaskBoardUiActivity { kind: TaskBoardUiActivityKind, text: string, timestamp?: string }
export interface TaskBoardUiWantedItem { name: string, count: number, reason: string }
export interface TaskBoardUiAgentStatus { phase: TaskBoardUiAgentPhase, detail: string }
export interface TaskBoardUiSnapshot {
  goal_id: string
  objective: string
  status: 'idle' | 'active' | 'blocked' | 'paused' | 'completed'
  blocker: string
  pause_reason: string
  completed_count: number
  total_steps: number
  active_index: number
  steps: TaskBoardUiStep[]
  activity: TaskBoardUiActivity[]
  wanted_items: TaskBoardUiWantedItem[]
  agent: TaskBoardUiAgentStatus
}

interface TaskBoardUiFollowStatus { active: boolean, state: string, target_player: string, current_distance?: number, desired_distance?: number, last_failure: string }
interface TaskBoardUiControlInput { kind: 'control', version: 1, action: TaskBoardUiControlAction, player_index: number, player_name: string, tick: number }
interface TaskBoardUiPromptInput { kind: 'prompt', version: 1, player_index: number, player_name: string, text: string, tick: number }
interface TaskBoardUiPollInput { kind: 'poll', version: 1, tick: number }
type TaskBoardUiInput = TaskBoardUiControlInput | TaskBoardUiPromptInput
// Polls are produced while draining, never queued, so enqueue stays typed to
// the player-originated inputs only.
type TaskBoardUiDrainedInput = TaskBoardUiInput | TaskBoardUiPollInput
interface TaskBoardUiWorldPreview { position: MapPositionStruct, surface_index: LuaSurface['index'], entity?: LuaEntity }
interface TaskBoardUiWorldTask { task_state: string, queue_length: number }
interface TaskBoardUiRuntimeSnapshot {
  actor_name: string
  actor_kind: string
  inventory: Array<{ name: string, count: number }>
  follow?: TaskBoardUiFollowStatus
  preview?: TaskBoardUiWorldPreview
  world_task?: TaskBoardUiWorldTask
}

declare const storage: {
  airi_task_board_ui?: TaskBoardUiSnapshot
  airi_task_board_ui_synced_tick?: number
  airi_task_board_ui_open?: Record<number, boolean>
  airi_task_board_skills_open?: Record<number, boolean>
  airi_task_board_terminate_confirm_until?: Record<number, number>
  airi_task_board_prompt_draft?: Record<number, string>
  airi_task_board_ui_inputs?: TaskBoardUiInput[]
  airi_task_board_preview_zoom?: Record<number, number>
}

let world_task_provider: ((this: void) => unknown) | undefined
export function set_task_board_world_task_provider(provider: (this: void) => unknown) { world_task_provider = provider }

function text(value: unknown, max = MAX_TEXT) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}
function integer(value: unknown, fallback = 0) { return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback }
function positive_integer(value: unknown, fallback = 1) { return math.max(1, integer(value, fallback)) }
function status(value: unknown): TaskBoardUiSnapshot['status'] { return value === 'idle' || value === 'blocked' || value === 'paused' || value === 'completed' ? value : 'active' }
function step_status(value: unknown): TaskBoardUiStep['status'] { return value === 'active' || value === 'completed' || value === 'blocked' || value === 'paused' ? value : 'pending' }
function activity_kind(value: unknown): TaskBoardUiActivityKind { return value === 'observation' || value === 'decision' || value === 'action' || value === 'result' || value === 'blocker' || value === 'system' ? value : 'note' }
function agent_phase(value: unknown): TaskBoardUiAgentPhase { return value === 'thinking' || value === 'observing' || value === 'executing' || value === 'waiting' || value === 'error' ? value : 'idle' }

export function sanitize_task_board_ui_snapshot(value: any): TaskBoardUiSnapshot | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || !Array.isArray(value.steps)) return undefined

  // Snapshot values arrive through helpers.json_to_table(), so these arrays are
  // plain Lua tables at runtime. Calling JS Array methods directly on `any`
  // makes TSTL emit `table:slice(...)`, which plain Lua tables do not have.
  // Iterate the dynamic boundary explicitly, then return normal typed arrays.
  const raw_steps = value.steps as any[]
  const steps: TaskBoardUiStep[] = []
  const step_count = math.min(raw_steps.length, 30)
  for (let index = 0; index < step_count; index++) {
    const step = raw_steps[index]
    const description = text(step?.description, MAX_TEXT)
    if (description.length === 0) continue
    steps.push({ id: text(step?.id || `step_${index + 1}`, 80), description, status: step_status(step?.status) })
  }

  const raw_activity = (Array.isArray(value.activity) ? value.activity : []) as any[]
  const activity: TaskBoardUiActivity[] = []
  const activity_start = math.max(0, raw_activity.length - MAX_ACTIVITY)
  for (let index = activity_start; index < raw_activity.length; index++) {
    const entry = raw_activity[index]
    const entry_text = text(entry?.text, 1000)
    if (entry_text.length === 0) continue
    const timestamp = text(entry?.timestamp, 16)
    const next: TaskBoardUiActivity = { kind: activity_kind(entry?.kind), text: entry_text }
    if (timestamp.length > 0) next.timestamp = timestamp
    activity.push(next)
  }

  const raw_wanted_items = (Array.isArray(value.wanted_items) ? value.wanted_items : []) as any[]
  const wanted_items: TaskBoardUiWantedItem[] = []
  const wanted_count = math.min(raw_wanted_items.length, MAX_WANTED_ITEMS)
  for (let index = 0; index < wanted_count; index++) {
    const item = raw_wanted_items[index]
    const name = text(item?.name, 200)
    if (name.length === 0) continue
    wanted_items.push({ name, count: positive_integer(item?.count, 1), reason: text(item?.reason, 300) })
  }

  const total = integer(value.total_steps, steps.length)
  const agent = value.agent !== null && typeof value.agent === 'object' ? value.agent : undefined
  return {
    goal_id: text(value.goal_id, 100), objective: text(value.objective, 500), status: status(value.status), blocker: text(value.blocker, 500), pause_reason: text(value.pause_reason, 300),
    completed_count: math.min(integer(value.completed_count), total), total_steps: total, active_index: math.min(integer(value.active_index), math.max(0, total - 1)), steps, activity, wanted_items,
    agent: { phase: agent_phase(agent?.phase), detail: text(agent?.detail, 300) },
  }
}

function two_digits(value: number) { return value < 10 ? `0${value}` : `${value}` }
export function task_board_game_time(tick: number) {
  const total_seconds = math.floor(math.max(0, tick) / 60)
  const hours = math.floor(total_seconds / 3600)
  const minutes = math.floor((total_seconds % 3600) / 60)
  const seconds = total_seconds % 60
  return `${two_digits(hours)}:${two_digits(minutes)}:${two_digits(seconds)}`
}
function stamp_activity_times(next: TaskBoardUiSnapshot, previous: TaskBoardUiSnapshot | undefined, tick: number) {
  const previous_activity = previous?.activity ?? []
  const used: boolean[] = []
  const now = task_board_game_time(tick)
  return { ...next, activity: next.activity.map(entry => {
    if (entry.timestamp !== undefined && entry.timestamp.length > 0) return entry
    for (let index = 0; index < previous_activity.length; index++) {
      const old = previous_activity[index]
      if (used[index] === true || old.kind !== entry.kind || old.text !== entry.text || !old.timestamp) continue
      used[index] = true
      return { ...entry, timestamp: old.timestamp }
    }
    return { ...entry, timestamp: now }
  }) }
}

function ensure_open_state() { if (storage.airi_task_board_ui_open === undefined) storage.airi_task_board_ui_open = {}; return storage.airi_task_board_ui_open }
function ensure_terminate_confirm_state() { if (storage.airi_task_board_terminate_confirm_until === undefined) storage.airi_task_board_terminate_confirm_until = {}; return storage.airi_task_board_terminate_confirm_until }
function ensure_prompt_draft_state() { if (storage.airi_task_board_prompt_draft === undefined) storage.airi_task_board_prompt_draft = {}; return storage.airi_task_board_prompt_draft }
function ensure_ui_input_queue() { if (storage.airi_task_board_ui_inputs === undefined) storage.airi_task_board_ui_inputs = []; return storage.airi_task_board_ui_inputs }
function ensure_preview_zoom_state() { if (storage.airi_task_board_preview_zoom === undefined) storage.airi_task_board_preview_zoom = {}; return storage.airi_task_board_preview_zoom }
function normalize_preview_zoom(value: unknown) {
  if (typeof value !== 'number') return PREVIEW_ZOOM_DEFAULT
  const clamped = math.max(PREVIEW_ZOOM_MIN, math.min(PREVIEW_ZOOM_MAX, value))
  const steps = math.floor((clamped - PREVIEW_ZOOM_MIN) / PREVIEW_ZOOM_STEP + 0.5)
  return math.floor((PREVIEW_ZOOM_MIN + steps * PREVIEW_ZOOM_STEP) * 100 + 0.5) / 100
}
export function task_board_preview_zoom(player_index: number) { return normalize_preview_zoom(storage.airi_task_board_preview_zoom?.[player_index] ?? PREVIEW_ZOOM_DEFAULT) }
function set_preview_zoom(player_index: number, value: unknown) { const zoom = normalize_preview_zoom(value); ensure_preview_zoom_state()[player_index] = zoom; return zoom }
function preview_zoom_caption(zoom: number) { return `${zoom}×` }
function enqueue_ui_input(input: TaskBoardUiInput) { const queue = ensure_ui_input_queue(); queue.push(input); while (queue.length > UI_INPUT_QUEUE_LIMIT) queue.shift() }
function any_console_open() { for (const player of game.connected_players) { if (task_board_ui_is_open(player.index)) return true } return false }

// Only ask when somebody is looking, and no faster than the console refreshes.
// A dead runtime never drains, so the request simply goes unanswered and the
// status panel degrades on its own.
function poll_request(): TaskBoardUiPollInput | undefined {
  if (!any_console_open()) return undefined
  const synced = storage.airi_task_board_ui_synced_tick
  if (synced !== undefined && math.max(0, game.tick - synced) < POLL_REQUEST_TICKS) return undefined
  return { kind: 'poll', version: 1, tick: game.tick }
}

function drain_ui_inputs() {
  const queued = storage.airi_task_board_ui_inputs ?? []
  storage.airi_task_board_ui_inputs = []
  const drained: TaskBoardUiDrainedInput[] = queued
  const poll = poll_request()
  if (poll !== undefined) drained.push(poll)
  return drained
}
export function task_board_ui_prompt_draft(player_index: number) { return storage.airi_task_board_prompt_draft?.[player_index] ?? '' }
function set_prompt_draft(player_index: number, value: unknown) { ensure_prompt_draft_state()[player_index] = text(value, MAX_PROMPT_TEXT) }
export function task_board_ui_is_open(player_index: number) { return storage.airi_task_board_ui_open?.[player_index] === true }
export function toggle_task_board_ui_open(player_index: number) { const next = !task_board_ui_is_open(player_index); ensure_open_state()[player_index] = next; return next }
function close_task_board_ui(player_index: number) { ensure_open_state()[player_index] = false }
function ensure_skills_open_state() { if (storage.airi_task_board_skills_open === undefined) storage.airi_task_board_skills_open = {}; return storage.airi_task_board_skills_open }
export function task_board_skills_ui_is_open(player_index: number) { return storage.airi_task_board_skills_open?.[player_index] === true }
export function toggle_task_board_skills_ui_open(player_index: number) { const next = !task_board_skills_ui_is_open(player_index); ensure_skills_open_state()[player_index] = next; return next }
function close_task_board_skills_ui(player_index: number) { ensure_skills_open_state()[player_index] = false }
export function task_board_ui_terminate_is_armed(player_index: number, tick: number) { return (storage.airi_task_board_terminate_confirm_until?.[player_index] ?? 0) >= tick }
function clear_terminate_confirmation(player_index: number) { ensure_terminate_confirm_state()[player_index] = 0 }
function arm_terminate(player_index: number) { ensure_terminate_confirm_state()[player_index] = game.tick + TERMINATE_CONFIRM_TICKS }

function mod_gui_button_flow(player: LuaPlayer): LuaGuiElement {
  const top = player.gui.top
  const legacy = top[MOD_GUI_LEGACY_FLOW_NAME]
  if (legacy?.valid) return legacy
  const frame = top[MOD_GUI_TOP_FRAME_NAME] ?? top.add({ type: 'frame', name: MOD_GUI_TOP_FRAME_NAME, direction: 'horizontal', style: 'slot_window_frame' })
  return frame[MOD_GUI_INNER_FRAME_NAME] ?? frame.add({ type: 'frame', name: MOD_GUI_INNER_FRAME_NAME, direction: 'horizontal', style: 'mod_gui_inside_deep_frame' })
}
function ensure_button(player: LuaPlayer) {
  const legacy = player.gui.top[BUTTON_NAME]
  if (legacy?.valid) legacy.destroy()
  const flow = mod_gui_button_flow(player)
  const existing = flow[BUTTON_NAME]
  const button = (existing?.valid ? existing : flow.add({ type: 'sprite-button', name: BUTTON_NAME, sprite: BUTTON_SPRITE, style: 'slot_button', tooltip: 'AIRI NPC Console' })) as SpriteButtonGuiElement
  button.toggled = task_board_ui_is_open(player.index)
  return button
}
function destroy_panel(player: LuaPlayer) {
  const existing = player.gui.screen[ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  const legacy = player.gui.left[ROOT_NAME]
  if (legacy?.valid) legacy.destroy()
  return location
}

function step_tone(step: TaskBoardUiStep): Tone { if (step.status === 'completed') return 'good'; if (step.status === 'active') return 'info'; if (step.status === 'blocked') return 'bad'; if (step.status === 'paused') return 'warn'; return 'muted' }
function activity_prefix(kind: TaskBoardUiActivityKind) { if (kind === 'observation') return 'OBS'; if (kind === 'decision') return 'PLAN'; if (kind === 'action') return 'ACT'; if (kind === 'result') return 'RESULT'; if (kind === 'blocker') return 'BLOCK'; if (kind === 'system') return 'SYS'; return 'NOTE' }
function activity_tone(kind: TaskBoardUiActivityKind): Tone { if (kind === 'decision' || kind === 'observation') return 'info'; if (kind === 'action' || kind === 'result') return 'good'; if (kind === 'blocker') return 'bad'; if (kind === 'system') return 'warn'; return 'muted' }
function board_tone(board_status: TaskBoardUiSnapshot['status']): Tone { if (board_status === 'active') return 'good'; if (board_status === 'completed') return 'info'; if (board_status === 'paused') return 'warn'; if (board_status === 'blocked') return 'bad'; return 'muted' }
function agent_tone(phase: TaskBoardUiAgentPhase): Tone { if (phase === 'thinking' || phase === 'observing') return 'info'; if (phase === 'executing') return 'good'; if (phase === 'waiting') return 'warn'; if (phase === 'error') return 'bad'; return 'muted' }
function agent_caption(phase: TaskBoardUiAgentPhase) { if (phase === 'thinking') return 'THINKING'; if (phase === 'observing') return 'OBSERVING'; if (phase === 'executing') return 'EXECUTING'; if (phase === 'waiting') return 'WORKING'; if (phase === 'error') return 'ERROR'; return 'IDLE' }
function item_caption(name: string) { const item_prototypes = prototypes.item; if (item_prototypes !== undefined && item_prototypes[name] !== undefined) return `[item=${name}] ${name}`; return name }
function item_sprite(name: string): SpritePath { const item: SpritePath = `item/${name}`; if (helpers.is_valid_sprite_path(item)) return item; const entity: SpritePath = `entity/${name}`; if (helpers.is_valid_sprite_path(entity)) return entity; return 'utility/questionmark' }
function read_follow_status(): TaskBoardUiFollowStatus | undefined {
  if (remote.interfaces?.autorio_follow === undefined || typeof remote.call !== 'function') return undefined
  const raw = remote.call('autorio_follow', 'status') as any
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  return { active: raw.active === true, state: text(raw.state, 32), target_player: text(raw.target_player ?? raw.player_name, 128), current_distance: typeof raw.current_distance === 'number' ? raw.current_distance : undefined, desired_distance: typeof raw.desired_distance === 'number' ? raw.desired_distance : undefined, last_failure: text(raw.last_failure ?? raw.blocked_reason, 300) }
}
function read_world_task(): TaskBoardUiWorldTask | undefined {
  if (world_task_provider === undefined) return undefined
  const raw = world_task_provider() as any
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  return { task_state: text(raw.task_state, 48), queue_length: integer(raw.queue_length) }
}
function runtime_snapshot(): TaskBoardUiRuntimeSnapshot {
  const actor = peek_controlled_actor()
  const identity = actor?.status_snapshot()
  const inventory = actor ? get_actor_inventory_items(actor) : []
  inventory.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const preview: TaskBoardUiWorldPreview | undefined = actor?.is_valid ? { position: actor.position, surface_index: actor.surface.index, entity: actor.character?.valid ? actor.character : undefined } : undefined
  return { actor_name: text(identity?.name ?? 'AIRI', 128), actor_kind: text(identity?.kind ?? '', 64), inventory: inventory.slice(0, MAX_INVENTORY_ITEMS), follow: read_follow_status(), preview, world_task: read_world_task() }
}
function emit_control(player: LuaPlayer, action: TaskBoardUiControlAction) { enqueue_ui_input({ kind: 'control', version: 1, action, player_index: player.index, player_name: player.name, tick: game.tick }) }
function emit_prompt(player: LuaPlayer, raw: unknown) {
  const prompt = text(raw, MAX_PROMPT_TEXT)
  if (prompt.length === 0) return false
  enqueue_ui_input({ kind: 'prompt', version: 1, player_index: player.index, player_name: player.name, text: prompt, tick: game.tick })
  set_prompt_draft(player.index, '')
  return true
}

function create_section(parent: LuaGuiElement, title: string, width?: number, tooltip?: string, stretch_vertical = true, names?: { section?: string, header?: string, body?: string }) {
  const section = parent.add({ type: 'frame', name: names?.section, direction: 'vertical', style: 'inside_shallow_frame' })
  if (width !== undefined) section.style.width = width
  else section.style.horizontally_stretchable = true
  section.style.vertically_stretchable = stretch_vertical
  const header = section.add({ type: 'frame', name: names?.header, direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: title, style: 'subheader_caption_label', tooltip })
  const filler = header.add({ type: 'empty-widget' }); filler.style.horizontally_stretchable = true
  const body = section.add({ type: 'flow', name: names?.body, direction: 'vertical' })
  body.style.horizontally_stretchable = true
  body.style.vertically_stretchable = stretch_vertical
  body.style.padding = SECTION_PADDING
  body.style.vertical_spacing = 6
  return { header, body }
}
function add_status_badge(parent: LuaGuiElement, tone: Tone, caption: string) { const badge = parent.add({ type: 'flow', direction: 'horizontal' }); badge.style.vertical_align = 'center'; badge.style.horizontal_spacing = 4; badge.style.right_padding = 4; badge.add({ type: 'sprite', sprite: TONE_SPRITES[tone], style: 'status_image' }); const label = badge.add({ type: 'label', caption, style: 'bold_label' }); label.style.font_color = TONE_COLORS[tone]; return badge }
function create_key_value_table(parent: LuaGuiElement) { const table = parent.add({ type: 'table', column_count: 2 }); table.style.horizontal_spacing = 12; table.style.vertical_spacing = 4; return table }
function add_key_value(table: LuaGuiElement, key: string, value: string, options: { tone?: Tone, tooltip?: string, width?: number } = {}) { const key_label = table.add({ type: 'label', caption: key, style: 'semibold_label' }); key_label.style.minimal_width = KEY_COLUMN_WIDTH; const value_label = table.add({ type: 'label', caption: value, tooltip: options.tooltip }); value_label.style.single_line = false; if (options.width !== undefined) value_label.style.maximal_width = options.width; if (options.tone !== undefined) value_label.style.font_color = TONE_COLORS[options.tone]; return value_label }
function add_empty_state(parent: LuaGuiElement, caption: string) { const label = parent.add({ type: 'label', caption }); label.style.font_color = TONE_COLORS.muted; return label }
function board_goal(board: TaskBoardUiSnapshot) { if (board.objective.length > 0) return board.objective; if (board.goal_id.length > 0) return board.goal_id; return board.status === 'idle' ? 'No active AIRI task.' : 'Current task' }
/**
 * How much the last snapshot is still worth believing.
 *
 * Tick-explicit and pure so the console never has to guess: `offline` means the
 * runtime has never answered, `stale` means it answered once and has since
 * stopped, and only `live` means the displayed phase is current.
 */
export function task_board_sync_freshness(synced_tick: number | undefined, tick: number): 'offline' | 'stale' | 'live' {
  if (synced_tick === undefined) return 'offline'
  return math.max(0, tick - synced_tick) > SYNC_STALE_TICKS ? 'stale' : 'live'
}

function sync_summary(synced_tick: number | undefined) { if (synced_tick === undefined) return 'Never — AIRI runtime not connected'; const seconds = math.floor(math.max(0, game.tick - synced_tick) / 60); const age = seconds < 60 ? `${seconds}s ago` : `${math.floor(seconds / 60)}m ago`; return task_board_sync_freshness(synced_tick, game.tick) === 'stale' ? `${age} — polls unanswered` : age }
function world_task_summary(task: TaskBoardUiWorldTask | undefined) { if (task === undefined) return 'UNKNOWN'; const state = task.task_state.length > 0 ? task.task_state.split('_').join(' ').toUpperCase() : 'IDLE'; return task.queue_length > 0 ? `${state} · ${task.queue_length} queued` : state }
function overall_state(board: TaskBoardUiSnapshot | undefined, synced_tick: number | undefined): { tone: Tone, caption: string } {
  const freshness = task_board_sync_freshness(synced_tick, game.tick)
  if (freshness === 'offline') return { tone: 'muted', caption: 'OFFLINE' }
  // A snapshot only ever describes the tick it was pushed at. Once the runtime
  // stops answering polls, repeating its last phase would claim AIRI is still
  // doing work that nothing is driving any more.
  if (freshness === 'stale') return { tone: 'bad', caption: 'STALE' }
  if (board === undefined) return { tone: 'muted', caption: 'IDLE' }
  // The header answers "what is AIRI doing right now?". The durable plan state
  // remains visible in Plan Tracker, so a live phase must not be hidden behind
  // the generic ACTIVE badge while the model is thinking/observing/executing.
  if (board.agent.phase !== 'idle') return { tone: agent_tone(board.agent.phase), caption: agent_caption(board.agent.phase) }
  return { tone: board_tone(board.status), caption: board.status.toUpperCase() }
}

function render_status_panel(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot, synced_tick: number | undefined) {
  const { header, body } = create_section(parent, 'Status', HALF_SECTION_WIDTH, undefined, false)
  const overall = overall_state(board, synced_tick); add_status_badge(header, overall.tone, overall.caption)
  const table = create_key_value_table(body)
  add_key_value(table, 'NPC', runtime.actor_name || 'AIRI', { tooltip: runtime.actor_kind.length > 0 ? runtime.actor_kind.split('_').join(' ') : undefined, width: HALF_VALUE_WIDTH })
  const freshness = task_board_sync_freshness(synced_tick, game.tick)
  const phase = board?.agent.phase ?? 'idle'; const detail = board?.agent.detail ?? ''
  const live_caption = detail.length > 0 ? `${agent_caption(phase)} · ${text(detail, 90)}` : agent_caption(phase)
  const stale_caption = freshness === 'offline' ? 'NOT CONNECTED' : `NO ANSWER — last seen ${agent_caption(phase)}`
  add_key_value(table, 'AIRI', freshness === 'live' ? live_caption : stale_caption, { tone: freshness === 'live' ? agent_tone(phase) : 'bad', tooltip: freshness === 'live' && detail.length > 0 ? detail : 'The console polls the AIRI runtime; this row reports the answer, not a guess.', width: HALF_VALUE_WIDTH })
  add_key_value(table, 'WORLD', world_task_summary(runtime.world_task), { width: HALF_VALUE_WIDTH })
  const goal = board === undefined ? 'No active AIRI task.' : board_goal(board)
  add_key_value(table, 'GOAL', text(goal, 110), { tooltip: goal, width: HALF_VALUE_WIDTH })
  add_key_value(table, 'SYNC', sync_summary(synced_tick), { tone: 'muted', width: HALF_VALUE_WIDTH })
}
// The live distance belongs in the tooltip: in the caption it re-flowed the
// button every tick and overran a fixed-width control.
function follow_button_caption(follow: TaskBoardUiFollowStatus | undefined) { return follow?.active ? 'FOLLOWING' : 'FOLLOW ME' }
function follow_button_tooltip(follow: TaskBoardUiFollowStatus | undefined) { if (!follow?.active) return 'Pause current work and follow this player'; const details = ['Click to stop following.']; if (follow.target_player.length > 0) details.push(`Target: ${follow.target_player}`); if (follow.state.length > 0) details.push(`State: ${follow.state.split('_').join(' ')}`); if (follow.current_distance !== undefined) details.push(`Distance: ${math.floor(follow.current_distance * 10) / 10} tiles`); if (follow.desired_distance !== undefined) details.push(`Desired: ${math.floor(follow.desired_distance * 10) / 10} tiles`); if (follow.last_failure.length > 0) details.push(`Issue: ${follow.last_failure}`); return details.join('\n') }
function compact_button(button: LuaGuiElement) { button.style.width = COMPACT_BUTTON_WIDTH; button.style.height = COMPACT_BUTTON_HEIGHT; button.style.minimal_width = 0; button.style.maximal_width = COMPACT_BUTTON_WIDTH; return button }
function render_controls_panel(parent: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const { body } = create_section(parent, 'Controls', HALF_SECTION_WIDTH, undefined, false)
  body.style.vertical_spacing = COMPACT_BUTTON_SPACING
  const follow = runtime.follow
  const has_open_goal = board !== undefined && board.status !== 'idle' && board.status !== 'completed'
  const controls = body.add({ type: 'table', column_count: 2 })
  controls.style.horizontal_spacing = COMPACT_BUTTON_SPACING
  controls.style.vertical_spacing = COMPACT_BUTTON_SPACING
  // PAUSE and TERMINATE stay clickable even with no durable goal. They also stop
  // the current world work, which is exactly what a player needs when the
  // runtime is offline and the body is still mining; disabling them left the
  // console with no way to intervene at the moment intervention matters most.
  compact_button(controls.add({ type: 'button', name: PAUSE_BUTTON_NAME, caption: 'PAUSE', style: 'dialog_button', tooltip: has_open_goal && board.status !== 'paused' ? 'Pause the durable AIRI goal and stop current world work' : 'Stop the current world work. There is no durable AIRI goal to pause.' }))
  const armed = task_board_ui_terminate_is_armed(player.index, game.tick)
  compact_button(controls.add({ type: 'button', name: TERMINATE_BUTTON_NAME, caption: armed ? 'CONFIRM' : 'TERMINATE', style: 'red_button', tooltip: armed ? 'Click again within 5 seconds to discard the goal permanently' : has_open_goal ? 'Discard the current durable AIRI goal permanently' : 'Stop the current world work. There is no durable AIRI goal to discard.' }))
  compact_button(controls.add({ type: 'button', name: FOLLOW_BUTTON_NAME, caption: follow_button_caption(follow), style: follow?.active ? 'confirm_button' : 'dialog_button', tooltip: follow_button_tooltip(follow) }))
  const skills_open = task_board_skills_ui_is_open(player.index)
  compact_button(controls.add({ type: 'button', name: SKILLS_BUTTON_NAME, caption: skills_open ? 'CLOSE' : 'LEARN AREA', style: 'dialog_button', tooltip: skills_open ? 'Close the area learning window.' : 'Open area learning and saved skill candidates in a separate movable window.' }))
  // A blank last_failure is still truthy, which drew a lone warning triangle with
  // no message next to it. Render the row only when there is something to read.
  const issue_text = text(follow?.last_failure ?? '', 100)
  if (issue_text.length > 0) { const issue = body.add({ type: 'label', caption: `⚠ ${issue_text}`, tooltip: follow?.last_failure }); issue.style.single_line = false; issue.style.maximal_width = HALF_SECTION_WIDTH - 2 * SECTION_PADDING; issue.style.font_color = TONE_COLORS.bad }
}

/**
 * Usable GUI height for this player, in the units Factorio styles are measured
 * in. `display_resolution` is physical pixels, so it has to be divided by the
 * player's UI scale before it means anything to a style.
 */
export function task_board_gui_height(resolution_height: number, scale: number) {
  const safe_scale = scale > 0 ? scale : 1
  return math.floor(resolution_height / safe_scale)
}

/**
 * How much vertical room the two tracker lists may take, split between them.
 *
 * Clamped at both ends: never shorter than the previous fixed layout, and never
 * so tall that the list stops being a list.
 */
export function task_board_tracker_heights(gui_height: number) {
  const budget = math.max(TRACKER_LIST_MIN_TOTAL, math.min(TRACKER_LIST_MAX_TOTAL, math.floor(gui_height * CONSOLE_SCREEN_FRACTION) - CONSOLE_FIXED_HEIGHT))
  const steps = math.floor(budget * TRACKER_STEPS_SHARE)
  return { steps, activity: budget - steps }
}

/**
 * The camera's floor, which is what keeps the console tall while AIRI has no
 * plan to show and the left column is therefore short.
 */
export function task_board_preview_min_height(gui_height: number) {
  return math.max(PREVIEW_CAMERA_MIN_HEIGHT, math.min(PREVIEW_CAMERA_MAX_HEIGHT, math.floor(gui_height * PREVIEW_CAMERA_SCREEN_FRACTION)))
}

function player_gui_height(player: LuaPlayer) {
  return task_board_gui_height(player.display_resolution.height, player.display_scale)
}

function preview_position_caption(preview: TaskBoardUiWorldPreview) { return `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}` }

/**
 * Updates the preview without rebuilding it.
 *
 * The console refreshes every second, and rebuilding this column destroyed the
 * zoom slider along with it, cancelling a drag in progress. Only the camera and
 * the coordinate label carry live data; the slider holds the player's own state
 * and must survive untouched. Returns false when the structure itself has to
 * change, which is the only case that still warrants a rebuild.
 */
function refresh_world_preview(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot, player: LuaPlayer) {
  const preview = runtime.preview
  if (preview === undefined) return false
  const section = parent[PREVIEW_SECTION_NAME]
  const header = section?.valid ? section[PREVIEW_HEADER_NAME] : undefined
  const body = section?.valid ? section[PREVIEW_BODY_NAME] : undefined
  const frame = body?.valid ? body[PREVIEW_CAMERA_FRAME_NAME] : undefined
  // Keep the element typed: the camera's live properties are read-only on the
  // base union, and casting to `any` would emit the wrong Lua self ABI.
  const camera = frame?.valid ? frame[PREVIEW_CAMERA_NAME] as CameraGuiElement | undefined : undefined
  const position = header?.valid ? header[PREVIEW_POSITION_NAME] : undefined
  if (!frame?.valid || !camera?.valid || !position?.valid) return false

  camera.position = preview.position
  camera.surface_index = preview.surface_index
  if (preview.entity?.valid) camera.entity = preview.entity
  // Follow storage rather than the slider: the slider is the player's input, and
  // writing to it mid-drag is exactly what this refresh must not do.
  camera.zoom = task_board_preview_zoom(player.index)
  position.caption = preview_position_caption(preview)

  const preview_min_height = task_board_preview_min_height(player_gui_height(player))
  frame.style.minimal_height = preview_min_height
  camera.style.minimal_height = preview_min_height
  return true
}

function render_world_preview(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot, player: LuaPlayer) {
  const { header, body } = create_section(parent, 'NPC World Preview', PREVIEW_COLUMN_WIDTH, undefined, true, { section: PREVIEW_SECTION_NAME, header: PREVIEW_HEADER_NAME, body: PREVIEW_BODY_NAME })
  const preview = runtime.preview
  if (preview === undefined) { add_empty_state(body, 'NPC world preview is unavailable.'); return }
  const zoom = task_board_preview_zoom(player.index)
  const preview_min_height = task_board_preview_min_height(player_gui_height(player))
  const position = header.add({ type: 'label', name: PREVIEW_POSITION_NAME, caption: preview_position_caption(preview), style: 'semibold_label' }); position.style.right_padding = 4
  const frame = body.add({ type: 'frame', name: PREVIEW_CAMERA_FRAME_NAME, direction: 'vertical', style: 'deep_frame_in_shallow_frame' })
  frame.style.width = PREVIEW_CAMERA_WIDTH; frame.style.minimal_height = preview_min_height; frame.style.horizontally_stretchable = false; frame.style.vertically_stretchable = true
  const camera = frame.add({ type: 'camera', name: PREVIEW_CAMERA_NAME, position: preview.position, surface_index: preview.surface_index, zoom })
  camera.style.width = PREVIEW_CAMERA_WIDTH; camera.style.minimal_height = preview_min_height; camera.style.horizontally_stretchable = true; camera.style.vertically_stretchable = true
  if (preview.entity?.valid) camera.entity = preview.entity
  const zoom_row = body.add({ type: 'flow', direction: 'horizontal' }); zoom_row.style.horizontally_stretchable = true; zoom_row.style.vertical_align = 'center'; zoom_row.style.horizontal_spacing = 8
  zoom_row.add({ type: 'label', caption: 'ZOOM', style: 'semibold_label' })
  const slider = zoom_row.add({ type: 'slider', name: PREVIEW_ZOOM_SLIDER_NAME, minimum_value: PREVIEW_ZOOM_MIN, maximum_value: PREVIEW_ZOOM_MAX, value: zoom, value_step: PREVIEW_ZOOM_STEP })
  slider.style.horizontally_stretchable = true; slider.style.width = PREVIEW_CAMERA_WIDTH - 100
  const zoom_value = zoom_row.add({ type: 'label', name: PREVIEW_ZOOM_VALUE_NAME, caption: preview_zoom_caption(zoom), style: 'semibold_label' }); zoom_value.style.minimal_width = 46
}

export function task_board_activity_for_display(board: TaskBoardUiSnapshot | undefined): TaskBoardUiActivity[] {
  if (board === undefined) return []
  if (board.activity.length > 0) return board.activity.slice(-MAX_ACTIVITY)
  if (board.status === 'idle') return []
  if (board.steps.length === 0) return [{ kind: 'system', text: `Goal is ${board.status}; no auditable step activity has been recorded yet.` }]
  const index = math.min(board.active_index, board.steps.length - 1); const step = board.steps[index]
  return [{ kind: 'system', text: `Current canonical step ${index + 1}/${board.total_steps}: ${step.description} (${step.status}). Waiting for the next auditable observation, action, or result.` }]
}
function render_tracker(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, player: LuaPlayer) {
  const tracker_heights = task_board_tracker_heights(player_gui_height(player))
  const { header, body } = create_section(parent, 'Plan Tracker / Activity', undefined, 'Canonical plan progress plus timestamped auditable observations, actions, results, blockers, and system events.')
  const activity = task_board_activity_for_display(board); const has_steps = board !== undefined && board.steps.length > 0
  if (has_steps) {
    const active_number = board.status === 'completed' ? board.total_steps : math.min(board.active_index + 1, board.total_steps)
    const summary = header.add({ type: 'label', caption: `STEP ${active_number}/${board.total_steps} · ${board.completed_count} done`, style: 'semibold_label' }); summary.style.right_padding = 4
    const progress = body.add({ type: 'progressbar', value: board.total_steps > 0 ? board.completed_count / board.total_steps : 0 }); progress.style.horizontally_stretchable = true
    const steps_scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' }); steps_scroll.style.maximal_height = tracker_heights.steps; steps_scroll.style.horizontally_stretchable = true
    const steps_grid = steps_scroll.add({ type: 'table', column_count: 4 }); steps_grid.style.horizontal_spacing = 8; steps_grid.style.vertical_spacing = 4
    const visible = board.steps.slice(0, MAX_STEPS); let active_label: LuaGuiElement | undefined
    for (let index = 0; index < visible.length; index++) {
      const step = visible[index]; const tone = step_tone(step)
      steps_grid.add({ type: 'sprite', sprite: TONE_SPRITES[tone], style: 'status_image', tooltip: step.status }); steps_grid.add({ type: 'label', caption: `${index + 1}.`, style: 'semibold_label' })
      const description = steps_grid.add({ type: 'label', caption: step.description, style: step.status === 'active' ? 'bold_label' : 'label' }); description.style.single_line = false; description.style.maximal_width = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 170
      if (step.status === 'completed' || step.status === 'pending') description.style.font_color = TONE_COLORS.muted
      const state = steps_grid.add({ type: 'label', caption: step.status.toUpperCase(), style: 'semibold_label' }); state.style.font_color = TONE_COLORS[tone]; state.style.minimal_width = 72
      if (step.status === 'active' || step.status === 'blocked' || step.status === 'paused') active_label = description
    }
    if (board.steps.length > visible.length) { steps_grid.add({ type: 'empty-widget' }); steps_grid.add({ type: 'label', caption: '+', style: 'semibold_label' }); add_empty_state(steps_grid, `${board.steps.length - visible.length} more steps`); steps_grid.add({ type: 'empty-widget' }) }
    if (active_label !== undefined) steps_scroll.scroll_to_element(active_label, 'top-third')
    if (board.blocker.length > 0 || board.pause_reason.length > 0) { const attention = create_key_value_table(body); const width = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - KEY_COLUMN_WIDTH - 12; if (board.blocker.length > 0) add_key_value(attention, 'BLOCKED', board.blocker, { tone: 'bad', width }); if (board.pause_reason.length > 0) add_key_value(attention, 'PAUSED', board.pause_reason, { tone: 'warn', width }) }
  }
  else if (activity.length === 0) { add_empty_state(body, 'No active plan or recent AIRI activity.'); return }
  const divider = body.add({ type: 'line', direction: 'horizontal' }); divider.style.horizontally_stretchable = true
  const activity_header = body.add({ type: 'flow', direction: 'horizontal' }); activity_header.style.horizontally_stretchable = true; activity_header.add({ type: 'label', caption: 'Recent activity', style: 'bold_label' }); const header_filler = activity_header.add({ type: 'empty-widget' }); header_filler.style.horizontally_stretchable = true; activity_header.add({ type: 'label', caption: `${activity.length} event${activity.length === 1 ? '' : 's'}`, style: 'semibold_label' })
  if (activity.length === 0) { add_empty_state(body, 'No recent AIRI activity yet.'); return }
  const activity_scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' }); activity_scroll.style.maximal_height = tracker_heights.activity; activity_scroll.style.horizontally_stretchable = true
  const activity_grid = activity_scroll.add({ type: 'table', column_count: 3 }); activity_grid.style.horizontal_spacing = 10; activity_grid.style.vertical_spacing = 4
  for (const entry of activity) { const timestamp = activity_grid.add({ type: 'label', caption: entry.timestamp ?? '--:--:--', tooltip: entry.timestamp ? 'Factorio game time when this activity was first observed' : 'No timestamp recorded yet' }); timestamp.style.minimal_width = 66; timestamp.style.font_color = TONE_COLORS.muted; const tag = activity_grid.add({ type: 'label', caption: activity_prefix(entry.kind), style: 'bold_label' }); tag.style.minimal_width = 52; tag.style.font_color = TONE_COLORS[activity_tone(entry.kind)]; const line = activity_grid.add({ type: 'label', caption: entry.text }); line.style.single_line = false; line.style.maximal_width = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 160 }
  activity_scroll.scroll_to_bottom()
}
function add_slot_grid(parent: LuaGuiElement, slots: Array<{ name: string, count: number, tooltip: string }>, style: 'slot_button' | 'yellow_slot_button') {
  const scroll = parent.add({ type: 'scroll-pane', style: 'deep_slots_scroll_pane', horizontal_scroll_policy: 'never', vertical_scroll_policy: 'auto-and-reserve-space' }); scroll.style.width = SLOT_COLUMNS * SLOT_SIZE + SCROLLBAR_WIDTH; scroll.style.height = SLOT_ROWS * SLOT_SIZE
  const grid = scroll.add({ type: 'table', column_count: SLOT_COLUMNS, style: 'slot_table' }); for (const slot of slots) grid.add({ type: 'sprite-button', sprite: item_sprite(slot.name), number: slot.count, style, tooltip: slot.tooltip })
}
function render_inventory(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot) { const { header, body } = create_section(parent, 'NPC Inventory', HALF_SECTION_WIDTH, undefined, false); if (runtime.inventory.length === 0) { add_empty_state(body, 'Inventory is empty.'); return }; header.add({ type: 'label', caption: `${runtime.inventory.length} items`, style: 'semibold_label' }); add_slot_grid(body, runtime.inventory.map(item => ({ name: item.name, count: item.count, tooltip: `${item_caption(item.name)} × ${item.count}` })), 'slot_button') }
function render_wanted_items(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) { const { header, body } = create_section(parent, 'Wanted / Needed', HALF_SECTION_WIDTH, undefined, false); if (board === undefined || board.wanted_items.length === 0) { add_empty_state(body, 'Nothing currently requested.'); return }; header.add({ type: 'label', caption: `${board.wanted_items.length} items`, style: 'semibold_label' }); add_slot_grid(body, board.wanted_items.slice(0, MAX_WANTED_ITEMS).map(item => ({ name: item.name, count: item.count, tooltip: item.reason.length > 0 ? `${item_caption(item.name)} × ${item.count} — ${item.reason}` : `${item_caption(item.name)} × ${item.count}` })), 'yellow_slot_button') }
function render_prompt(parent: LuaGuiElement, player: LuaPlayer) {
  const section = parent.add({ type: 'frame', name: PROMPT_SECTION_NAME, direction: 'vertical', style: 'inside_shallow_frame' }); section.style.width = LEFT_COLUMN_WIDTH; section.style.horizontally_stretchable = false
  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' }); header.style.horizontally_stretchable = true; header.style.vertical_align = 'center'; header.add({ type: 'label', caption: 'Prompt AIRI', style: 'subheader_caption_label' })
  const row = section.add({ type: 'flow', name: PROMPT_FLOW_NAME, direction: 'horizontal' }); row.style.padding = SECTION_PADDING; row.style.horizontally_stretchable = true; row.style.vertical_align = 'center'; row.style.horizontal_spacing = 8
  const field = row.add({ type: 'textfield', name: PROMPT_FIELD_NAME, text: task_board_ui_prompt_draft(player.index), tooltip: 'Send a prompt directly to AIRI without typing !airi in chat. Press Enter to send.' }); field.style.width = PROMPT_FIELD_WIDTH; field.style.minimal_width = 0; field.style.maximal_width = PROMPT_FIELD_WIDTH
  const send = row.add({ type: 'button', name: PROMPT_SEND_BUTTON_NAME, caption: 'SEND', style: 'confirm_button', tooltip: 'Send this prompt directly to AIRI' }); send.style.width = PROMPT_SEND_WIDTH; send.style.minimal_width = PROMPT_SEND_WIDTH; send.style.height = COMPACT_BUTTON_HEIGHT
}
function render_titlebar(root: FrameGuiElement, caption = 'AIRI NPC Console', close_name = CLOSE_BUTTON_NAME) {
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' }); titlebar.style.horizontally_stretchable = true; titlebar.style.horizontal_spacing = 8; titlebar.drag_target = root
  titlebar.add({ type: 'label', caption, style: 'frame_title', ignored_by_interaction: true }); const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true }); dragger.style.horizontally_stretchable = true; dragger.style.height = 24
  titlebar.add({ type: 'sprite-button', name: close_name, sprite: 'utility/close', style: 'frame_action_button', tooltip: `Close ${caption}` })
}
function build_left_dynamic(parent: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, synced_tick: number | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const top = parent.add({ type: 'flow', direction: 'horizontal' }); top.style.horizontal_spacing = COLUMN_SPACING; top.style.vertical_align = 'top'; render_status_panel(top, board, runtime, synced_tick); render_controls_panel(top, player, board, runtime)
  render_tracker(parent, board, player)
}
function build_columns(columns: LuaGuiElement, player: LuaPlayer) {
  const board = storage.airi_task_board_ui; const synced_tick = storage.airi_task_board_ui_synced_tick; const runtime = runtime_snapshot()
  const left = columns.add({ type: 'flow', name: LEFT_COLUMN_NAME, direction: 'vertical' }); left.style.width = LEFT_COLUMN_WIDTH; left.style.vertical_spacing = COLUMN_SPACING
  const dynamic = left.add({ type: 'flow', name: LEFT_DYNAMIC_NAME, direction: 'vertical' }); dynamic.style.width = LEFT_COLUMN_WIDTH; dynamic.style.vertical_spacing = COLUMN_SPACING; build_left_dynamic(dynamic, player, board, synced_tick, runtime); render_prompt(left, player)
  const right = columns.add({ type: 'flow', name: RIGHT_COLUMN_NAME, direction: 'vertical' }); right.style.width = PREVIEW_COLUMN_WIDTH; right.style.vertical_spacing = COLUMN_SPACING; right.style.vertically_stretchable = true; render_world_preview(right, runtime, player)
  const resources = right.add({ type: 'flow', name: RIGHT_RESOURCES_NAME, direction: 'horizontal' }); resources.style.horizontal_spacing = COLUMN_SPACING; render_inventory(resources, runtime); render_wanted_items(resources, board)
}
function refresh_columns(columns: LuaGuiElement, player: LuaPlayer) {
  const left = columns[LEFT_COLUMN_NAME]; const dynamic = left?.valid ? left[LEFT_DYNAMIC_NAME] : undefined; const right = columns[RIGHT_COLUMN_NAME]
  if (!dynamic?.valid || !right?.valid) return false
  const board = storage.airi_task_board_ui; const synced_tick = storage.airi_task_board_ui_synced_tick; const runtime = runtime_snapshot()
  dynamic.clear(); build_left_dynamic(dynamic, player, board, synced_tick, runtime)
  // Never clear the preview column on a routine refresh: it owns the zoom slider.
  const resources = right[RIGHT_RESOURCES_NAME]
  if (!refresh_world_preview(right, runtime, player) || !resources?.valid) {
    right.clear()
    render_world_preview(right, runtime, player)
    const rebuilt_resources = right.add({ type: 'flow', name: RIGHT_RESOURCES_NAME, direction: 'horizontal' }); rebuilt_resources.style.horizontal_spacing = COLUMN_SPACING; render_inventory(rebuilt_resources, runtime); render_wanted_items(rebuilt_resources, board)
    return true
  }
  resources.clear(); render_inventory(resources, runtime); render_wanted_items(resources, board)
  return true
}
function build_panel(player: LuaPlayer) {
  const previous_location = destroy_panel(player)
  const root = player.gui.screen.add({ type: 'frame', name: ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  render_titlebar(root)
  const columns = root.add({ type: 'flow', name: COLUMNS_NAME, direction: 'horizontal' }); columns.style.horizontal_spacing = COLUMN_SPACING; build_columns(columns, player); root.bring_to_front()
}
function render_panel(player: LuaPlayer) {
  if (!task_board_ui_is_open(player.index)) { destroy_panel(player); return }
  const root = player.gui.screen[ROOT_NAME]; const columns = root?.valid ? root[COLUMNS_NAME] : undefined
  if (columns?.valid && refresh_columns(columns, player)) return
  build_panel(player)
}
function destroy_skills_popout(player: LuaPlayer) { const existing = player.gui.screen[SKILLS_ROOT_NAME]; const location = existing?.valid ? existing.location : undefined; if (existing?.valid) existing.destroy(); return location }
function build_skills_body(body: LuaGuiElement) { render_learning_status(body); const actions = body.add({ type: 'flow', direction: 'horizontal' }); actions.style.horizontally_stretchable = true; render_learn_area_button(actions); render_skill_export_section(body) }
function build_skills_popout(player: LuaPlayer) {
  const previous_location = destroy_skills_popout(player)
  const root = player.gui.screen.add({ type: 'frame', name: SKILLS_ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  render_titlebar(root, SKILLS_POPOUT_TITLE, SKILLS_CLOSE_BUTTON_NAME)
  const body = root.add({ type: 'flow', name: SKILLS_BODY_NAME, direction: 'vertical' }); body.style.width = SKILLS_POPOUT_WIDTH; body.style.vertical_spacing = 6; build_skills_body(body); root.bring_to_front()
}
function render_skills_popout(player: LuaPlayer) { if (!task_board_ui_is_open(player.index) || !task_board_skills_ui_is_open(player.index)) { destroy_skills_popout(player); return }; const root = player.gui.screen[SKILLS_ROOT_NAME]; const body = root?.valid ? root[SKILLS_BODY_NAME] : undefined; if (body?.valid) { body.clear(); build_skills_body(body); return }; build_skills_popout(player) }
function render(player: LuaPlayer) { ensure_button(player); render_panel(player); render_skills_popout(player) }
function render_all() { for (const player of game.connected_players) { ensure_button(player); render_panel(player); render_skills_popout(player) } }
function prompt_field(player: LuaPlayer) { const root = player.gui.screen[ROOT_NAME]; const columns = root?.valid ? root[COLUMNS_NAME] : undefined; const left = columns?.valid ? columns[LEFT_COLUMN_NAME] : undefined; const section = left?.valid ? left[PROMPT_SECTION_NAME] : undefined; const row = section?.valid ? section[PROMPT_FLOW_NAME] : undefined; const field = row?.valid ? row[PROMPT_FIELD_NAME] : undefined; return field?.valid ? field as TextFieldGuiElement : undefined }
function submit_prompt(player: LuaPlayer, raw: unknown) { if (!emit_prompt(player, raw)) return false; const field = prompt_field(player); if (field !== undefined) field.text = ''; render_panel(player); return true }
function handle_control_click(player: LuaPlayer, element_name: string) {
  if (element_name === PAUSE_BUTTON_NAME) { clear_terminate_confirmation(player.index); emit_control(player, 'pause'); return true }
  if (element_name === TERMINATE_BUTTON_NAME) { if (task_board_ui_terminate_is_armed(player.index, game.tick)) { clear_terminate_confirmation(player.index); emit_control(player, 'terminate') } else { arm_terminate(player.index); render_panel(player) }; return true }
  if (element_name === FOLLOW_BUTTON_NAME) { clear_terminate_confirmation(player.index); const follow = read_follow_status(); emit_control(player, follow?.active ? 'stop_follow' : 'follow'); return true }
  if (element_name === PROMPT_SEND_BUTTON_NAME) { submit_prompt(player, task_board_ui_prompt_draft(player.index)); return true }
  return false
}

export function create_task_board_ui_remote_interface() {
  create_skill_remote_interface(); create_learning_remote_interface()
  remote.add_interface('autorio_task_board', {
    set_snapshot: (value: unknown) => { const next = sanitize_task_board_ui_snapshot(value); if (next === undefined) return false; const previous = storage.airi_task_board_ui; const stamped = stamp_activity_times(next, previous, game.tick); storage.airi_task_board_ui = stamped; storage.airi_task_board_ui_synced_tick = game.tick; try { handle_task_board_learning_transition(previous, stamped) } catch (error) { log(`[AIRI learning] completion learning skipped: ${error instanceof Error ? error.message : 'unknown error'}`) }; render_all(); return true },
    clear: () => { storage.airi_task_board_ui = undefined; storage.airi_task_board_ui_synced_tick = game.tick; render_all(); return true },
    status: () => storage.airi_task_board_ui,
    drain_inputs: () => drain_ui_inputs(),
  })
  script.on_event(defines.events.on_player_joined_game, (event: any) => { const player = game.get_player(event.player_index); if (player?.valid) render(player) })
  script.on_event(defines.events.on_gui_click, (event: any) => {
    const element = event.element; if (!element?.valid) return; const player = game.get_player(event.player_index); if (!player?.valid) return
    if (element.name === BUTTON_NAME) { toggle_task_board_ui_open(player.index); render(player); return }
    if (element.name === CLOSE_BUTTON_NAME) { clear_terminate_confirmation(player.index); close_task_board_ui(player.index); close_task_board_skills_ui(player.index); destroy_skills_popout(player); destroy_panel(player); ensure_button(player); return }
    if (element.name === SKILLS_BUTTON_NAME) { toggle_task_board_skills_ui_open(player.index); render_panel(player); render_skills_popout(player); return }
    if (element.name === SKILLS_CLOSE_BUTTON_NAME) { close_task_board_skills_ui(player.index); destroy_skills_popout(player); render_panel(player); return }
    if (handle_learning_ui_click(player, element.name)) { render_skills_popout(player); return }
    if (handle_skill_export_click(player, element.name)) { render_skills_popout(player); return }
    handle_control_click(player, element.name)
  })
  script.on_event(defines.events.on_gui_text_changed, (event: any) => { const element = event.element; if (!element?.valid || element.name !== PROMPT_FIELD_NAME) return; set_prompt_draft(event.player_index, element.text) })
  script.on_event(defines.events.on_gui_confirmed, (event: any) => { const element = event.element; if (!element?.valid || element.name !== PROMPT_FIELD_NAME) return; const player = game.get_player(event.player_index); if (!player?.valid) return; submit_prompt(player, element.text) })
  script.on_event(defines.events.on_gui_value_changed, (event: any) => {
    const element = event.element; if (!element?.valid || element.name !== PREVIEW_ZOOM_SLIDER_NAME) return; const player = game.get_player(event.player_index); if (!player?.valid) return
    const zoom = set_preview_zoom(player.index, element.slider_value); element.slider_value = zoom
    const row = element.parent; const value = row?.valid ? row[PREVIEW_ZOOM_VALUE_NAME] : undefined; if (value?.valid) value.caption = preview_zoom_caption(zoom)
    const body = row?.parent; const frame = body?.valid ? body[PREVIEW_CAMERA_FRAME_NAME] : undefined; const camera = frame?.valid ? frame[PREVIEW_CAMERA_NAME] : undefined; if (camera?.valid) camera.zoom = zoom
  })
  script.on_nth_tick(60, () => { for (const player of game.connected_players) { if (!task_board_ui_is_open(player.index)) continue; render_panel(player); render_skills_popout(player) } })
}
