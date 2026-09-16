import type { MapPositionStruct } from 'factorio:prototype'
import type { FrameGuiElement, LuaEntity, LuaGuiElement, LuaPlayer, LuaSurface, SpriteButtonGuiElement, SpritePath, TextFieldGuiElement } from 'factorio:runtime'

import { peek_controlled_actor } from './actors/actor_controller'
import { create_skill_remote_interface, handle_skill_export_click, render_learn_area_button, render_skill_export_section } from './skills'
import { get_actor_inventory_items } from './utils/inventory'

const BUTTON_NAME = 'airi_task_board_button'
// Same element names as core/lualib/mod-gui.lua so the button shares the
// vanilla top-left mod button bar with other mods.
const MOD_GUI_LEGACY_FLOW_NAME = 'mod_gui_button_flow'
const MOD_GUI_TOP_FRAME_NAME = 'mod_gui_top_frame'
const MOD_GUI_INNER_FRAME_NAME = 'mod_gui_inner_frame'
const ROOT_NAME = 'airi_task_board_panel'
const COLUMNS_NAME = 'airi_task_board_columns'
const PROMPT_SECTION_NAME = 'airi_task_board_prompt_section'
const PROMPT_FLOW_NAME = 'airi_task_board_prompt_flow'
// Area learning lives in its own movable window: its results and the saved
// candidate list are tall, and inlining them stretched the whole console.
const SKILLS_ROOT_NAME = 'airi_task_board_skills_panel'
const SKILLS_BODY_NAME = 'airi_task_board_skills_body'
const SKILLS_BUTTON_NAME = 'airi_task_board_skills'
const SKILLS_CLOSE_BUTTON_NAME = 'airi_task_board_skills_close'
const SKILLS_POPOUT_TITLE = 'Area Learning & Skills'
// A logistic robot reads as "assistant working for you" in the mod button bar,
// where a plain character icon looks like another player.
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
const STEPS_LIST_HEIGHT = 104
const ACTIVITY_LIST_HEIGHT = 104
const PREVIEW_MIN_HEIGHT = 360
const PREVIEW_ZOOM = 0.75
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

export interface TaskBoardUiStep {
  id: string
  description: string
  status: 'pending' | 'active' | 'completed' | 'blocked' | 'paused'
}

export interface TaskBoardUiActivity {
  kind: TaskBoardUiActivityKind
  text: string
}

export interface TaskBoardUiWantedItem {
  name: string
  count: number
  reason: string
}

export interface TaskBoardUiAgentStatus {
  phase: TaskBoardUiAgentPhase
  detail: string
}

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

interface TaskBoardUiFollowStatus {
  active: boolean
  state: string
  target_player: string
  current_distance?: number
  desired_distance?: number
  last_failure: string
}

interface TaskBoardUiWorldPreview {
  position: MapPositionStruct
  surface_index: LuaSurface['index']
  entity?: LuaEntity
}

interface TaskBoardUiWorldTask {
  task_state: string
  queue_length: number
}

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
}

let world_task_provider: ((this: void) => unknown) | undefined

// The mod-side task queue is live world state that does not depend on the
// external AIRI runtime pushing snapshots, so the console reads it directly.
export function set_task_board_world_task_provider(provider: (this: void) => unknown) {
  world_task_provider = provider
}

function text(value: unknown, max = MAX_TEXT) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}

function integer(value: unknown, fallback = 0) {
  return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback
}

function positive_integer(value: unknown, fallback = 1) {
  const parsed = integer(value, fallback)
  return math.max(1, parsed)
}

function status(value: unknown): TaskBoardUiSnapshot['status'] {
  if (value === 'idle' || value === 'blocked' || value === 'paused' || value === 'completed') return value
  return 'active'
}

function step_status(value: unknown): TaskBoardUiStep['status'] {
  if (value === 'active' || value === 'completed' || value === 'blocked' || value === 'paused') return value
  return 'pending'
}

function activity_kind(value: unknown): TaskBoardUiActivityKind {
  if (value === 'observation' || value === 'decision' || value === 'action' || value === 'result' || value === 'blocker' || value === 'system') return value
  return 'note'
}

function agent_phase(value: unknown): TaskBoardUiAgentPhase {
  if (value === 'thinking' || value === 'observing' || value === 'executing' || value === 'waiting' || value === 'error') return value
  return 'idle'
}

export function sanitize_task_board_ui_snapshot(value: any): TaskBoardUiSnapshot | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || !Array.isArray(value.steps)) return undefined
  const steps = value.steps.slice(0, 30).map((step: any, index: number) => ({
    id: text(step?.id || `step_${index + 1}`, 80),
    description: text(step?.description, MAX_TEXT),
    status: step_status(step?.status),
  })).filter((step: TaskBoardUiStep) => step.description.length > 0)
  const activity = (Array.isArray(value.activity) ? value.activity : []).slice(-MAX_ACTIVITY).map((entry: any) => ({
    kind: activity_kind(entry?.kind),
    text: text(entry?.text, 1000),
  })).filter((entry: TaskBoardUiActivity) => entry.text.length > 0)
  const wanted_items = (Array.isArray(value.wanted_items) ? value.wanted_items : []).slice(0, MAX_WANTED_ITEMS).map((item: any) => ({
    name: text(item?.name, 200),
    count: positive_integer(item?.count, 1),
    reason: text(item?.reason, 300),
  })).filter((item: TaskBoardUiWantedItem) => item.name.length > 0)
  const total = integer(value.total_steps, steps.length)
  const agent = value.agent !== null && typeof value.agent === 'object' ? value.agent : undefined
  return {
    goal_id: text(value.goal_id, 100),
    objective: text(value.objective, 500),
    status: status(value.status),
    blocker: text(value.blocker, 500),
    pause_reason: text(value.pause_reason, 300),
    completed_count: math.min(integer(value.completed_count), total),
    total_steps: total,
    active_index: math.min(integer(value.active_index), math.max(0, total - 1)),
    steps,
    activity,
    wanted_items,
    agent: {
      phase: agent_phase(agent?.phase),
      detail: text(agent?.detail, 300),
    },
  }
}

