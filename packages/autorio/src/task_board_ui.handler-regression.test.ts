import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('task board UI handler regression', () => {
  it('keeps close-button handlers wired to the helpers that actually exist', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')

    expect(source).toContain('close_task_board_ui(player.index)')
    expect(source).toContain('close_task_board_skills_ui(player.index)')
    expect(source).not.toContain('close_task_board_ui_open(')
    expect(source).not.toContain('close_task_board_skills_ui_open(')
  })
})
