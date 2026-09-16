import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { task_board_resource_rows, task_board_wanted_rows } from './task_board_ui'

describe('AIRI NPC console layout regressions', () => {
  const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')

  it('keeps a useful inventory viewport across display sizes while reserving sidebar room for equipment', () => {
    expect(task_board_resource_rows(720)).toBe(5)
    expect(task_board_resource_rows(1080)).toBe(6)
    expect(task_board_resource_rows(1440)).toBe(8)
    expect(task_board_wanted_rows(720)).toBe(1)
    expect(task_board_wanted_rows(1080)).toBe(2)
    expect(task_board_wanted_rows(1440)).toBe(4)
    expect(source).toContain('const MAX_INVENTORY_ITEMS = 64')
    expect(source).toContain('const RESOURCE_LAYOUT = {')
    expect(source).toContain('inventory_slot_columns: 9')
    expect(source).toContain('wanted_slot_columns: 6')
    expect(source).toContain('equipped_slot_columns: 3')
    // Each pane is exactly its own grid wide, so no empty frame is drawn to the
    // right of the last slot and the resource row spends its full width on slots.
    expect(source).toContain('inventory_section_width: 9 * 40 + 12 + 2 * SECTION_PADDING')
    expect(source).toContain('wanted_section_width: PREVIEW_COLUMN_WIDTH - COLUMN_SPACING - (9 * 40 + 12 + 2 * SECTION_PADDING)')
    expect(source).toContain("add_slot_grid(body, runtime.inventory.map")
    expect(source).toContain("task_board_resource_rows(player_gui_height(player)), RESOURCE_LAYOUT.inventory_slot_columns")
    expect(source).toContain("task_board_wanted_rows(player_gui_height(player)), RESOURCE_LAYOUT.wanted_slot_columns")
    expect(source).toContain("create_section(sidebar, 'Equipped', RESOURCE_LAYOUT.wanted_section_width")
  })

  it('packs resource constants and equipment helpers to preserve Factorio Lua local headroom', () => {
    expect(source).not.toContain('const SLOT_SIZE =')
    expect(source).not.toContain('const INVENTORY_SLOT_COLUMNS =')
    expect(source).not.toContain('const EQUIPPED_SLOT_COLUMNS =')
    expect(source).not.toContain('function inventory_items(')
    expect(source).not.toContain('function add_equipped_row(')
    expect(source).not.toContain('function render_equipped(')
    expect(source).toContain('const inventory_items = (source: LuaInventory | undefined)')
    expect(source).toContain('const add_equipped_row = (caption: string, items: TaskBoardUiItem[]) =>')
    // The console height numbers are packed the same way, for the same reason.
    expect(source).toContain('const CONSOLE_LAYOUT = {')
    expect(source).not.toContain('const CONSOLE_SCREEN_FRACTION =')
    expect(source).not.toContain('const TRACKER_LIST_MIN_TOTAL =')
    expect(source).not.toContain('const TRACKER_STEPS_SHARE =')
    expect(source).not.toContain('const PREVIEW_CAMERA_MIN_HEIGHT =')
  })

  it('locks control and prompt widths instead of shrinking to their captions', () => {
    expect(source).toContain('button.style.minimal_width = COMPACT_BUTTON_WIDTH')
    expect(source).toContain('button.style.maximal_width = COMPACT_BUTTON_WIDTH')
    expect(source).toContain('field.style.minimal_width = PROMPT_FIELD_WIDTH')
    expect(source).toContain('field.style.maximal_width = PROMPT_FIELD_WIDTH')
    expect(source).toContain('send.style.maximal_width = PROMPT_SEND_WIDTH')
  })

  it('turns pause into a resumable unpause control without discarding the prompt draft', () => {
    expect(source).toContain("caption: paused ? 'UNPAUSE' : 'PAUSE'")
    expect(source).toContain("if (storage.airi_task_board_ui?.status === 'paused') emit_resume(player)")
    expect(source).toContain("text: 'continue'")
    const resumeBody = source.split('function emit_resume(')[1]?.split('function emit_prompt(')[0] ?? ''
    expect(resumeBody).not.toContain('set_prompt_draft')
  })

  it('filters recent activity and anchors the feed on the newest visible event', () => {
    expect(source).toContain("const ACTIVITY_FILTER_ITEMS = ['ALL', 'PLAN', 'OBS', 'ACTIONS', 'RESULTS', 'ISSUES']")
    expect(source).toContain("type: 'drop-down', name: ACTIVITY_FILTER_NAME")
    expect(source).toContain('on_gui_selection_state_changed')
    expect(source).toContain('activity_scroll.scroll_to_bottom()')
    expect(source).not.toContain("'bottom-third'")
  })
})