// `storage` is synchronized game state. Reads happen while rendering, which runs
// on every multiplayer peer, so they must never lazily create their table: only
// the replicated input handlers below are allowed to write.
function ensure_open_state() {
  if (storage.airi_task_board_ui_open === undefined) storage.airi_task_board_ui_open = {}
  return storage.airi_task_board_ui_open
}

function ensure_terminate_confirm_state() {
  if (storage.airi_task_board_terminate_confirm_until === undefined) storage.airi_task_board_terminate_confirm_until = {}
  return storage.airi_task_board_terminate_confirm_until
}

function ensure_prompt_draft_state() {
  if (storage.airi_task_board_prompt_draft === undefined) storage.airi_task_board_prompt_draft = {}
  return storage.airi_task_board_prompt_draft
}

export function task_board_ui_prompt_draft(player_index: number) {
  return storage.airi_task_board_prompt_draft?.[player_index] ?? ''
}

function set_prompt_draft(player_index: number, value: unknown) {
  ensure_prompt_draft_state()[player_index] = text(value, MAX_PROMPT_TEXT)
}

export function task_board_ui_is_open(player_index: number) {
  return storage.airi_task_board_ui_open?.[player_index] === true
}

export function toggle_task_board_ui_open(player_index: number) {
  const next = !task_board_ui_is_open(player_index)
  ensure_open_state()[player_index] = next
  return next
}

function close_task_board_ui(player_index: number) {
  ensure_open_state()[player_index] = false
}

function ensure_skills_open_state() {
  if (storage.airi_task_board_skills_open === undefined) storage.airi_task_board_skills_open = {}
  return storage.airi_task_board_skills_open
}

export function task_board_skills_ui_is_open(player_index: number) {
  return storage.airi_task_board_skills_open?.[player_index] === true
}

export function toggle_task_board_skills_ui_open(player_index: number) {
  const next = !task_board_skills_ui_is_open(player_index)
  ensure_skills_open_state()[player_index] = next
  return next
}

function close_task_board_skills_ui(player_index: number) {
  ensure_skills_open_state()[player_index] = false
}

export function task_board_ui_terminate_is_armed(player_index: number, tick: number) {
  return (storage.airi_task_board_terminate_confirm_until?.[player_index] ?? 0) >= tick
}

function clear_terminate_confirmation(player_index: number) {
  ensure_terminate_confirm_state()[player_index] = 0
}

function arm_terminate(player_index: number) {
  ensure_terminate_confirm_state()[player_index] = game.tick + TERMINATE_CONFIRM_TICKS
}

function mod_gui_button_flow(player: LuaPlayer): LuaGuiElement {
  const top = player.gui.top
  const legacy = top[MOD_GUI_LEGACY_FLOW_NAME]
  if (legacy?.valid) return legacy
  const frame = top[MOD_GUI_TOP_FRAME_NAME] ?? top.add({
    type: 'frame',
    name: MOD_GUI_TOP_FRAME_NAME,
    direction: 'horizontal',
    style: 'slot_window_frame',
  })
  return frame[MOD_GUI_INNER_FRAME_NAME] ?? frame.add({
    type: 'frame',
    name: MOD_GUI_INNER_FRAME_NAME,
    direction: 'horizontal',
    style: 'mod_gui_inside_deep_frame',
  })
}

function ensure_button(player: LuaPlayer) {
  // Remove the old text button that was added directly to gui.top.
  const legacy = player.gui.top[BUTTON_NAME]
  if (legacy?.valid) legacy.destroy()

  const flow = mod_gui_button_flow(player)
  const existing = flow[BUTTON_NAME]
  const button = (existing?.valid
    ? existing
    : flow.add({
        type: 'sprite-button',
        name: BUTTON_NAME,
        sprite: BUTTON_SPRITE,
        style: 'slot_button',
        tooltip: 'AIRI NPC Console',
      })) as SpriteButtonGuiElement
  button.toggled = task_board_ui_is_open(player.index)
  return button
}

