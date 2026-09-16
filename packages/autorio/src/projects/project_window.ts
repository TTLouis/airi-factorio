import type { FrameGuiElement, LuaGuiElement, LuaPlayer } from 'factorio:runtime'

// The main Task Board already owns on_gui_click. PROJECTS intentionally reuses
// its existing debug-close click route for the sixth 3x2 control slot; project
// selection itself uses a list-box and on_gui_selection_state_changed, which is
// otherwise unused by the console.
export const PROJECTS_BUTTON_NAME = 'airi_task_board_debug_close'
export const PROJECTS_CLOSE_BUTTON_NAME = PROJECTS_BUTTON_NAME
export const PROJECT_LIST_NAME = 'airi_task_board_project_list'

const ROOT_NAME = 'airi_task_board_projects_panel'
const BODY_NAME = 'airi_task_board_projects_body'
const PROJECTS_WIDTH = 900
const PROJECT_LIST_WIDTH = 250
const PROJECT_DETAIL_WIDTH = PROJECTS_WIDTH - PROJECT_LIST_WIDTH - 12
const MAX_PROJECTS = 64
const MAX_ACTIVITY = 160
const MAX_STEPS = 48
const MAX_TEXT = 2000

export interface ProjectHistoryStep {
  id: string
  description: string
  status: string
}

export interface ProjectHistoryActivity {
  id?: string
  kind: string
  text: string
  timestamp?: string
}

export interface ProjectHistoryRecord {
  id: string
  name: string
  objective: string
  status: string
  response: string
  blocker: string
  pause_reason: string
  completed_count: number
  total_steps: number
  active_index: number
  steps: ProjectHistoryStep[]
  activity: ProjectHistoryActivity[]
  created_tick: number
  updated_tick: number
}

declare const storage: {
  airi_task_board_projects?: Record<string, ProjectHistoryRecord>
  airi_task_board_project_order?: string[]
  airi_task_board_projects_open?: Record<number, boolean>
  airi_task_board_project_selected?: Record<number, string>
}

function clean_text(value: unknown, max = MAX_TEXT) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}

function integer(value: unknown) {
  return typeof value === 'number' && value >= 0 && value === math.floor(value) ? value : 0
}

function ensure_records() {
  if (storage.airi_task_board_projects === undefined) storage.airi_task_board_projects = {}
  return storage.airi_task_board_projects
}

function ensure_order() {
  if (storage.airi_task_board_project_order === undefined) storage.airi_task_board_project_order = []
  return storage.airi_task_board_project_order
}

function ensure_open() {
  if (storage.airi_task_board_projects_open === undefined) storage.airi_task_board_projects_open = {}
  return storage.airi_task_board_projects_open
}

function ensure_selected() {
  if (storage.airi_task_board_project_selected === undefined) storage.airi_task_board_project_selected = {}
  return storage.airi_task_board_project_selected
}

function activity_key(entry: ProjectHistoryActivity) {
  if (entry.id !== undefined && entry.id.length > 0) return `id:${entry.id}`
  return `${entry.kind}|${entry.timestamp ?? ''}|${entry.text}`
}

function sanitize_steps(value: any): ProjectHistoryStep[] {
  const raw = Array.isArray(value) ? value as any[] : []
  const steps: ProjectHistoryStep[] = []
  for (let index = 0; index < raw.length && steps.length < MAX_STEPS; index++) {
    const description = clean_text(raw[index]?.description, 800)
    if (description.length === 0) continue
    steps.push({
      id: clean_text(raw[index]?.id || `step_${index + 1}`, 100),
      description,
      status: clean_text(raw[index]?.status, 40),
    })
  }
  return steps
}

function merge_activity(previous: ProjectHistoryActivity[], value: any): ProjectHistoryActivity[] {
  const result = previous.slice(0, MAX_ACTIVITY)
  const seen: Record<string, boolean> = {}
  for (const entry of result) seen[activity_key(entry)] = true
  const raw = Array.isArray(value) ? value as any[] : []
  for (const source of raw) {
    const text = clean_text(source?.text, 1200)
    if (text.length === 0) continue
    const entry: ProjectHistoryActivity = { kind: clean_text(source?.kind, 40), text }
    const id = clean_text(source?.id, 120)
    const timestamp = clean_text(source?.timestamp, 20)
    if (id.length > 0) entry.id = id
    if (timestamp.length > 0) entry.timestamp = timestamp
    const key = activity_key(entry)
    if (seen[key]) continue
    result.push(entry)
    seen[key] = true
    while (result.length > MAX_ACTIVITY) result.shift()
  }
  return result
}

function project_name(objective: string, goal_id: string) {
  if (objective.length === 0) return goal_id
  return objective.length <= 56 ? objective : `${objective.slice(0, 55)}…`
}

/**
 * Durable goals are the first useful project boundary we have today. Keeping
 * the archive behind a ProjectHistoryRecord makes the UI useful immediately,
 * while leaving room for a later Project -> Tasks layer without changing the
 * main Task Board or the runtime heartbeat schema.
 */
