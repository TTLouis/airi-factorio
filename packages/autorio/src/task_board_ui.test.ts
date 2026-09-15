import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  sanitize_task_board_ui_snapshot,
  task_board_activity_for_display,
  task_board_ui_is_open,
  task_board_ui_prompt_draft,
  task_board_ui_terminate_is_armed,
  toggle_task_board_ui_open,
} from './task_board_ui'

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('in-game task board UI projection', () => {
  it('keeps bounded canonical progress, activity, and wanted-item fields', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_1',
      objective: 'Climb the technology tree',
      status: 'blocked',
      blocker: 'provider recovery exhausted',
      pause_reason: '',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [
        { id: 'step_1', description: 'Find stone', status: 'completed' },
        { id: 'step_2', description: 'Mine stone', status: 'completed' },
        { id: 'step_3', description: 'Trigger steam power', status: 'blocked' },
        { id: 'step_4', description: 'Build power', status: 'pending' },
        { id: 'step_5', description: 'Start research', status: 'pending' },
      ],
      activity: [
        { kind: 'observation', text: 'No boiler in inventory.' },
        { kind: 'decision', text: 'Craft a boiler before continuing.' },
        { kind: 'action', text: 'craft_item boiler x1' },
      ],
      wanted_items: [
        { name: 'boiler', count: 1, reason: 'planned craft' },
        { name: 'pipe', count: 5, reason: 'steam connection' },
      ],
    })
    expect(board).toMatchObject({
      status: 'blocked',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [{ id: 'step_1' }, { id: 'step_2' }, { id: 'step_3' }, { id: 'step_4' }, { id: 'step_5' }],
      activity: [
        { kind: 'observation', text: 'No boiler in inventory.' },
        { kind: 'decision', text: 'Craft a boiler before continuing.' },
        { kind: 'action', text: 'craft_item boiler x1' },
      ],
      wanted_items: [
        { name: 'boiler', count: 1 },
        { name: 'pipe', count: 5 },
      ],
    })
  })

  it('bounds malformed optional UI detail fields instead of trusting them', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal', objective: 'test', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Test', status: 'active' }],
      activity: [{ kind: 'private-chain-of-thought', text: 'Visible summary only' }],
      wanted_items: [{ name: 'iron-plate', count: -50, reason: 'test' }],
    })
    expect(board?.activity).toEqual([{ kind: 'note', text: 'Visible summary only' }])
    expect(board?.wanted_items).toEqual([{ name: 'iron-plate', count: 1, reason: 'test' }])
  })

  it('rejects malformed snapshots instead of creating a second source of truth', () => {
    expect(sanitize_task_board_ui_snapshot(undefined)).toBeUndefined()
    expect(sanitize_task_board_ui_snapshot({ status: 'active' })).toBeUndefined()
  })

  it('falls back to the canonical current step when an active task has no activity entries yet', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_1', objective: 'Gather stone', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 2, active_index: 0,
      steps: [
        { id: 'step_1', description: 'Walk to stone patch', status: 'active' },
        { id: 'step_2', description: 'Mine stone', status: 'pending' },
      ],
      activity: [], wanted_items: [],
    })
    expect(task_board_activity_for_display(board)).toEqual([
      {
        kind: 'system',
        text: 'Current canonical step 1/2: Walk to stone patch (active). Waiting for the next auditable observation, action, or result.',
      },
    ])
  })

  it('keeps the task board window closed by default and toggles per player', () => {
    expect(task_board_ui_is_open(1)).toBe(false)
    expect(task_board_ui_is_open(2)).toBe(false)

    expect(toggle_task_board_ui_open(1)).toBe(true)
    expect(task_board_ui_is_open(1)).toBe(true)
    expect(task_board_ui_is_open(2)).toBe(false)

    expect(toggle_task_board_ui_open(1)).toBe(false)
    expect(task_board_ui_is_open(1)).toBe(false)
  })

  it('keeps terminate confirmation scoped to one player and a short tick window', () => {
    ;(globalThis as any).storage.airi_task_board_terminate_confirm_until = { 1: 600, 2: 0 }
    expect(task_board_ui_terminate_is_armed(1, 599)).toBe(true)
    expect(task_board_ui_terminate_is_armed(1, 601)).toBe(false)
    expect(task_board_ui_terminate_is_armed(2, 1)).toBe(false)
  })

  it('keeps unsent prompt drafts scoped per player', () => {
    ;(globalThis as any).storage.airi_task_board_prompt_draft = { 1: 'build power', 2: 'follow me' }
    expect(task_board_ui_prompt_draft(1)).toBe('build power')
    expect(task_board_ui_prompt_draft(2)).toBe('follow me')
    expect(task_board_ui_prompt_draft(3)).toBe('')
  })

  it('does not erase Factorio GUI element types before chained add calls', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/const\s+\w+\s*:\s*any\s*=\s*player\.gui/)
    expect(source).not.toContain('const root: any')
    expect(source).toContain('as FrameGuiElement')
    expect(source).toContain("surface_index: LuaSurface['index']")
  })

  it('accepts plan-less live agent snapshots and bounds the agent phase', () => {
    const idle = sanitize_task_board_ui_snapshot({
      goal_id: '', objective: 'build power', status: 'idle', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 0, active_index: 0, steps: [], activity: [], wanted_items: [],
      agent: { phase: 'observing', detail: 'Checking getInventory' },
    })
    expect(idle).toMatchObject({ status: 'idle', steps: [], agent: { phase: 'observing', detail: 'Checking getInventory' } })
    expect(task_board_activity_for_display(idle)).toEqual([])

    const legacy = sanitize_task_board_ui_snapshot({
      goal_id: 'goal', objective: 'test', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Test', status: 'active' }],
      agent: { phase: 'plotting', detail: 'x' },
    })
    expect(legacy?.agent.phase).toBe('idle')
    expect(sanitize_task_board_ui_snapshot({ steps: [] })?.agent).toEqual({ phase: 'idle', detail: '' })
  })

  it('uses a vanilla square mod-gui button instead of a text button in gui.top', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain("const MOD_GUI_TOP_FRAME_NAME = 'mod_gui_top_frame'")
    expect(source).toContain("style: 'slot_window_frame'")
    expect(source).toContain("style: 'mod_gui_inside_deep_frame'")
    expect(source).toMatch(/type: 'sprite-button',\s+name: BUTTON_NAME,\s+sprite: 'entity\/character'/)
    expect(source).toContain("style: 'slot_button'")
    expect(source).toContain('button.toggled = task_board_ui_is_open(player.index)')
    expect(source).not.toContain("caption: 'AIRI',")
  })

  it('uses a movable screen window with native Factorio title, content, section, and control styles', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('player.gui.screen.add')
    expect(source).toContain("style: 'frame_title'")
    expect(source).toContain("style: 'draggable_space_header'")
    expect(source).toContain("style: 'frame_action_button'")
    expect(source).toContain("style: 'subheader_frame'")
    expect(source).toContain("style: 'inside_shallow_frame'")
    expect(source).toContain("style: 'dialog_button'")
    expect(source).toContain("style: 'red_button'")
    expect(source).toContain("style: follow?.active ? 'red_button' : 'confirm_button'")
    expect(source).toContain("style: 'deep_slots_scroll_pane'")
    expect(source).toContain("type: 'progressbar'")
    expect(source).toContain('root.location = previous_location')
    expect(source).toContain('HALF_SECTION_WIDTH')
    // Fixed section heights clipped content; sections now stretch to their row.
    expect(source).not.toContain('TOP_SECTION_HEIGHT')
    expect(source).not.toContain('RESOURCE_SECTION_HEIGHT')
  })

  it('puts a native Factorio camera preview in the right column bound to the current actor', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain("type: 'camera'")
    expect(source).toContain('position: preview.position')
    expect(source).toContain('surface_index: preview.surface_index')
    expect(source).toContain('camera.entity = preview.entity')
    expect(source).toContain('PREVIEW_COLUMN_WIDTH')
    expect(source).toMatch(/const right = columns\.add[\s\S]*render_world_preview\(right, runtime\)/)
  })

  it('shows live mod task state and when AIRI last synced', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8')
    expect(source).toContain('storage.airi_task_board_ui_synced_tick = game.tick')
    expect(source).toContain("add_key_value(table, 'WORLD', world_task_summary(runtime.world_task)")
    expect(control).toContain('set_task_board_world_task_provider(() => task_manager.get_status_snapshot())')
  })

  it('provides a direct AIRI prompt field that preserves drafts and emits a fixed structured prompt event', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain("type: 'textfield'")
    expect(source).toContain("name: PROMPT_FIELD_NAME")
    expect(source).toContain("name: PROMPT_SEND_BUTTON_NAME")
    expect(source).toContain('[AIRI_UI_PROMPT]')
    expect(source).toContain('defines.events.on_gui_text_changed')
    expect(source).toContain('defines.events.on_gui_confirmed')
    expect(source).toContain('task_board_ui_prompt_draft(player.index).length === 0')
  })

  it('only emits fixed UI control actions instead of arbitrary console commands', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain("type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow'")
    expect(source).toContain('[AIRI_UI_CONTROL]')
    expect(source).not.toContain('rcon.print')
  })
})
