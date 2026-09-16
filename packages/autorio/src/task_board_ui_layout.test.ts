import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { task_board_game_time } from './task_board_ui'

describe('AIRI NPC console compact tracker layout', () => {
  it('formats deterministic Factorio game time for tracker activity', () => {
    expect(task_board_game_time(0)).toBe('00:00:00')
    expect(task_board_game_time(60)).toBe('00:00:01')
    expect(task_board_game_time(3661 * 60)).toBe('01:01:01')
  })

  it('keeps prompt AIRI on the left half and the world preview square', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('section.style.width = LEFT_COLUMN_WIDTH')
    expect(source).toContain('field.style.width = PROMPT_FIELD_WIDTH')
    expect(source).toContain('const PREVIEW_CAMERA_SIZE = PREVIEW_COLUMN_WIDTH - 2 * SECTION_PADDING')
    expect(source).toContain('camera.style.width = PREVIEW_CAMERA_SIZE')
    expect(source).toContain('camera.style.height = PREVIEW_CAMERA_SIZE')
    expect(source).toContain("caption: `1:1 · X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}`")
  })

  it('uses compact controls and one combined timestamped plan/activity tracker', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('function compact_button(')
    expect(source).toContain("'Plan Tracker / Activity'")
    expect(source).toContain('render_tracker(left, board)')
    expect(source).toContain('const previous = storage.airi_task_board_ui')
    expect(source).toContain('stamp_activity_times(next, previous, game.tick)')
    expect(source).toContain("caption: entry.timestamp ?? '--:--:--'")
    expect(source).not.toContain('render_steps(left, board)')
    expect(source).not.toContain('render_activity(left, board)')
  })
})