function destroy_panel(player: LuaPlayer) {
  const existing = player.gui.screen[ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()

  // Clean up the legacy left-side panel when upgrading an already-running save.
  const legacy = player.gui.left[ROOT_NAME]
  if (legacy?.valid) legacy.destroy()
  return location
}

function step_tone(step: TaskBoardUiStep): Tone {
  if (step.status === 'completed') return 'good'
  if (step.status === 'active') return 'info'
  if (step.status === 'blocked') return 'bad'
  if (step.status === 'paused') return 'warn'
  return 'muted'
}

function activity_prefix(kind: TaskBoardUiActivityKind) {
  if (kind === 'observation') return 'OBS'
  if (kind === 'decision') return 'PLAN'
  if (kind === 'action') return 'ACT'
  if (kind === 'result') return 'RESULT'
  if (kind === 'blocker') return 'BLOCK'
  if (kind === 'system') return 'SYS'
  return 'NOTE'
}

function activity_tone(kind: TaskBoardUiActivityKind): Tone {
  if (kind === 'decision' || kind === 'observation') return 'info'
  if (kind === 'action' || kind === 'result') return 'good'
  if (kind === 'blocker') return 'bad'
  if (kind === 'system') return 'warn'
  return 'muted'
}

function board_tone(board_status: TaskBoardUiSnapshot['status']): Tone {
  if (board_status === 'active') return 'good'
  if (board_status === 'completed') return 'info'
  if (board_status === 'paused') return 'warn'
  if (board_status === 'blocked') return 'bad'
  return 'muted'
}

function agent_tone(phase: TaskBoardUiAgentPhase): Tone {
  if (phase === 'thinking' || phase === 'observing') return 'info'
  if (phase === 'executing') return 'good'
  if (phase === 'waiting') return 'warn'
  if (phase === 'error') return 'bad'
  return 'muted'
}

function agent_caption(phase: TaskBoardUiAgentPhase) {
  if (phase === 'thinking') return 'THINKING'
  if (phase === 'observing') return 'OBSERVING'
  if (phase === 'executing') return 'EXECUTING'
  if (phase === 'waiting') return 'WORKING'
  if (phase === 'error') return 'ERROR'
  return 'IDLE'
}

function item_caption(name: string) {
  const item_prototypes = prototypes.item
  if (item_prototypes !== undefined && item_prototypes[name] !== undefined) return `[item=${name}] ${name}`
  return name
}

function item_sprite(name: string): SpritePath {
  const item: SpritePath = `item/${name}`
  if (helpers.is_valid_sprite_path(item)) return item
  const entity: SpritePath = `entity/${name}`
  if (helpers.is_valid_sprite_path(entity)) return entity
  return 'utility/questionmark'
}

function read_follow_status(): TaskBoardUiFollowStatus | undefined {
  if (remote.interfaces?.autorio_follow === undefined || typeof remote.call !== 'function') return undefined
  const raw = remote.call('autorio_follow', 'status') as any
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  return {
    active: raw.active === true,
    state: text(raw.state, 32),
    target_player: text(raw.target_player ?? raw.player_name, 128),
    current_distance: typeof raw.current_distance === 'number' ? raw.current_distance : undefined,
    desired_distance: typeof raw.desired_distance === 'number' ? raw.desired_distance : undefined,
    last_failure: text(raw.last_failure ?? raw.blocked_reason, 300),
  }
}

function read_world_task(): TaskBoardUiWorldTask | undefined {
  if (world_task_provider === undefined) return undefined
  const raw = world_task_provider() as any
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  return {
    task_state: text(raw.task_state, 48),
    queue_length: integer(raw.queue_length),
  }
}

// Rendering must stay read-only: this runs on every connected peer.
function runtime_snapshot(): TaskBoardUiRuntimeSnapshot {
  const actor = peek_controlled_actor()
  const identity = actor?.status_snapshot()
  const inventory = actor ? get_actor_inventory_items(actor) : []
  inventory.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const preview: TaskBoardUiWorldPreview | undefined = actor?.is_valid
    ? {
        position: actor.position,
        surface_index: actor.surface.index,
        entity: actor.character?.valid ? actor.character : undefined,
      }
    : undefined
  return {
    actor_name: text(identity?.name ?? 'AIRI', 128),
    actor_kind: text(identity?.kind ?? '', 64),
    inventory: inventory.slice(0, MAX_INVENTORY_ITEMS),
    follow: read_follow_status(),
    preview,
    world_task: read_world_task(),
  }
}

function emit_control(player: LuaPlayer, action: TaskBoardUiControlAction) {
  const payload = helpers.table_to_json({
    version: 1,
    action,
    player_index: player.index,
    player_name: player.name,
    tick: game.tick,
  })
  log(`[AIRI_UI_CONTROL] ${payload}`)
}

function emit_prompt(player: LuaPlayer, raw: unknown) {
  const prompt = text(raw, MAX_PROMPT_TEXT)
  if (prompt.length === 0) return false
  const payload = helpers.table_to_json({
    version: 1,
    player_index: player.index,
    player_name: player.name,
    text: prompt,
    tick: game.tick,
  })
  log(`[AIRI_UI_PROMPT] ${payload}`)
  set_prompt_draft(player.index, '')
  return true
}

function create_section(parent: LuaGuiElement, title: string, width?: number, tooltip?: string) {
  const section = parent.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame' })
  if (width !== undefined) section.style.width = width
  else section.style.horizontally_stretchable = true
  section.style.vertically_stretchable = true

  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: title, style: 'subheader_caption_label', tooltip })
  const filler = header.add({ type: 'empty-widget' })
  filler.style.horizontally_stretchable = true

  const body = section.add({ type: 'flow', direction: 'vertical' })
  body.style.horizontally_stretchable = true
  body.style.vertically_stretchable = true
  body.style.padding = SECTION_PADDING
  body.style.vertical_spacing = 6
  return { header, body }
}

