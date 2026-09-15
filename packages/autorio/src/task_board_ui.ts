import type { MapPositionStruct } from 'factorio:prototype'
import type { FrameGuiElement, LuaEntity, LuaGuiElement, LuaPlayer, LuaSurface } from 'factorio:runtime'

import { get_controlled_actor } from './actors/actor_controller'
import { get_actor_inventory_items } from './utils/inventory'

const BUTTON_NAME = 'airi_task_board_button'
const ROOT_NAME = 'airi_task_board_panel'
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
const WINDOW_WIDTH = 900
const CONTENT_WIDTH = 868
const HALF_SECTION_WIDTH = 428
const TOP_SECTION_HEIGHT = 120
const WORLD_PREVIEW_SECTION_HEIGHT = 150
const STEPS_SECTION_HEIGHT = 120
const ACTIVITY_SECTION_HEIGHT = 115
const RESOURCE_SECTION_HEIGHT = 110
const PROMPT_SECTION_HEIGHT = 76

type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow'
type TaskBoardUiActivityKind = 'observation' | 'decision' | 'action' | 'result' | 'blocker' | 'system' | 'note'

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

export interface TaskBoardUiSnapshot {
  goal_id: string
  objective: string
  status: 'active' | 'blocked' | 'paused' | 'completed'
  blocker: string
  pause_reason: string
  completed_count: number
  total_steps: number
  active_index: number
  steps: TaskBoardUiStep[]
  activity: TaskBoardUiActivity[]
  wanted_items: TaskBoardUiWantedItem[]
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

interface TaskBoardUiRuntimeSnapshot {
  actor_name: string
  actor_kind: string
  inventory: Array<{ name: string, count: number }>
  follow?: TaskBoardUiFollowStatus
  preview?: TaskBoardUiWorldPreview
}

declare const storage: {
  airi_task_board_ui?: TaskBoardUiSnapshot
  airi_task_board_ui_open?: Record<number, boolean>
  airi_task_board_terminate_confirm_until?: Record<number, number>
  airi_task_board_prompt_draft?: Record<number, string>
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
  if (value === 'blocked' || value === 'paused' || value === 'completed') return value
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
  }
}

function open_state() {
  if (storage.airi_task_board_ui_open === undefined) storage.airi_task_board_ui_open = {}
  return storage.airi_task_board_ui_open
}

function terminate_confirm_state() {
  if (storage.airi_task_board_terminate_confirm_until === undefined) storage.airi_task_board_terminate_confirm_until = {}
  return storage.airi_task_board_terminate_confirm_until
}

function prompt_draft_state() {
  if (storage.airi_task_board_prompt_draft === undefined) storage.airi_task_board_prompt_draft = {}
  return storage.airi_task_board_prompt_draft
}

export function task_board_ui_prompt_draft(player_index: number) {
  return prompt_draft_state()[player_index] ?? ''
}

function set_prompt_draft(player_index: number, value: unknown) {
  prompt_draft_state()[player_index] = text(value, MAX_PROMPT_TEXT)
}

export function task_board_ui_is_open(player_index: number) {
  return open_state()[player_index] === true
}

export function toggle_task_board_ui_open(player_index: number) {
  const next = !task_board_ui_is_open(player_index)
  open_state()[player_index] = next
  return next
}

function close_task_board_ui(player_index: number) {
  open_state()[player_index] = false
}

export function task_board_ui_terminate_is_armed(player_index: number, tick: number) {
  return (terminate_confirm_state()[player_index] ?? 0) >= tick
}

function clear_terminate_confirmation(player_index: number) {
  terminate_confirm_state()[player_index] = 0
}

function arm_terminate(player_index: number) {
  terminate_confirm_state()[player_index] = game.tick + TERMINATE_CONFIRM_TICKS
}

