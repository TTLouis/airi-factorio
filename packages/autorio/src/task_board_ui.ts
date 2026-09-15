import type { LuaGuiElement, LuaPlayer } from 'factorio:runtime'

import { get_controlled_actor } from './actors/actor_controller'
import { get_actor_inventory_items } from './utils/inventory'

const BUTTON_NAME = 'airi_task_board_button'
const ROOT_NAME = 'airi_task_board_panel'
const PAUSE_BUTTON_NAME = 'airi_task_board_pause'
const TERMINATE_BUTTON_NAME = 'airi_task_board_terminate'
const FOLLOW_BUTTON_NAME = 'airi_task_board_follow'
const MAX_STEPS = 24
const MAX_ACTIVITY = 12
const MAX_INVENTORY_ITEMS = 24
const MAX_WANTED_ITEMS = 16
const MAX_TEXT = 500
const TERMINATE_CONFIRM_TICKS = 5 * 60

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

interface TaskBoardUiRuntimeSnapshot {
  actor_name: string
  actor_kind: string
  inventory: Array<{ name: string, count: number }>
  follow?: TaskBoardUiFollowStatus
}

declare const storage: {
  airi_task_board_ui?: TaskBoardUiSnapshot
  airi_task_board_ui_open?: Record<number, boolean>
  airi_task_board_terminate_confirm_until?: Record<number, number>
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

export function task_board_ui_is_open(player_index: number) {
  return open_state()[player_index] === true
}

export function toggle_task_board_ui_open(player_index: number) {
  const next = !task_board_ui_is_open(player_index)
  open_state()[player_index] = next
  return next
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
    tooltip: 'Open or close the AIRI NPC control panel',
  })
}

function destroy_panel(player: LuaPlayer) {
  const existing = player.gui.left[ROOT_NAME]
  if (existing?.valid) existing.destroy()
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
  return {
    actor_name: text(identity?.name ?? 'AIRI', 128),
    actor_kind: text(identity?.kind ?? '', 64),
    inventory: inventory.slice(0, MAX_INVENTORY_ITEMS),
    follow: read_follow_status(),
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

function render_status_panel(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Status' })
  const table = frame.add({ type: 'table', column_count: 2 })
  table.add({ type: 'label', caption: 'NPC' })
  table.add({ type: 'label', caption: runtime.actor_name || 'AIRI' })
  if (runtime.actor_kind.length > 0) {
    table.add({ type: 'label', caption: 'ACTOR' })
    table.add({ type: 'label', caption: runtime.actor_kind.toUpperCase() })
  }
  if (board === undefined) {
    table.add({ type: 'label', caption: 'STATUS' })
    table.add({ type: 'label', caption: 'IDLE' })
    table.add({ type: 'label', caption: 'GOAL' })
    table.add({ type: 'label', caption: 'No active AIRI task.' })
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
  table.add({ type: 'label', caption: 'STATUS' })
  table.add({ type: 'label', caption: board.status.toUpperCase() })
  table.add({ type: 'label', caption: 'GOAL' })
  table.add({ type: 'label', caption: goal })
  table.add({ type: 'label', caption: 'PROGRESS' })
  table.add({ type: 'label', caption: `${progress}/${board.total_steps}` })
  table.add({ type: 'label', caption: 'DONE' })
  table.add({ type: 'label', caption: `${board.completed_count}/${board.total_steps}` })
}

function follow_summary(follow: TaskBoardUiFollowStatus | undefined) {
  if (!follow?.active) return 'STOPPED'
  const target = follow.target_player.length > 0 ? ` ${follow.target_player}` : ''
  const distance = follow.current_distance !== undefined ? ` · ${math.floor(follow.current_distance * 10) / 10} tiles` : ''
  return `${follow.state.toUpperCase() || 'ACTIVE'}${target}${distance}`
}

function render_controls_panel(parent: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Controls' })
  const follow = runtime.follow
  const follow_table = frame.add({ type: 'table', column_count: 2 })
  follow_table.add({ type: 'label', caption: 'FOLLOW' })
  follow_table.add({ type: 'label', caption: follow_summary(follow) })
  if (follow?.last_failure) {
    follow_table.add({ type: 'label', caption: 'FOLLOW ISSUE' })
    follow_table.add({ type: 'label', caption: follow.last_failure })
  }

  const task_controls = frame.add({ type: 'flow', direction: 'horizontal' })
  const pause = task_controls.add({ type: 'button', name: PAUSE_BUTTON_NAME, caption: 'PAUSE' })
  pause.enabled = board !== undefined && board.status !== 'paused' && board.status !== 'completed'
  const armed = task_board_ui_terminate_is_armed(player.index, game.tick)
  const terminate = task_controls.add({
    type: 'button',
    name: TERMINATE_BUTTON_NAME,
    caption: armed ? 'CONFIRM TERMINATE' : 'TERMINATE',
  })
  terminate.enabled = board !== undefined && board.status !== 'completed'

  const follow_controls = frame.add({ type: 'flow', direction: 'horizontal' })
  follow_controls.add({
    type: 'button',
    name: FOLLOW_BUTTON_NAME,
    caption: follow?.active ? 'STOP FOLLOW' : 'FOLLOW ME',
  })
}

function render_steps(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Steps' })
  if (board === undefined || board.steps.length === 0) {
    frame.add({ type: 'label', caption: 'No active task steps.' })
    return
  }

  const headings = frame.add({ type: 'table', column_count: 3 })
  headings.add({ type: 'label', caption: 'STATE' })
  headings.add({ type: 'label', caption: 'STEP' })
  headings.add({ type: 'label', caption: 'DESCRIPTION' })
  const scroll = frame.add({ type: 'scroll-pane' })
  scroll.style.maximal_height = 260
  const grid = scroll.add({ type: 'table', column_count: 3 })
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
    const attention = frame.add({ type: 'table', column_count: 2 })
    if (board.blocker.length > 0) {
      attention.add({ type: 'label', caption: 'BLOCKED' })
      attention.add({ type: 'label', caption: board.blocker })
    }
    if (board.pause_reason.length > 0) {
      attention.add({ type: 'label', caption: 'PAUSED' })
      attention.add({ type: 'label', caption: board.pause_reason })
    }
  }
}

function render_activity(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Activity / Reasoning Summary' })
  frame.add({
    type: 'label',
    caption: 'Visible decision trace only: observations, plan summaries, actions, results, and blockers.',
  })
  if (board === undefined || board.activity.length === 0) {
    frame.add({ type: 'label', caption: 'No activity summary available yet.' })
    return
  }
  const scroll = frame.add({ type: 'scroll-pane' })
  scroll.style.maximal_height = 220
  const grid = scroll.add({ type: 'table', column_count: 2 })
  for (const entry of board.activity.slice(-MAX_ACTIVITY)) {
    grid.add({ type: 'label', caption: activity_prefix(entry.kind) })
    grid.add({ type: 'label', caption: entry.text })
  }
}

function render_inventory(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'NPC Inventory' })
  if (runtime.inventory.length === 0) {
    frame.add({ type: 'label', caption: 'Inventory is empty.' })
    return
  }
  const scroll = frame.add({ type: 'scroll-pane' })
  scroll.style.maximal_height = 240
  const grid = scroll.add({ type: 'table', column_count: 2 })
  grid.add({ type: 'label', caption: 'ITEM' })
  grid.add({ type: 'label', caption: 'COUNT' })
  for (const item of runtime.inventory) {
    grid.add({ type: 'label', caption: item_caption(item.name) })
    grid.add({ type: 'label', caption: `${item.count}` })
  }
}

