import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('task board New Task control regression', () => {
  it('renders New Task in the spare control slot and queues the server-authoritative action', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const controls = source.split('function render_controls_panel(')[1]?.split('/**\n * Usable GUI height')[0] ?? ''
    const handler = source.split('function handle_control_click(')[1]?.split('\n}\n\nexport function create_task_board_ui_remote_interface')[0] ?? ''

    expect(source).toContain("const NEW_TASK_BUTTON_NAME = 'airi_task_board_new_task'")
    expect(source).toContain("type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow' | 'new_task'")
    expect(controls).toContain("name: NEW_TASK_BUTTON_NAME, caption: 'NEW TASK'")
    expect(controls).not.toContain("controls.add({ type: 'empty-widget' }).style.width = COMPACT_BUTTON_WIDTH")
    expect(handler).toContain('if (element_name === NEW_TASK_BUTTON_NAME)')
    expect(handler).toMatch(/NEW_TASK_BUTTON_NAME\)[^\n]*clear_terminate_confirmation\(player\.index\)[^\n]*emit_control\(player, 'new_task'\)/)
  })
})
