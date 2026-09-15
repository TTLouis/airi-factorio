import type { LuaGuiElement, LuaPlayer } from 'factorio:runtime'

import { sanitize_task_board_ui_snapshot } from '../task_board_ui'
import type { TaskBoardUiSnapshot } from '../task_board_ui'
import { display_name_for_agent } from './names'

const BUTTON_NAME = 'airi_swarm_console_button'
const ROOT_NAME = 'airi_swarm_console_panel'
const AGENT_BUTTON_PREFIX = 'airi_swarm_agent_'
const MAX_AGENTS = 64
const MAX_STEPS = 24
const MAX_ACTIVITY = 12
const MAX_WANTED_ITEMS = 16

export interface SwarmTaskBoardEntry {
  agent_id: string
  actor_id: string
  display_name: string
  board?: TaskBoardUiSnapshot
}

interface LiveSwarmActorStatus {
  actorId?: string
  runtime?: {
    state?: string
    bodyRevision?: number
    agentId?: string
  }
  agent?: {
    id?: string
    state?: string
    currentWorkId?: string
    currentMissionId?: string
    currentProjectId?: string
  }
  tasks?: {
    task_state?: string
    queue_length?: number
  }
}

declare const storage: {
  airi_swarm_task_boards?: Record<string, SwarmTaskBoardEntry>
  airi_swarm_console_open?: Record<number, boolean>
  airi_swarm_console_selected?: Record<number, string>
}

function clean_id(value: unknown) {
  const result = String(value ?? '').trim()
  if (result.length < 1 || result.length > 128) return undefined
  return result
}

function boards() {
  if (storage.airi_swarm_task_boards === undefined) storage.airi_swarm_task_boards = {}
  return storage.airi_swarm_task_boards
}

function open_state() {
  if (storage.airi_swarm_console_open === undefined) storage.airi_swarm_console_open = {}
  return storage.airi_swarm_console_open
}

function selected_state() {
  if (storage.airi_swarm_console_selected === undefined) storage.airi_swarm_console_selected = {}
  return storage.airi_swarm_console_selected
}

function live_status(actorId?: string): any {
  if (remote.interfaces?.autorio_swarm === undefined || typeof remote.call !== 'function') return undefined
  return actorId === undefined
    ? remote.call('autorio_swarm', 'status')
    : remote.call('autorio_swarm', 'status', actorId)
}

export function collect_swarm_roster(raw: any, stored: Record<string, SwarmTaskBoardEntry>) {
  const byAgent: Record<string, SwarmTaskBoardEntry> = {}
  for (const agentId in stored) byAgent[agentId] = stored[agentId]

  const actors = Array.isArray(raw?.actors) ? raw.actors : []
  for (const item of actors.slice(0, MAX_AGENTS)) {
    const agentId = clean_id(item?.agent?.id ?? item?.runtime?.agentId)
    const actorId = clean_id(item?.actorId)
    if (agentId === undefined || actorId === undefined) continue
    const existing = byAgent[agentId]
    byAgent[agentId] = {
      agent_id: agentId,
      actor_id: actorId,
      display_name: display_name_for_agent(agentId),
      board: existing?.board,
    }
  }

  const result: SwarmTaskBoardEntry[] = []
  for (const agentId in byAgent) result.push(byAgent[agentId])
  result.sort((left, right) => left.agent_id < right.agent_id ? -1 : left.agent_id > right.agent_id ? 1 : 0)
  return result.slice(0, MAX_AGENTS)
}

function roster() {
  return collect_swarm_roster(live_status(), boards())
}

function ensure_button(player: LuaPlayer) {
  const existing = player.gui.top[BUTTON_NAME]
  if (existing?.valid) return existing
  return player.gui.top.add({
    type: 'button',
    name: BUTTON_NAME,
    caption: 'AIRI Swarm',
    tooltip: 'Open or close the AIRI multi-NPC console',
  })
}

function destroy_panel(player: LuaPlayer) {
  const existing = player.gui.left[ROOT_NAME]
  if (existing?.valid) existing.destroy()
}

function is_open(playerIndex: number) {
  return open_state()[playerIndex] === true
}

function select_default(playerIndex: number, entries: SwarmTaskBoardEntry[]) {
  const selected = selected_state()[playerIndex]
  if (selected !== undefined) {
    for (const entry of entries) if (entry.agent_id === selected) return selected
  }
  const next = entries[0]?.agent_id
  if (next !== undefined) selected_state()[playerIndex] = next
  return next
}

