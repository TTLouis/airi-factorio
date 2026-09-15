import type { LuaPlayer } from 'factorio:runtime'

const ROOT_NAME = 'airi_task_board'
const MAX_STEPS = 16
const MAX_TEXT = 500

export interface TaskBoardUiStep {
  id: string
  description: string
  status: 'pending' | 'active' | 'completed' | 'blocked' | 'paused'
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
}

declare const storage: {
  airi_task_board_ui?: TaskBoardUiSnapshot
}

function text(value: unknown, max = MAX_TEXT) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}

function integer(value: unknown, fallback = 0) {
  return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback
}

function status(value: unknown): TaskBoardUiSnapshot['status'] {
  if (value === 'blocked' || value === 'paused' || value === 'completed') return value
  return 'active'
}

function step_status(value: unknown): TaskBoardUiStep['status'] {
  if (value === 'active' || value === 'completed' || value === 'blocked' || value === 'paused') return value
  return 'pending'
}

export function sanitize_task_board_ui_snapshot(value: any): TaskBoardUiSnapshot | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || !Array.isArray(value.steps)) return undefined
  const steps = value.steps.slice(0, 30).map((step: any, index: number) => ({
    id: text(step?.id || `step_${index + 1}`, 80),
    description: text(step?.description, MAX_TEXT),
    status: step_status(step?.status),
  })).filter((step: TaskBoardUiStep) => step.description.length > 0)
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
  }
}

function destroy_existing(player: LuaPlayer) {
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

function render(player: LuaPlayer) {
  destroy_existing(player)
  const board = storage.airi_task_board_ui
  if (board === undefined) return

  const root: any = player.gui.left.add({
    type: 'frame',
    name: ROOT_NAME,
    direction: 'vertical',
    caption: 'AIRI Task Board',
  })
  const goal = board.objective.length > 0
    ? board.objective
    : board.goal_id.length > 0
      ? board.goal_id
      : 'Current task'
  root.add({ type: 'label', caption: `Goal: ${goal}` })
  root.add({
    type: 'label',
    caption: `Status: ${board.status.toUpperCase()}   Progress: ${board.status === 'completed' ? board.total_steps : math.min(board.active_index + 1, board.total_steps)}/${board.total_steps}`,
  })

  const visible = board.steps.slice(0, MAX_STEPS)
  for (const step of visible) {
    root.add({ type: 'label', caption: `${step_prefix(step)} ${step.description}` })
  }
  if (board.steps.length > visible.length) {
    root.add({ type: 'label', caption: `... ${board.steps.length - visible.length} more steps` })
  }
  if (board.blocker.length > 0) root.add({ type: 'label', caption: `Blocked: ${board.blocker}` })
  if (board.pause_reason.length > 0) root.add({ type: 'label', caption: `Paused: ${board.pause_reason}` })
}

function render_all() {
  for (const player of game.connected_players) render(player)
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
      for (const player of game.connected_players) destroy_existing(player)
      return true
    },
    status: () => storage.airi_task_board_ui,
  })

  script.on_event(defines.events.on_player_joined_game, (event) => {
    const player = game.get_player(event.player_index)
    if (player?.valid) render(player)
  })
}