function add_status_badge(parent: LuaGuiElement, tone: Tone, caption: string) {
  const badge = parent.add({ type: 'flow', direction: 'horizontal' })
  badge.style.vertical_align = 'center'
  badge.style.horizontal_spacing = 4
  badge.style.right_padding = 4
  badge.add({ type: 'sprite', sprite: TONE_SPRITES[tone], style: 'status_image' })
  const label = badge.add({ type: 'label', caption, style: 'bold_label' })
  label.style.font_color = TONE_COLORS[tone]
  return badge
}

function create_key_value_table(parent: LuaGuiElement) {
  const table = parent.add({ type: 'table', column_count: 2 })
  table.style.horizontal_spacing = 12
  table.style.vertical_spacing = 4
  return table
}

function add_key_value(table: LuaGuiElement, key: string, value: string, options: { tone?: Tone, tooltip?: string, width?: number } = {}) {
  const key_label = table.add({ type: 'label', caption: key, style: 'semibold_label' })
  key_label.style.minimal_width = KEY_COLUMN_WIDTH
  const value_label = table.add({ type: 'label', caption: value, tooltip: options.tooltip })
  value_label.style.single_line = false
  if (options.width !== undefined) value_label.style.maximal_width = options.width
  if (options.tone !== undefined) value_label.style.font_color = TONE_COLORS[options.tone]
  return value_label
}

function add_empty_state(parent: LuaGuiElement, caption: string) {
  const label = parent.add({ type: 'label', caption })
  label.style.font_color = TONE_COLORS.muted
  return label
}

function board_goal(board: TaskBoardUiSnapshot) {
  if (board.objective.length > 0) return board.objective
  if (board.goal_id.length > 0) return board.goal_id
  return board.status === 'idle' ? 'No active AIRI task.' : 'Current task'
}

function sync_summary(synced_tick: number | undefined) {
  if (synced_tick === undefined) return 'Never — AIRI runtime not connected'
  const seconds = math.floor(math.max(0, game.tick - synced_tick) / 60)
  if (seconds < 60) return `${seconds}s ago`
  return `${math.floor(seconds / 60)}m ago`
}

function world_task_summary(task: TaskBoardUiWorldTask | undefined) {
  if (task === undefined) return 'UNKNOWN'
  const state = task.task_state.length > 0 ? task.task_state.split('_').join(' ').toUpperCase() : 'IDLE'
  return task.queue_length > 0 ? `${state} · ${task.queue_length} queued` : state
}

function overall_state(board: TaskBoardUiSnapshot | undefined, synced_tick: number | undefined): { tone: Tone, caption: string } {
  if (board === undefined) return { tone: 'muted', caption: synced_tick === undefined ? 'OFFLINE' : 'IDLE' }
  if (board.status === 'idle') return { tone: agent_tone(board.agent.phase), caption: agent_caption(board.agent.phase) }
  return { tone: board_tone(board.status), caption: board.status.toUpperCase() }
}

function render_status_panel(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot, synced_tick: number | undefined) {
  const { header, body } = create_section(parent, 'Status', HALF_SECTION_WIDTH)
  const overall = overall_state(board, synced_tick)
  add_status_badge(header, overall.tone, overall.caption)

  const table = create_key_value_table(body)
  add_key_value(table, 'NPC', runtime.actor_name || 'AIRI', {
    tooltip: runtime.actor_kind.length > 0 ? runtime.actor_kind.split('_').join(' ') : undefined,
    width: HALF_VALUE_WIDTH,
  })

  const phase = board?.agent.phase ?? 'idle'
  const detail = board?.agent.detail ?? ''
  add_key_value(table, 'AIRI', detail.length > 0 ? `${agent_caption(phase)} · ${text(detail, 90)}` : agent_caption(phase), {
    tone: agent_tone(phase),
    tooltip: detail.length > 0 ? detail : undefined,
    width: HALF_VALUE_WIDTH,
  })
  add_key_value(table, 'WORLD', world_task_summary(runtime.world_task), { width: HALF_VALUE_WIDTH })

  const goal = board === undefined ? 'No active AIRI task.' : board_goal(board)
  add_key_value(table, 'GOAL', text(goal, 110), { tooltip: goal, width: HALF_VALUE_WIDTH })
  add_key_value(table, 'SYNC', sync_summary(synced_tick), { tone: 'muted', width: HALF_VALUE_WIDTH })
}

function follow_summary(follow: TaskBoardUiFollowStatus | undefined) {
  if (!follow?.active) return 'STOPPED'
  const target = follow.target_player.length > 0 ? ` ${follow.target_player}` : ''
  const distance = follow.current_distance !== undefined ? ` · ${math.floor(follow.current_distance * 10) / 10} tiles` : ''
  return `${follow.state.toUpperCase() || 'ACTIVE'}${target}${distance}`
}