function ensure_button(player: LuaPlayer) {
  const existing = player.gui.top[BUTTON_NAME]
  if (existing?.valid) return existing
  return player.gui.top.add({
    type: 'button',
    name: BUTTON_NAME,
    caption: 'AIRI',
    tooltip: 'Open or close the AIRI NPC control window',
  })
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

function step_prefix(step: TaskBoardUiStep) {
  if (step.status === 'completed') return '[x]'
  if (step.status === 'active') return '[>]'
  if (step.status === 'blocked') return '[!]'
  if (step.status === 'paused') return '[||]'
  return '[ ]'
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

function item_caption(name: string) {
  const item_prototypes = prototypes.item
  if (item_prototypes !== undefined && item_prototypes[name] !== undefined) return `[item=${name}] ${name}`
  return name
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

function runtime_snapshot(): TaskBoardUiRuntimeSnapshot {
  const actor = get_controlled_actor()
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

function create_section(parent: LuaGuiElement, title: string, width: number, height: number) {
  const section = parent.add({ type: 'flow', direction: 'vertical' })
  section.style.width = width
  section.style.height = height

  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: title, style: 'subheader_caption_label' })

  const body = section.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame_with_padding' })
  body.style.horizontally_stretchable = true
  body.style.vertically_stretchable = true
  return body
}

function add_key_value(table: LuaGuiElement, key: string, value: string) {
  table.add({ type: 'label', caption: key, style: 'semibold_label' })
  table.add({ type: 'label', caption: value })
}

function render_status_panel(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const body = create_section(parent, 'Status', HALF_SECTION_WIDTH, TOP_SECTION_HEIGHT)
  const table = body.add({ type: 'table', column_count: 2 })
  add_key_value(table, 'NPC', runtime.actor_name || 'AIRI')
  if (runtime.actor_kind.length > 0) add_key_value(table, 'ACTOR', runtime.actor_kind.toUpperCase())
  if (board === undefined) {
    add_key_value(table, 'STATUS', 'IDLE')
    add_key_value(table, 'GOAL', 'No active AIRI task.')
    return
  }

  const goal = board.objective.length > 0
    ? board.objective
    : board.goal_id.length > 0
      ? board.goal_id
      : 'Current task'
  const progress = board.status === 'completed'
    ? board.total_steps
    : math.min(board.active_index + 1, board.total_steps)
  add_key_value(table, 'STATUS', board.status.toUpperCase())
  add_key_value(table, 'GOAL', goal)
  add_key_value(table, 'PROGRESS', `${progress}/${board.total_steps}`)
  add_key_value(table, 'DONE', `${board.completed_count}/${board.total_steps}`)
}

function follow_summary(follow: TaskBoardUiFollowStatus | undefined) {
  if (!follow?.active) return 'STOPPED'
  const target = follow.target_player.length > 0 ? ` ${follow.target_player}` : ''
  const distance = follow.current_distance !== undefined ? ` · ${math.floor(follow.current_distance * 10) / 10} tiles` : ''
  return `${follow.state.toUpperCase() || 'ACTIVE'}${target}${distance}`
}

function render_controls_panel(parent: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const body = create_section(parent, 'Controls', HALF_SECTION_WIDTH, TOP_SECTION_HEIGHT)
  const follow = runtime.follow
  const follow_table = body.add({ type: 'table', column_count: 2 })
  add_key_value(follow_table, 'FOLLOW', follow_summary(follow))
  if (follow?.last_failure) add_key_value(follow_table, 'ISSUE', follow.last_failure)

  const task_controls = body.add({ type: 'flow', direction: 'horizontal' })
  const pause = task_controls.add({
    type: 'button',
    name: PAUSE_BUTTON_NAME,
    caption: 'PAUSE',
    style: 'dialog_button',
    tooltip: 'Pause the durable AIRI goal and stop current world work',
  })
  pause.style.minimal_width = 120
  pause.enabled = board !== undefined && board.status !== 'paused' && board.status !== 'completed'

  const armed = task_board_ui_terminate_is_armed(player.index, game.tick)
  const terminate = task_controls.add({
    type: 'button',
    name: TERMINATE_BUTTON_NAME,
    caption: armed ? 'CONFIRM TERMINATE' : 'TERMINATE',
    style: 'red_button',
    tooltip: 'Discard the current durable AIRI goal permanently',
  })
  terminate.style.minimal_width = 160
  terminate.enabled = board !== undefined && board.status !== 'completed'

  const follow_button = body.add({
    type: 'button',
    name: FOLLOW_BUTTON_NAME,
    caption: follow?.active ? 'STOP FOLLOW' : 'FOLLOW ME',
    style: follow?.active ? 'red_button' : 'confirm_button',
    tooltip: follow?.active ? 'Stop the persistent follow controller' : 'Pause current work and follow this player',
  })
  follow_button.style.minimal_width = 160
}

function render_world_preview(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot) {
  const body = create_section(parent, 'NPC World Preview', CONTENT_WIDTH, WORLD_PREVIEW_SECTION_HEIGHT)
  const preview = runtime.preview
  if (preview === undefined) {
    body.add({ type: 'label', caption: 'NPC world preview is unavailable.' })
    return
  }

  const camera = body.add({
    type: 'camera',
    position: preview.position,
    surface_index: preview.surface_index,
    zoom: 0.8,
  })
  camera.style.horizontally_stretchable = true
  camera.style.height = 100
  if (preview.entity?.valid) camera.entity = preview.entity
}

function render_steps(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const body = create_section(parent, 'Steps', CONTENT_WIDTH, STEPS_SECTION_HEIGHT)
  if (board === undefined || board.steps.length === 0) {
    body.add({ type: 'label', caption: 'No active task steps.' })
    return
  }

  const headings = body.add({ type: 'table', column_count: 3 })
  headings.add({ type: 'label', caption: 'STATE', style: 'semibold_label' })
  headings.add({ type: 'label', caption: 'STEP', style: 'semibold_label' })
  headings.add({ type: 'label', caption: 'DESCRIPTION', style: 'semibold_label' })
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame' })
  scroll.style.maximal_height = 55
  scroll.style.horizontally_stretchable = true
  const grid = scroll.add({ type: 'table', column_count: 3 })
  grid.draw_horizontal_lines = true
  const visible = board.steps.slice(0, MAX_STEPS)
  for (let index = 0; index < visible.length; index++) {
    const step = visible[index]
    grid.add({ type: 'label', caption: step_prefix(step) })
    grid.add({ type: 'label', caption: `${index + 1}` })
    grid.add({ type: 'label', caption: step.description })
  }
  if (board.steps.length > visible.length) {
    grid.add({ type: 'label', caption: '[+]' })
    grid.add({ type: 'label', caption: '-' })
    grid.add({ type: 'label', caption: `${board.steps.length - visible.length} more steps` })
  }

  if (board.blocker.length > 0 || board.pause_reason.length > 0) {
    const attention = body.add({ type: 'table', column_count: 2 })
    if (board.blocker.length > 0) add_key_value(attention, 'BLOCKED', board.blocker)
    if (board.pause_reason.length > 0) add_key_value(attention, 'PAUSED', board.pause_reason)
  }
}

export function task_board_activity_for_display(board: TaskBoardUiSnapshot | undefined): TaskBoardUiActivity[] {
  if (board === undefined) return []
  if (board.activity.length > 0) return board.activity.slice(-MAX_ACTIVITY)
  if (board.steps.length === 0) return [{ kind: 'system', text: `Goal is ${board.status}; no auditable step activity has been recorded yet.` }]

  const index = math.min(board.active_index, board.steps.length - 1)
  const step = board.steps[index]
  return [{
    kind: 'system',
    text: `Current canonical step ${index + 1}/${board.total_steps}: ${step.description} (${step.status}). Waiting for the next auditable observation, action, or result.`,
  }]
}

function render_activity(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const body = create_section(parent, 'Activity / Reasoning Summary', CONTENT_WIDTH, ACTIVITY_SECTION_HEIGHT)
  body.add({
    type: 'label',
    caption: 'Auditable trace only: observations, plan summaries, actions, results, blockers, and canonical step state.',
    style: 'grey_label',
  })
  const activity = task_board_activity_for_display(board)
  if (activity.length === 0) {
    body.add({ type: 'label', caption: 'No active AIRI task.' })
    return
  }
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame' })
  scroll.style.maximal_height = 50
  scroll.style.horizontally_stretchable = true
  const grid = scroll.add({ type: 'table', column_count: 2 })
  grid.draw_horizontal_lines = true
  for (const entry of activity) {
    grid.add({ type: 'label', caption: activity_prefix(entry.kind), style: 'semibold_label' })
    grid.add({ type: 'label', caption: entry.text })
  }
}

function render_inventory(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot) {
  const body = create_section(parent, 'NPC Inventory', HALF_SECTION_WIDTH, RESOURCE_SECTION_HEIGHT)
  if (runtime.inventory.length === 0) {
    body.add({ type: 'label', caption: 'Inventory is empty.' })
    return
  }
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame' })
  scroll.style.maximal_height = 58
  scroll.style.horizontally_stretchable = true
  const grid = scroll.add({ type: 'table', column_count: 2 })
  grid.add({ type: 'label', caption: 'ITEM', style: 'semibold_label' })
  grid.add({ type: 'label', caption: 'COUNT', style: 'semibold_label' })
  for (const item of runtime.inventory) {
    grid.add({ type: 'label', caption: item_caption(item.name) })
    grid.add({ type: 'label', caption: `${item.count}` })
  }
}

function render_wanted_items(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const body = create_section(parent, 'Wanted / Needed', HALF_SECTION_WIDTH, RESOURCE_SECTION_HEIGHT)
  if (board === undefined || board.wanted_items.length === 0) {
    body.add({ type: 'label', caption: 'Nothing currently requested.' })
    return
  }
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame' })
  scroll.style.maximal_height = 58
  scroll.style.horizontally_stretchable = true
  const grid = scroll.add({ type: 'table', column_count: 3 })
  grid.add({ type: 'label', caption: 'ITEM', style: 'semibold_label' })
  grid.add({ type: 'label', caption: 'QTY', style: 'semibold_label' })
  grid.add({ type: 'label', caption: 'WHY', style: 'semibold_label' })
  for (const item of board.wanted_items.slice(0, MAX_WANTED_ITEMS)) {
    grid.add({ type: 'label', caption: item_caption(item.name) })
    grid.add({ type: 'label', caption: `${item.count}` })
    grid.add({ type: 'label', caption: item.reason })
  }
}

function render_prompt(parent: LuaGuiElement, player: LuaPlayer) {
  const body = create_section(parent, 'Prompt AIRI', CONTENT_WIDTH, PROMPT_SECTION_HEIGHT)
  const row = body.add({ type: 'flow', direction: 'horizontal' })
  row.style.horizontally_stretchable = true
  const field = row.add({
    type: 'textfield',
    name: PROMPT_FIELD_NAME,
    text: task_board_ui_prompt_draft(player.index),
    tooltip: 'Send a prompt directly to AIRI without typing !airi in chat. Press Enter to send.',
  })
  field.style.horizontally_stretchable = true
  field.style.width = 690
  const send = row.add({
    type: 'button',
    name: PROMPT_SEND_BUTTON_NAME,
    caption: 'SEND',
    style: 'confirm_button',
    tooltip: 'Send this prompt to AIRI',
  })
  send.style.minimal_width = 120
}

function render_titlebar(root: FrameGuiElement) {
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' })
  titlebar.style.horizontally_stretchable = true
  titlebar.drag_target = root
  titlebar.add({
    type: 'label',
    caption: 'AIRI NPC Console',
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
    name: CLOSE_BUTTON_NAME,
    sprite: 'utility/close',
    style: 'frame_action_button',
    tooltip: 'Close AIRI NPC Console',
  })
}

function render_panel(player: LuaPlayer) {
  const previous_location = destroy_panel(player)
  if (!task_board_ui_is_open(player.index)) return

  // Keep Factorio GUI elements strongly typed. Casting these to `any` makes
  // TypeScriptToLua emit JS-style method calls with the wrong Lua self ABI.
  const root = player.gui.screen.add({
    type: 'frame',
    name: ROOT_NAME,
    direction: 'vertical',
  }) as FrameGuiElement
  root.style.width = WINDOW_WIDTH
  render_titlebar(root)

  const content = root.add({
    type: 'frame',
    direction: 'vertical',
    style: 'inside_shallow_frame_with_padding',
  })
  content.style.width = CONTENT_WIDTH

  const board = storage.airi_task_board_ui
  const runtime = runtime_snapshot()
  const top = content.add({ type: 'flow', direction: 'horizontal' })
  render_status_panel(top, board, runtime)
  render_controls_panel(top, player, board, runtime)

  render_world_preview(content, runtime)
  render_steps(content, board)
  render_activity(content, board)

  const resources = content.add({ type: 'flow', direction: 'horizontal' })
  render_inventory(resources, runtime)
  render_wanted_items(resources, board)
  render_prompt(content, player)

  if (previous_location !== undefined) root.location = previous_location
  else root.force_auto_center()
  root.bring_to_front()
}

function render(player: LuaPlayer) {
  ensure_button(player)
  render_panel(player)
}

function render_all() {
  for (const player of game.connected_players) {
    ensure_button(player)
    if (task_board_ui_prompt_draft(player.index).length === 0) render_panel(player)
  }
}

function submit_prompt(player: LuaPlayer, raw: unknown) {
  if (!emit_prompt(player, raw)) return false
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
  remote.add_interface('autorio_task_board', {
    set_snapshot: (value: unknown) => {
      const next = sanitize_task_board_ui_snapshot(value)
      if (next === undefined) return false
      storage.airi_task_board_ui = next
      render_all()
      return true
    },
    clear: () => {
      storage.airi_task_board_ui = undefined
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
      render_panel(player)
      return
    }
    if (element.name === CLOSE_BUTTON_NAME) {
      clear_terminate_confirmation(player.index)
      close_task_board_ui(player.index)
      destroy_panel(player)
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
      if (task_board_ui_is_open(player.index) && task_board_ui_prompt_draft(player.index).length === 0) render_panel(player)
    }
  })
}
