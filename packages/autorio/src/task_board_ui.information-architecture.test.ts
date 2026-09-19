import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('NPC console information architecture', () => {
  const consoleSource = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
  const debugSource = readFileSync(new URL('./task_board_debug.ts', import.meta.url), 'utf8')
  const projectsSource = readFileSync(new URL('./projects/project_window.ts', import.meta.url), 'utf8')

  it('keeps operational controls in the top row and puts New Task with Prompt SGLuna', () => {
    expect(consoleSource).toContain("create_section(parent, 'Plan Tracker'")
    expect(consoleSource).toContain('activity_header.visible = false')
    expect(consoleSource).toContain('activity_scroll.visible = false')
    expect(consoleSource).toMatch(/render_tracker\(left, board, player\); debug_ui\.render_ai_reply\(dynamic,[\s\S]*render_prompt\(left, player\)/)
    expect(consoleSource).toContain("create_section(parent, 'Controls', CONTROLS_SECTION_WIDTH")
    const controls = consoleSource.split('function render_controls_panel(')[1]?.split('export function task_board_gui_height(')[0] ?? ''
    const prompt = consoleSource.split('function render_prompt(')[1]?.split('function render_titlebar(')[0] ?? ''
    expect(controls).not.toContain('NEW_TASK_BUTTON_NAME')
    expect(prompt).toContain("caption: 'Prompt SGLuna'")
    expect(prompt).toContain('NEW_TASK_BUTTON_NAME')
  })

  it('separates Project Board strategy from Plan Tracker execution', () => {
    expect(consoleSource).toContain("create_section(parent, 'Project Board'")
    expect(consoleSource).toContain("create_section(parent, 'Plan Tracker'")
    expect(consoleSource).toContain("add_key_value(table, 'MILESTONE'")
    expect(consoleSource).toContain("add_key_value(table, 'DEVELOPMENT'")
    expect(consoleSource).toContain("add_key_value(table, 'UP NEXT'")
    expect(consoleSource).toMatch(/build_left_dynamic\(dynamic,[\s\S]*render_tracker\(left, board, player\)/)
  })

  it('promotes current step and last meaningful result into Status', () => {
    expect(consoleSource).toContain("add_key_value(table, 'STEP'")
    expect(consoleSource).toContain("add_key_value(table, 'LAST'")
  })

  it('gives conversation more room, moves execution activity to Debug, and makes Projects taller', () => {
    expect(debugSource).toContain('const CONVERSATION_HEIGHT = 300')
    expect(debugSource).toContain("caption: 'Execution Activity'")
    expect(projectsSource).toContain('const PROJECTS_HEIGHT = 780')
    expect(projectsSource).toContain("caption: 'Task Conversation'")
    expect(projectsSource).toContain('step_scroll.style.maximal_height = 260')
  })
})