function render_controls_panel(parent: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const { header, body } = create_section(parent, 'Controls', HALF_SECTION_WIDTH)
  const follow = runtime.follow
  add_status_badge(header, follow?.active ? 'good' : 'muted', follow?.active ? 'FOLLOWING' : 'FREE')

  const follow_table = create_key_value_table(body)
  add_key_value(follow_table, 'FOLLOW', follow_summary(follow), { width: HALF_VALUE_WIDTH })
  if (follow?.last_failure) {
    add_key_value(follow_table, 'ISSUE', text(follow.last_failure, 90), { tone: 'bad', tooltip: follow.last_failure, width: HALF_VALUE_WIDTH })
  }

  const spacer = body.add({ type: 'empty-widget' })
  spacer.style.vertically_stretchable = true

  const has_open_goal = board !== undefined && board.status !== 'idle' && board.status !== 'completed'
  const task_controls = body.add({ type: 'flow', direction: 'horizontal' })
  task_controls.style.horizontal_spacing = 8
  task_controls.style.horizontally_stretchable = true
  const pause = task_controls.add({
    type: 'button',
    name: PAUSE_BUTTON_NAME,
    caption: 'PAUSE',
    style: 'dialog_button',
    tooltip: 'Pause the durable AIRI goal and stop current world work',
  })
  pause.style.minimal_width = 0
  pause.style.horizontally_stretchable = true
  pause.enabled = has_open_goal && board.status !== 'paused'

  const armed = task_board_ui_terminate_is_armed(player.index, game.tick)
  const terminate = task_controls.add({
    type: 'button',
    name: TERMINATE_BUTTON_NAME,
    caption: armed ? 'CONFIRM' : 'TERMINATE',
    style: 'red_button',
    tooltip: armed ? 'Click again within 5 seconds to discard the goal permanently' : 'Discard the current durable AIRI goal permanently',
  })
  terminate.style.minimal_width = 0
  terminate.style.horizontally_stretchable = true
  terminate.enabled = has_open_goal

  const follow_button = body.add({
    type: 'button',
    name: FOLLOW_BUTTON_NAME,
    caption: follow?.active ? 'STOP FOLLOW' : 'FOLLOW ME',
    style: follow?.active ? 'red_button' : 'confirm_button',
    tooltip: follow?.active ? 'Stop the persistent follow controller' : 'Pause current work and follow this player',
  })
  follow_button.style.minimal_width = 0
  follow_button.style.horizontally_stretchable = true

  // Only the entry point lives here. The analysis output and saved candidate
  // list open in their own window so they cost the console no space at all.
  const skills_button = body.add({
    type: 'button',
    name: SKILLS_BUTTON_NAME,
    caption: task_board_skills_ui_is_open(player.index) ? 'CLOSE LEARNING' : 'LEARN AREA…',
    style: 'dialog_button',
    tooltip: 'Open area learning and saved skill candidates in a separate movable window.',
  })
  skills_button.style.minimal_width = 0
  skills_button.style.horizontally_stretchable = true
}

function render_world_preview(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot) {
  const { header, body } = create_section(parent, 'NPC World Preview', PREVIEW_COLUMN_WIDTH)
  const preview = runtime.preview
  if (preview === undefined) {
    add_empty_state(body, 'NPC world preview is unavailable.')
    return
  }

  const position = header.add({
    type: 'label',
    caption: `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}`,
    style: 'semibold_label',
  })
  position.style.right_padding = 4

  const frame = body.add({ type: 'frame', direction: 'vertical', style: 'deep_frame_in_shallow_frame' })
  frame.style.horizontally_stretchable = true
  frame.style.vertically_stretchable = true
  const camera = frame.add({
    type: 'camera',
    position: preview.position,
    surface_index: preview.surface_index,
    zoom: PREVIEW_ZOOM,
  })
  camera.style.horizontally_stretchable = true
  camera.style.vertically_stretchable = true
  camera.style.minimal_height = PREVIEW_MIN_HEIGHT
  if (preview.entity?.valid) camera.entity = preview.entity
}

function render_steps(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const { header, body } = create_section(parent, 'Steps')
  if (board === undefined || board.steps.length === 0) {
    add_empty_state(body, 'No active task steps.')
    return
  }

  header.add({ type: 'label', caption: `${board.completed_count} / ${board.total_steps} done`, style: 'semibold_label' })
  const progress = body.add({
    type: 'progressbar',
    value: board.total_steps > 0 ? board.completed_count / board.total_steps : 0,
  })
  progress.style.horizontally_stretchable = true

  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' })
  scroll.style.maximal_height = STEPS_LIST_HEIGHT
  scroll.style.horizontally_stretchable = true
  const grid = scroll.add({ type: 'table', column_count: 3 })
  grid.style.horizontal_spacing = 8
  grid.style.vertical_spacing = 4
  const visible = board.steps.slice(0, MAX_STEPS)
  let active_label: LuaGuiElement | undefined
  for (let index = 0; index < visible.length; index++) {
    const step = visible[index]
    const tone = step_tone(step)
    grid.add({ type: 'sprite', sprite: TONE_SPRITES[tone], style: 'status_image', tooltip: step.status })
    grid.add({ type: 'label', caption: `${index + 1}.`, style: 'semibold_label' })
    const description = grid.add({
      type: 'label',
      caption: step.description,
      style: step.status === 'active' ? 'bold_label' : 'label',
    })
    description.style.single_line = false
    description.style.maximal_width = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 80
    if (step.status === 'completed' || step.status === 'pending') description.style.font_color = TONE_COLORS.muted
    if (step.status === 'active') active_label = description
  }
  if (board.steps.length > visible.length) {
    grid.add({ type: 'empty-widget' })
    grid.add({ type: 'label', caption: '+', style: 'semibold_label' })
    add_empty_state(grid, `${board.steps.length - visible.length} more steps`)
  }
  if (active_label !== undefined) scroll.scroll_to_element(active_label, 'top-third')

  if (board.blocker.length > 0 || board.pause_reason.length > 0) {
    const attention = create_key_value_table(body)
    const width = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - KEY_COLUMN_WIDTH - 12
    if (board.blocker.length > 0) add_key_value(attention, 'BLOCKED', board.blocker, { tone: 'bad', width })
    if (board.pause_reason.length > 0) add_key_value(attention, 'PAUSED', board.pause_reason, { tone: 'warn', width })
  }
}