function selected_entry(playerIndex: number, entries: SwarmTaskBoardEntry[]) {
  const selected = select_default(playerIndex, entries)
  if (selected === undefined) return undefined
  for (const entry of entries) if (entry.agent_id === selected) return entry
  return undefined
}

function step_prefix(status: string) {
  if (status === 'completed') return '[x]'
  if (status === 'active') return '[>]'
  if (status === 'blocked') return '[!]'
  if (status === 'paused') return '[||]'
  return '[ ]'
}

function render_roster(parent: LuaGuiElement, entries: SwarmTaskBoardEntry[], selectedAgentId?: string) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: `NPC Roster (${entries.length})` })
  if (entries.length === 0) {
    frame.add({ type: 'label', caption: 'No logical swarm NPCs are registered.' })
    return
  }
  const scroll = frame.add({ type: 'scroll-pane' })
  scroll.style.maximal_height = 220
  const flow = scroll.add({ type: 'flow', direction: 'vertical' })
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const prefix = entry.agent_id === selectedAgentId ? '> ' : ''
    const button = flow.add({
      type: 'button',
      name: `${AGENT_BUTTON_PREFIX}${index + 1}`,
      caption: `${prefix}${entry.display_name} · ${entry.agent_id}`,
      tags: { agent_id: entry.agent_id },
    })
    button.tooltip = `Logical agent ${entry.agent_id}; physical actor ${entry.actor_id}`
  }
}

function render_agent_status(parent: LuaGuiElement, entry: SwarmTaskBoardEntry | undefined) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Selected NPC' })
  if (entry === undefined) {
    frame.add({ type: 'label', caption: 'No NPC selected.' })
    return
  }
  const live = live_status(entry.actor_id) as LiveSwarmActorStatus | undefined
  const table = frame.add({ type: 'table', column_count: 2 })
  table.add({ type: 'label', caption: 'NAME' })
  table.add({ type: 'label', caption: entry.display_name })
  table.add({ type: 'label', caption: 'AGENT' })
  table.add({ type: 'label', caption: entry.agent_id })
  table.add({ type: 'label', caption: 'ACTOR' })
  table.add({ type: 'label', caption: entry.actor_id })
  table.add({ type: 'label', caption: 'BODY' })
  table.add({ type: 'label', caption: `${live?.runtime?.state ?? 'unknown'} · rev ${live?.runtime?.bodyRevision ?? 0}` })
  table.add({ type: 'label', caption: 'AGENT STATE' })
  table.add({ type: 'label', caption: `${live?.agent?.state ?? 'unknown'}` })
  table.add({ type: 'label', caption: 'TASK' })
  table.add({ type: 'label', caption: `${live?.tasks?.task_state ?? 'idle'} · queue ${live?.tasks?.queue_length ?? 0}` })
  if (live?.agent?.currentWorkId) {
    table.add({ type: 'label', caption: 'WORK' })
    table.add({ type: 'label', caption: live.agent.currentWorkId })
  }
}

function render_board(parent: LuaGuiElement, entry: SwarmTaskBoardEntry | undefined) {
  const board = entry?.board
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Task Board' })
  if (board === undefined) {
    frame.add({ type: 'label', caption: 'No agent Task Board projection has been published yet.' })
    return
  }
  const summary = frame.add({ type: 'table', column_count: 2 })
  summary.add({ type: 'label', caption: 'STATUS' })
  summary.add({ type: 'label', caption: board.status.toUpperCase() })
  summary.add({ type: 'label', caption: 'GOAL' })
  summary.add({ type: 'label', caption: board.objective || board.goal_id || 'Current task' })
  summary.add({ type: 'label', caption: 'PROGRESS' })
  summary.add({ type: 'label', caption: `${board.completed_count}/${board.total_steps}` })

  const scroll = frame.add({ type: 'scroll-pane' })
  scroll.style.maximal_height = 240
  const grid = scroll.add({ type: 'table', column_count: 3 })
  grid.add({ type: 'label', caption: 'STATE' })
  grid.add({ type: 'label', caption: 'STEP' })
  grid.add({ type: 'label', caption: 'DESCRIPTION' })
  for (let index = 0; index < math.min(board.steps.length, MAX_STEPS); index++) {
    const step = board.steps[index]
    grid.add({ type: 'label', caption: step_prefix(step.status) })
    grid.add({ type: 'label', caption: `${index + 1}` })
    grid.add({ type: 'label', caption: step.description })
  }
  if (board.blocker) frame.add({ type: 'label', caption: `BLOCKED: ${board.blocker}` })
  if (board.pause_reason) frame.add({ type: 'label', caption: `PAUSED: ${board.pause_reason}` })
}