export function record_project_snapshot(board: any, tick: number) {
  const goal_id = clean_text(board?.goal_id, 100)
  if (goal_id.length === 0) return false
  const records = ensure_records()
  const order = ensure_order()
  const previous = records[goal_id]
  const objective = clean_text(board?.objective, 1000)
  const record: ProjectHistoryRecord = {
    id: goal_id,
    name: project_name(objective, goal_id),
    objective,
    status: clean_text(board?.status, 40) || 'active',
    response: clean_text(board?.response, MAX_TEXT),
    blocker: clean_text(board?.blocker, 1000),
    pause_reason: clean_text(board?.pause_reason, 500),
    completed_count: integer(board?.completed_count),
    total_steps: integer(board?.total_steps),
    active_index: integer(board?.active_index),
    steps: sanitize_steps(board?.steps),
    activity: merge_activity(previous?.activity ?? [], board?.activity),
    created_tick: previous?.created_tick ?? tick,
    updated_tick: tick,
  }
  records[goal_id] = record

  for (let index = order.length - 1; index >= 0; index--) {
    if (order[index] === goal_id) order.splice(index, 1)
  }
  order.push(goal_id)
  while (order.length > MAX_PROJECTS) {
    const oldest = order.shift()
    if (oldest !== undefined) delete records[oldest]
  }
  return true
}

export function project_history() {
  const records = ensure_records()
  const order = ensure_order()
  const result: ProjectHistoryRecord[] = []
  for (let index = order.length - 1; index >= 0; index--) {
    const record = records[order[index]]
    if (record !== undefined) result.push(record)
  }
  return result
}

export function project_by_id(project_id: string) {
  return ensure_records()[project_id]
}

export function projects_ui_is_open(player_index: number) {
  return storage.airi_task_board_projects_open?.[player_index] === true
}

export function toggle_projects_ui(player_index: number) {
  const next = !projects_ui_is_open(player_index)
  ensure_open()[player_index] = next
  return next
}

export function close_projects_ui(player_index: number) {
  ensure_open()[player_index] = false
}

export function select_project(player_index: number, project_id: string) {
  if (project_by_id(project_id) === undefined) return false
  ensure_selected()[player_index] = project_id
  return true
}

export function selected_project_id(player_index: number, current_goal_id = '') {
  const selected = storage.airi_task_board_project_selected?.[player_index]
  if (selected !== undefined && project_by_id(selected) !== undefined) return selected
  if (current_goal_id.length > 0 && project_by_id(current_goal_id) !== undefined) return current_goal_id
  const history = project_history()
  return history.length > 0 ? history[0].id : ''
}

function destroy_projects_popout(player: LuaPlayer) {
  const existing = player.gui.screen[ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  return location
}

function render_titlebar(root: FrameGuiElement) {
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' })
  titlebar.style.horizontally_stretchable = true
  titlebar.style.horizontal_spacing = 8
  titlebar.drag_target = root
  titlebar.add({ type: 'label', caption: 'Projects', style: 'frame_title', ignored_by_interaction: true })
  const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true })
  dragger.style.horizontally_stretchable = true
  dragger.style.height = 24
  titlebar.add({ type: 'sprite-button', name: PROJECTS_CLOSE_BUTTON_NAME, sprite: 'utility/close', style: 'frame_action_button', tooltip: 'Close Projects' })
}

function render_project_list(parent: LuaGuiElement, selected_id: string) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame' })
  frame.style.width = PROJECT_LIST_WIDTH
  const header = frame.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: 'PROJECTS', style: 'subheader_caption_label' })
  const history = project_history()
  if (history.length === 0) {
    const empty = frame.add({ type: 'label', caption: 'No durable AIRI projects recorded yet.' })
    empty.style.single_line = false
    empty.style.maximal_width = PROJECT_LIST_WIDTH - 24
    return
  }
  const items: string[] = []
  const ids: string[] = []
  let selected_index = 0
  for (let index = 0; index < history.length; index++) {
    const project = history[index]
    items.push(project.name)
    ids.push(project.id)
    if (project.id === selected_id) selected_index = index + 1
  }
  const list = frame.add({
    type: 'list-box',
    name: PROJECT_LIST_NAME,
    items,
    selected_index,
    tags: { airi_project_ids: ids },
  }) as any
  list.style.width = PROJECT_LIST_WIDTH - 20
  list.style.maximal_height = 620
}

function add_detail_row(parent: LuaGuiElement, key: string, value: string) {
  const row = parent.add({ type: 'flow', direction: 'horizontal' })
  row.style.horizontal_spacing = 8
  const label = row.add({ type: 'label', caption: key, style: 'semibold_label' })
  label.style.minimal_width = 82
  const content = row.add({ type: 'label', caption: value.length > 0 ? value : '—' })
  content.style.single_line = false
  content.style.maximal_width = PROJECT_DETAIL_WIDTH - 120
}