export function task_board_activity_for_display(board: TaskBoardUiSnapshot | undefined): TaskBoardUiActivity[] {
  if (board === undefined) return []
  if (board.activity.length > 0) return board.activity.slice(-MAX_ACTIVITY)
  if (board.status === 'idle') return []
  if (board.steps.length === 0) return [{ kind: 'system', text: `Goal is ${board.status}; no auditable step activity has been recorded yet.` }]

  const index = math.min(board.active_index, board.steps.length - 1)
  const step = board.steps[index]
  return [{
    kind: 'system',
    text: `Current canonical step ${index + 1}/${board.total_steps}: ${step.description} (${step.status}). Waiting for the next auditable observation, action, or result.`,
  }]
}

function render_activity(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const { body } = create_section(
    parent,
    'Activity / Reasoning Summary',
    undefined,
    'Auditable trace only: observations, plan summaries, actions, results, blockers, and canonical step state.',
  )
  const activity = task_board_activity_for_display(board)
  if (activity.length === 0) {
    add_empty_state(body, 'No recent AIRI activity.')
    return
  }
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' })
  scroll.style.maximal_height = ACTIVITY_LIST_HEIGHT
  scroll.style.horizontally_stretchable = true
  const grid = scroll.add({ type: 'table', column_count: 2 })
  grid.style.horizontal_spacing = 10
  grid.style.vertical_spacing = 4
  for (const entry of activity) {
    const tag = grid.add({ type: 'label', caption: activity_prefix(entry.kind), style: 'bold_label' })
    tag.style.minimal_width = 52
    tag.style.font_color = TONE_COLORS[activity_tone(entry.kind)]
    const line = grid.add({ type: 'label', caption: entry.text })
    line.style.single_line = false
    line.style.maximal_width = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 90
  }
  scroll.scroll_to_bottom()
}

function add_slot_grid(parent: LuaGuiElement, slots: Array<{ name: string, count: number, tooltip: string }>, style: 'slot_button' | 'yellow_slot_button') {
  const scroll = parent.add({
    type: 'scroll-pane',
    style: 'deep_slots_scroll_pane',
    horizontal_scroll_policy: 'never',
    vertical_scroll_policy: 'auto-and-reserve-space',
  })
  scroll.style.width = SLOT_COLUMNS * SLOT_SIZE + SCROLLBAR_WIDTH
  scroll.style.height = SLOT_ROWS * SLOT_SIZE
  const grid = scroll.add({ type: 'table', column_count: SLOT_COLUMNS, style: 'slot_table' })
  for (const slot of slots) {
    grid.add({
      type: 'sprite-button',
      sprite: item_sprite(slot.name),
      number: slot.count,
      style,
      tooltip: slot.tooltip,
    })
  }
}

function render_inventory(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot) {
  const { header, body } = create_section(parent, 'NPC Inventory', HALF_SECTION_WIDTH)
  if (runtime.inventory.length === 0) {
    add_empty_state(body, 'Inventory is empty.')
    return
  }
  header.add({ type: 'label', caption: `${runtime.inventory.length} items`, style: 'semibold_label' })
  add_slot_grid(body, runtime.inventory.map(item => ({
    name: item.name,
    count: item.count,
    tooltip: `${item_caption(item.name)} × ${item.count}`,
  })), 'slot_button')
}

function render_wanted_items(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const { header, body } = create_section(parent, 'Wanted / Needed', HALF_SECTION_WIDTH)
  if (board === undefined || board.wanted_items.length === 0) {
    add_empty_state(body, 'Nothing currently requested.')
    return
  }
  header.add({ type: 'label', caption: `${board.wanted_items.length} items`, style: 'semibold_label' })
  add_slot_grid(body, board.wanted_items.slice(0, MAX_WANTED_ITEMS).map(item => ({
    name: item.name,
    count: item.count,
    tooltip: item.reason.length > 0 ? `${item_caption(item.name)} × ${item.count} — ${item.reason}` : `${item_caption(item.name)} × ${item.count}`,
  })), 'yellow_slot_button')
}

