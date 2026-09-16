import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { task_board_game_time } from './task_board_ui'

describe('AIRI NPC console compact tracker layout', () => {
  it('formats deterministic Factorio game time for tracker activity', () => {
    expect(task_board_game_time(0)).toBe('00:00:00')
    expect(task_board_game_time(60)).toBe('00:00:01')
    expect(task_board_game_time(3661 * 60)).toBe('01:01:01')
  })

  it('keeps prompt AIRI on the left half and gives the world preview a zoomable camera', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('section.style.width = LEFT_COLUMN_WIDTH')
    expect(source).toContain('field.style.width = PROMPT_FIELD_WIDTH')

    // The camera spans its column and grows with the window instead of being
    // pinned to a fixed square, so the preview follows the console's height.
    expect(source).toContain('const PREVIEW_CAMERA_WIDTH = PREVIEW_COLUMN_WIDTH - 2 * SECTION_PADDING')
    expect(source).toContain('camera.style.width = PREVIEW_CAMERA_WIDTH')
    expect(source).toContain('camera.style.minimal_height = PREVIEW_CAMERA_MIN_HEIGHT')
    expect(source).toContain('camera.style.vertically_stretchable = true')

    // A stretching camera must not advertise a fixed ratio: the header once read
    // "1:1" while the view was taller than it was wide.
    expect(source).not.toContain('1:1')
    expect(source).toContain('caption: `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}`')

    // Framing is the player's choice, bounded by the zoom constants.
    expect(source).toContain('name: PREVIEW_ZOOM_SLIDER_NAME')
    expect(source).toContain('minimum_value: PREVIEW_ZOOM_MIN')
    expect(source).toContain('maximum_value: PREVIEW_ZOOM_MAX')
    expect(source).toContain('value_step: PREVIEW_ZOOM_STEP')
  })

  it('uses compact controls and one combined timestamped plan/activity tracker', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('function compact_button(')
    expect(source).toContain("'Plan Tracker / Activity'")
    // Assert the tracker is rendered from the board, not the name of whichever
    // local holds the parent element.
    expect(source).toContain('function render_tracker(')
    expect(source).toMatch(/render_tracker\(\w+, board\)/)
    expect(source).toContain('const previous = storage.airi_task_board_ui')
    expect(source).toContain('stamp_activity_times(next, previous, game.tick)')
    expect(source).toContain("caption: entry.timestamp ?? '--:--:--'")
    // The separate plan and activity sections were merged into the tracker.
    expect(source).not.toContain('render_steps(left, board)')
    expect(source).not.toContain('render_activity(left, board)')
  })
})