function render_activity(parent: LuaGuiElement, entry: SwarmTaskBoardEntry | undefined) {
  const board = entry?.board
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Activity / Reasoning Summary' })
  if (board === undefined || board.activity.length === 0) {
    frame.add({ type: 'label', caption: 'No auditable activity summary yet.' })
    return
  }
  for (const item of board.activity.slice(-MAX_ACTIVITY)) {
    frame.add({ type: 'label', caption: `${item.kind.toUpperCase()}: ${item.text}` })
  }
}

function render_wanted(parent: LuaGuiElement, entry: SwarmTaskBoardEntry | undefined) {
  const board = entry?.board
  const frame = parent.add({ type: 'frame', direction: 'vertical', caption: 'Wanted / Needed' })
  if (board === undefined || board.wanted_items.length === 0) {
    frame.add({ type: 'label', caption: 'Nothing currently requested.' })
    return
  }
  const grid = frame.add({ type: 'table', column_count: 3 })
  grid.add({ type: 'label', caption: 'ITEM' })
  grid.add({ type: 'label', caption: 'QTY' })
  grid.add({ type: 'label', caption: 'WHY' })
  for (const item of board.wanted_items.slice(0, MAX_WANTED_ITEMS)) {
    grid.add({ type: 'label', caption: item.name })
    grid.add({ type: 'label', caption: `${item.count}` })
    grid.add({ type: 'label', caption: item.reason })
  }
}

function render_panel(player: LuaPlayer) {
  destroy_panel(player)
  if (!is_open(player.index)) return
  const entries = roster()
  const selected = selected_entry(player.index, entries)
  const root = player.gui.left.add({
    type: 'frame',
    name: ROOT_NAME,
    direction: 'vertical',
    caption: 'AIRI Swarm Console',
  })
  root.style.width = 820
  const top = root.add({ type: 'table', column_count: 2 })
  render_roster(top, entries, selected?.agent_id)
  render_agent_status(top, selected)
  render_board(root, selected)
  const lower = root.add({ type: 'table', column_count: 2 })
  render_activity(lower, selected)
  render_wanted(lower, selected)
  root.add({ type: 'label', caption: 'Per-NPC controls are enabled after the agent session router is attached; selection is already logical-agent scoped.' })
}

function render(player: LuaPlayer) {
  ensure_button(player)
  render_panel(player)
}

function render_all() {
  for (const player of game.connected_players) render(player)
}

export function create_swarm_task_board_ui_remote_interface() {
  remote.add_interface('autorio_swarm_task_board', {
    set_snapshot: (agent_id: string, actor_id: string, value: unknown) => {
      const agentId = clean_id(agent_id)
      const actorId = clean_id(actor_id)
      const board = sanitize_task_board_ui_snapshot(value)
      if (agentId === undefined || actorId === undefined || board === undefined) return false
      boards()[agentId] = {
        agent_id: agentId,
        actor_id: actorId,
        display_name: display_name_for_agent(agentId),
        board,
      }
      render_all()
      return true
    },
    clear: (agent_id: string) => {
      const agentId = clean_id(agent_id)
      if (agentId === undefined) return false
      delete boards()[agentId]
      render_all()
      return true
    },
    clear_all: () => {
      storage.airi_swarm_task_boards = {}
      render_all()
      return true
    },
    status: (agent_id?: string) => agent_id === undefined ? roster() : boards()[agent_id],
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
      open_state()[player.index] = !is_open(player.index)
      render_panel(player)
      return
    }
    if (element.name.startsWith(AGENT_BUTTON_PREFIX)) {
      const agentId = clean_id(element.tags?.agent_id)
      if (agentId !== undefined) {
        selected_state()[player.index] = agentId
        render_panel(player)
      }
    }
  })

  script.on_nth_tick(60, () => {
    for (const player of game.connected_players) if (is_open(player.index)) render_panel(player)
  })
}