// Built once per open window and never rebuilt: destroying the textfield while
// somebody is typing drops both their keyboard focus and the caret position.
function render_prompt(parent: LuaGuiElement, player: LuaPlayer) {
  const section = parent.add({ type: 'frame', name: PROMPT_SECTION_NAME, direction: 'vertical', style: 'inside_shallow_frame' })
  section.style.horizontally_stretchable = true
  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: 'Prompt AIRI', style: 'subheader_caption_label' })

  const row = section.add({ type: 'flow', name: PROMPT_FLOW_NAME, direction: 'horizontal' })
  row.style.padding = SECTION_PADDING
  row.style.horizontally_stretchable = true
  row.style.vertical_align = 'center'
  row.style.horizontal_spacing = 8
  const field = row.add({
    type: 'textfield',
    name: PROMPT_FIELD_NAME,
    text: task_board_ui_prompt_draft(player.index),
    tooltip: 'Send a prompt directly to AIRI without typing !airi in chat. Press Enter to send.',
  })
  field.style.horizontally_stretchable = true
  field.style.minimal_width = 0
  field.style.maximal_width = LEFT_COLUMN_WIDTH
  const send = row.add({
    type: 'button',
    name: PROMPT_SEND_BUTTON_NAME,
    caption: 'SEND',
    style: 'confirm_button',
    tooltip: 'Send this prompt to AIRI',
  })
  send.style.minimal_width = 100
}

function render_titlebar(root: FrameGuiElement, caption = 'AIRI NPC Console', close_name = CLOSE_BUTTON_NAME) {
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' })
  titlebar.style.horizontally_stretchable = true
  titlebar.style.horizontal_spacing = 8
  titlebar.drag_target = root
  titlebar.add({
    type: 'label',
    caption,
    style: 'frame_title',
    ignored_by_interaction: true,
  })
  const dragger = titlebar.add({
    type: 'empty-widget',
    style: 'draggable_space_header',
    ignored_by_interaction: true,
  })
  dragger.style.horizontally_stretchable = true
  dragger.style.height = 24
  titlebar.add({
    type: 'sprite-button',
    name: close_name,
    sprite: 'utility/close',
    style: 'frame_action_button',
    tooltip: `Close ${caption}`,
  })
}

function build_columns(columns: LuaGuiElement, player: LuaPlayer) {
  const board = storage.airi_task_board_ui
  const synced_tick = storage.airi_task_board_ui_synced_tick
  const runtime = runtime_snapshot()

  const left = columns.add({ type: 'flow', direction: 'vertical' })
  left.style.width = LEFT_COLUMN_WIDTH
  left.style.vertical_spacing = COLUMN_SPACING

  const top = left.add({ type: 'flow', direction: 'horizontal' })
  top.style.horizontal_spacing = COLUMN_SPACING
  render_status_panel(top, board, runtime, synced_tick)
  render_controls_panel(top, player, board, runtime)

  render_steps(left, board)
  render_activity(left, board)

  const resources = left.add({ type: 'flow', direction: 'horizontal' })
  resources.style.horizontal_spacing = COLUMN_SPACING
  render_inventory(resources, runtime)
  render_wanted_items(resources, board)

  const right = columns.add({ type: 'flow', direction: 'vertical' })
  right.style.vertically_stretchable = true
  render_world_preview(right, runtime)
}

function build_panel(player: LuaPlayer) {
  const previous_location = destroy_panel(player)

  // Keep Factorio GUI elements strongly typed. Casting these to `any` makes
  // TypeScriptToLua emit JS-style method calls with the wrong Lua self ABI.
  const root = player.gui.screen.add({
    type: 'frame',
    name: ROOT_NAME,
    direction: 'vertical',
  }) as FrameGuiElement

  // Place the window before any content exists. Centering afterwards leaves it
  // parked in the top-left corner until the content finishes laying out.
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true

  render_titlebar(root)
  const columns = root.add({ type: 'flow', name: COLUMNS_NAME, direction: 'horizontal' })
  columns.style.horizontal_spacing = COLUMN_SPACING
  build_columns(columns, player)
  render_prompt(root, player)
  root.bring_to_front()
}

function render_panel(player: LuaPlayer) {
  if (!task_board_ui_is_open(player.index)) {
    destroy_panel(player)
    return
  }

  const root = player.gui.screen[ROOT_NAME]
  const columns = root?.valid ? root[COLUMNS_NAME] : undefined
  if (columns?.valid) {
    // Refresh the live content in place. The prompt row is outside this
    // container, so typing is never interrupted by an AIRI state update.
    columns.clear()
    build_columns(columns, player)
    return
  }
  build_panel(player)
}