function render_project_detail(parent: LuaGuiElement, project: ProjectHistoryRecord | undefined) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame' })
  frame.style.width = PROJECT_DETAIL_WIDTH
  const header = frame.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: 'Project Detail', style: 'subheader_caption_label' })
  const body = frame.add({ type: 'flow', direction: 'vertical' })
  body.style.padding = 10
  body.style.vertical_spacing = 6
  if (project === undefined) {
    body.add({ type: 'label', caption: 'Select a project from the left.' })
    return
  }

  add_detail_row(body, 'GOAL', project.objective)
  add_detail_row(body, 'STATUS', project.status.toUpperCase())
  add_detail_row(body, 'PROGRESS', `${project.completed_count}/${project.total_steps}`)
  if (project.blocker.length > 0) add_detail_row(body, 'BLOCKER', project.blocker)
  if (project.pause_reason.length > 0) add_detail_row(body, 'PAUSED', project.pause_reason)
  if (project.response.length > 0) add_detail_row(body, 'AIRI', project.response)

  body.add({ type: 'line' })
  body.add({ type: 'label', caption: 'Tasks / Steps', style: 'semibold_label' })
  const step_scroll = body.add({ type: 'scroll-pane', horizontal_scroll_policy: 'never' })
  step_scroll.style.maximal_height = 190
  step_scroll.style.width = PROJECT_DETAIL_WIDTH - 30
  if (project.steps.length === 0) step_scroll.add({ type: 'label', caption: 'No durable steps recorded.' })
  else {
    for (let index = 0; index < project.steps.length; index++) {
      const step = project.steps[index]
      const line = step_scroll.add({ type: 'label', caption: `${index + 1}. [${step.status.toUpperCase()}] ${step.description}` })
      line.style.single_line = false
      line.style.maximal_width = PROJECT_DETAIL_WIDTH - 60
    }
  }

  body.add({ type: 'label', caption: 'Activity / Evidence', style: 'semibold_label' })
  const activity_scroll = body.add({ type: 'scroll-pane', horizontal_scroll_policy: 'never' })
  activity_scroll.style.maximal_height = 250
  activity_scroll.style.width = PROJECT_DETAIL_WIDTH - 30
  if (project.activity.length === 0) activity_scroll.add({ type: 'label', caption: 'No retained activity recorded for this project.' })
  else {
    const start = math.max(0, project.activity.length - 32)
    for (let index = start; index < project.activity.length; index++) {
      const entry = project.activity[index]
      const prefix = entry.timestamp !== undefined ? `${entry.timestamp} · ` : ''
      const line = activity_scroll.add({ type: 'label', caption: `${prefix}${entry.kind.toUpperCase()} · ${entry.text}` })
      line.style.single_line = false
      line.style.maximal_width = PROJECT_DETAIL_WIDTH - 60
    }
  }
}

function build_projects_body(body: LuaGuiElement, player: LuaPlayer, current_goal_id: string) {
  const selected_id = selected_project_id(player.index, current_goal_id)
  const columns = body.add({ type: 'flow', direction: 'horizontal' })
  columns.style.horizontal_spacing = 12
  render_project_list(columns, selected_id)
  render_project_detail(columns, selected_id.length > 0 ? project_by_id(selected_id) : undefined)
}

function build_projects_popout(player: LuaPlayer, current_goal_id: string) {
  const previous_location = destroy_projects_popout(player)
  const root = player.gui.screen.add({ type: 'frame', name: ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  render_titlebar(root)
  const body = root.add({ type: 'flow', name: BODY_NAME, direction: 'vertical' })
  body.style.width = PROJECTS_WIDTH
  build_projects_body(body, player, current_goal_id)
  root.bring_to_front()
}

export function render_projects_popout(player: LuaPlayer, task_board_open: boolean, current_goal_id = '') {
  if (!task_board_open || !projects_ui_is_open(player.index)) {
    destroy_projects_popout(player)
    return
  }
  const root = player.gui.screen[ROOT_NAME]
  const body = root?.valid ? root[BODY_NAME] : undefined
  if (body?.valid) {
    body.clear()
    build_projects_body(body, player, current_goal_id)
    return
  }
  build_projects_popout(player, current_goal_id)
}

function handle_project_selection(player: LuaPlayer, element: any) {
  if (element.name !== PROJECT_LIST_NAME) return false
  const ids = element.tags?.airi_project_ids as string[] | undefined
  const index = typeof element.selected_index === 'number' ? element.selected_index - 1 : -1
  if (ids === undefined || index < 0 || index >= ids.length) return true
  select_project(player.index, ids[index])
  render_projects_popout(player, true, ids[index])
  return true
}

// No other Autorio UI currently owns this event, so Projects can handle its
// selector without competing for the Task Board's single on_gui_click handler.
if (typeof script !== 'undefined' && typeof defines !== 'undefined') {
  script.on_event(defines.events.on_gui_selection_state_changed, (event: any) => {
    const element = event.element
    if (!element?.valid || element.name !== PROJECT_LIST_NAME) return
    const player = game.get_player(event.player_index)
    if (player?.valid) handle_project_selection(player, element)
  })
}
