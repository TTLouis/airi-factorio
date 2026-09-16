import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { task_board_resource_rows } from './task_board_ui'

describe('AIRI NPC console layout regressions', () => {
  const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')

  it('keeps a useful inventory viewport across display sizes', () => {
    expect(task_board_resource_rows(720)).toBe(5)
    expect(task_board_resource_rows(1080)).toBe(6)
    expect(task_board_resource_rows(1440)).toBe(8)
    expect(source).toContain('const MAX_INVENTORY_ITEMS = 48')
    expect(source).toContain('const SLOT_COLUMNS = 6')
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
    expect(source).toContain("activity_scroll.scroll_to_element(latest_line, 'bottom-third')")
  })
})