function destroy_skills_popout(player: LuaPlayer) {
  const existing = player.gui.screen[SKILLS_ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  return location
}

function build_skills_body(body: LuaGuiElement) {
  const actions = body.add({ type: 'flow', direction: 'horizontal' })
  actions.style.horizontally_stretchable = true
  render_learn_area_button(actions)
  render_skill_export_section(body)
}

function build_skills_popout(player: LuaPlayer) {
  const previous_location = destroy_skills_popout(player)
  const root = player.gui.screen.add({
    type: 'frame',
    name: SKILLS_ROOT_NAME,
    direction: 'vertical',
  }) as FrameGuiElement

  // Same ordering rule as the console: place the window before it has content,
  // otherwise it is visibly parked in the corner while the layout settles.
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true

  render_titlebar(root, SKILLS_POPOUT_TITLE, SKILLS_CLOSE_BUTTON_NAME)
  const body = root.add({ type: 'flow', name: SKILLS_BODY_NAME, direction: 'vertical' })
  body.style.width = SKILLS_POPOUT_WIDTH
  body.style.vertical_spacing = 6
  build_skills_body(body)
  root.bring_to_front()
}

function render_skills_popout(player: LuaPlayer) {
  if (!task_board_ui_is_open(player.index) || !task_board_skills_ui_is_open(player.index)) {
    destroy_skills_popout(player)
    return
  }

  const root = player.gui.screen[SKILLS_ROOT_NAME]
  const body = root?.valid ? root[SKILLS_BODY_NAME] : undefined
  if (body?.valid) {
    body.clear()
    build_skills_body(body)
    return
  }
  build_skills_popout(player)
}

function render(player: LuaPlayer) {
  ensure_button(player)
  render_panel(player)
  render_skills_popout(player)
}

function render_all() {
  for (const player of game.connected_players) {
    ensure_button(player)
    render_panel(player)
    render_skills_popout(player)
  }
}

function prompt_field(player: LuaPlayer) {
  const root = player.gui.screen[ROOT_NAME]
  const section = root?.valid ? root[PROMPT_SECTION_NAME] : undefined
  const row = section?.valid ? section[PROMPT_FLOW_NAME] : undefined
  const field = row?.valid ? row[PROMPT_FIELD_NAME] : undefined
  return field?.valid ? field as TextFieldGuiElement : undefined
}

function submit_prompt(player: LuaPlayer, raw: unknown) {
  if (!emit_prompt(player, raw)) return false
  // The prompt row survives refreshes, so the sent text has to be cleared here.
  const field = prompt_field(player)
  if (field !== undefined) field.text = ''
  render_panel(player)
  return true
}

function handle_control_click(player: LuaPlayer, element_name: string) {
  if (element_name === PAUSE_BUTTON_NAME) {
    clear_terminate_confirmation(player.index)
    emit_control(player, 'pause')
    return true
  }
  if (element_name === TERMINATE_BUTTON_NAME) {
    if (task_board_ui_terminate_is_armed(player.index, game.tick)) {
      clear_terminate_confirmation(player.index)
      emit_control(player, 'terminate')
    }
    else {
      arm_terminate(player.index)
      render_panel(player)
    }
    return true
  }
  if (element_name === FOLLOW_BUTTON_NAME) {
    clear_terminate_confirmation(player.index)
    const follow = read_follow_status()
    emit_control(player, follow?.active ? 'stop_follow' : 'follow')
    return true
  }
  if (element_name === PROMPT_SEND_BUTTON_NAME) {
    submit_prompt(player, task_board_ui_prompt_draft(player.index))
    return true
  }
  return false
}

export function create_task_board_ui_remote_interface() {
  create_skill_remote_interface()
  remote.add_interface('autorio_task_board', {
    set_snapshot: (value: unknown) => {
      const next = sanitize_task_board_ui_snapshot(value)
      if (next === undefined) return false
      storage.airi_task_board_ui = next
      storage.airi_task_board_ui_synced_tick = game.tick
      render_all()
      return true
    },
    clear: () => {
      storage.airi_task_board_ui = undefined
      storage.airi_task_board_ui_synced_tick = game.tick
      render_all()
      return true
    },
    status: () => storage.airi_task_board_ui,
  })

  script.on_event(defines.events.on_player_joined_game, (event: any) => {
    const player = game.get_player(event.player_index)
    if (player?.valid) render(player)
  })

  script.on_event(defines.events.on_gui_click, (event: any) => {
    const element = event.element
    if (!element?.valid) return
    const player = game.get_player(event.player_index)
    if (!player?.valid) return
    if (element.name === BUTTON_NAME) {
      toggle_task_board_ui_open(player.index)
      render(player)
      return
    }
    if (element.name === CLOSE_BUTTON_NAME) {
      clear_terminate_confirmation(player.index)
      close_task_board_ui(player.index)
      // The pop-out is only reachable from the console, so it must not outlive
      // it as an orphan window the player cannot reopen or close.
      close_task_board_skills_ui(player.index)
      destroy_skills_popout(player)
      destroy_panel(player)
      ensure_button(player)
      return
    }
    if (element.name === SKILLS_BUTTON_NAME) {
      toggle_task_board_skills_ui_open(player.index)
      render_panel(player)
      render_skills_popout(player)
      return
    }
    if (element.name === SKILLS_CLOSE_BUTTON_NAME) {
      close_task_board_skills_ui(player.index)
      destroy_skills_popout(player)
      render_panel(player)
      return
    }
    if (handle_skill_export_click(player, element.name)) {
      render_skills_popout(player)
      return
    }
    handle_control_click(player, element.name)
  })

  script.on_event(defines.events.on_gui_text_changed, (event: any) => {
    const element = event.element
    if (!element?.valid || element.name !== PROMPT_FIELD_NAME) return
    set_prompt_draft(event.player_index, element.text)
  })

  script.on_event(defines.events.on_gui_confirmed, (event: any) => {
    const element = event.element
    if (!element?.valid || element.name !== PROMPT_FIELD_NAME) return
    const player = game.get_player(event.player_index)
    if (!player?.valid) return
    submit_prompt(player, element.text)
  })

  script.on_nth_tick(60, () => {
    for (const player of game.connected_players) {
      if (!task_board_ui_is_open(player.index)) continue
      render_panel(player)
      render_skills_popout(player)
    }
  })
}