function render_wanted_items(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Wanted / Needed' })
  if (board === undefined || board.wanted_items.length === 0) {
    frame.add({ type: 'label', caption: 'Nothing currently requested.' })
    return
  }
  const scroll = frame.add({ type: 'scroll-pane' })
  scroll.style.maximal_height = 240
  const grid = scroll.add({ type: 'table', column_count: 3 })
  grid.add({ type: 'label', caption: 'ITEM' })
  grid.add({ type: 'label', caption: 'QTY' })
  grid.add({ type: 'label', caption: 'WHY' })
  for (const item of board.wanted_items.slice(0, MAX_WANTED_ITEMS)) {
    grid.add({ type: 'label', caption: item_caption(item.name) })
    grid.add({ type: 'label', caption: `${item.count}` })
    grid.add({ type: 'label', caption: item.reason })
  }
}

function render_panel(player: LuaPlayer) {
  destroy_panel(player)
  if (!task_board_ui_is_open(player.index)) return

  // Keep Factorio GUI elements strongly typed. Casting these to `any` makes
  // TypeScriptToLua emit JS-style method calls with the wrong Lua self ABI.
  const root = player.gui.left.add({
    type: 'frame',
    name: ROOT_NAME,
    direction: 'vertical',
    caption: 'AIRI NPC Console',
  })
  root.style.width = 760

  const board = storage.airi_task_board_ui
  const runtime = runtime_snapshot()
  const top = root.add({ type: 'table', column_count: 2 })
  render_status_panel(top, board, runtime)
  render_controls_panel(top, player, board, runtime)

  render_steps(root, board)
  render_activity(root, board)

  const resources = root.add({ type: 'table', column_count: 2 })
  render_inventory(resources, runtime)
  render_wanted_items(resources, board)
}

function render(player: LuaPlayer) {
  ensure_button(player)
  render_panel(player)
}

function render_all() {
  for (const player of game.connected_players) render(player)
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
    handle_control_click(player, element.name)
  })

  script.on_nth_tick(60, () => {
    for (const player of game.connected_players) {
      if (task_board_ui_is_open(player.index)) render_panel(player)
    }
  })
}
