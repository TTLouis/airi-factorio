import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { task_board_game_time, task_board_gui_height, task_board_preview_min_height, task_board_tracker_heights } from './task_board_ui'

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
    expect(source).toContain('camera.style.minimal_height = preview_min_height')
    expect(source).toContain('camera.style.vertically_stretchable = true')

    // A stretching camera must not advertise a fixed ratio: the header once read
    // "1:1" while the view was taller than it was wide.
    expect(source).not.toContain('1:1')
    // One caption helper feeds both the initial build and the in-place refresh.
    expect(source).toContain('return `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}`')

    // Framing is the player's choice, bounded by the zoom constants.
    expect(source).toContain('name: PREVIEW_ZOOM_SLIDER_NAME')
    expect(source).toContain('minimum_value: PREVIEW_ZOOM_MIN')
    expect(source).toContain('maximum_value: PREVIEW_ZOOM_MAX')
    expect(source).toContain('value_step: PREVIEW_ZOOM_STEP')
  })

  it('sizes the console from the player display so a big screen is used and a small one still fits', () => {
    // display_resolution is physical pixels; a style only means anything once
    // the player's UI scale has been divided out.
    expect(task_board_gui_height(2160, 2)).toBe(1080)
    expect(task_board_gui_height(1080, 1)).toBe(1080)
    // A zero or missing scale must not divide the console down to nothing.
    expect(task_board_gui_height(1080, 0)).toBe(1080)

    // A short screen never drops below the layout this replaced (132 + 174).
    const small = task_board_tracker_heights(720)
    expect(small.steps + small.activity).toBe(306)

    // A tall screen gets a genuinely taller console, not a token increase.
    const tall = task_board_tracker_heights(1440)
    expect(tall.steps + tall.activity).toBeGreaterThan(600)
    expect(tall.steps).toBeLessThan(tall.activity)

    // ...but the lists stay lists rather than growing without bound.
    const huge = task_board_tracker_heights(4320)
    expect(huge.steps + huge.activity).toBe(900)

    // The camera floor is what keeps the window tall while there is no plan to
    // show, so it scales too, between the same kind of bounds.
    expect(task_board_preview_min_height(720)).toBe(360)
    expect(task_board_preview_min_height(1440)).toBe(720)
    expect(task_board_preview_min_height(4320)).toBe(900)
  })

  it('gives every control the same size and aligns all four buttons in a two-column grid', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    // One width for all four buttons: two of them plus the gap fill the section.
    expect(source).toContain('const COMPACT_BUTTON_WIDTH = (HALF_SECTION_WIDTH - 2 * SECTION_PADDING - COMPACT_BUTTON_SPACING) / 2')
    expect(source).toContain('function compact_button(button: LuaGuiElement)')
    expect(source).not.toContain('COMPACT_TASK_BUTTON_WIDTH')
    expect(source).not.toContain('COMPACT_ACTION_BUTTON_WIDTH')
    expect(source).toContain("const controls = body.add({ type: 'table', column_count: 2 })")
    expect(source).toContain('controls.style.horizontal_spacing = COMPACT_BUTTON_SPACING')
    expect(source).toContain('controls.style.vertical_spacing = COMPACT_BUTTON_SPACING')

    // Intervening matters most exactly when there is no plan, so neither task
    // button may be disabled by the absence of one.
    expect(source).not.toContain('pause.enabled')
    expect(source).not.toContain('terminate.enabled')

    // A caption whose width changes every tick reads as jitter in a fixed-width
    // control; the live distance lives in the tooltip instead.
    expect(source).toContain("return follow?.active ? 'FOLLOWING' : 'FOLLOW ME'")
    expect(source).toContain('Distance: ${math.floor(follow.current_distance * 10) / 10} tiles')

    // A blank failure string must not draw a lone warning triangle.
    expect(source).toContain('if (issue_text.length > 0)')
  })

  it('keeps inventory and wanted items below the world preview and zoom row', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const build_columns = source.split('function build_columns(')[1]?.split('function refresh_columns(')[0] ?? ''
    const preview_index = build_columns.indexOf('render_world_preview(right, runtime, player)')
    const resources_index = build_columns.indexOf("right.add({ type: 'flow', name: RIGHT_RESOURCES_NAME, direction: 'horizontal' })")
    expect(preview_index).toBeGreaterThanOrEqual(0)
    expect(resources_index).toBeGreaterThan(preview_index)
    expect(build_columns).toContain('render_inventory(resources, runtime, player)')
    expect(build_columns).toContain('render_wanted_items(resources, board, player)')

    const left_dynamic = source.split('function build_left_dynamic(')[1]?.split('function build_columns(')[0] ?? ''
    expect(left_dynamic).not.toContain('render_inventory(')
    expect(left_dynamic).not.toContain('render_wanted_items(')
  })

  it('refreshes the world preview in place so dragging zoom is never cancelled', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('function refresh_world_preview(')
    // The once-a-second refresh preserves the preview/slider during normal
    // updates. Only a missing preview structure or missing resources container
    // may trigger a structural rebuild of the right column.
    expect(source).toContain('const resources = right[RIGHT_RESOURCES_NAME]')
    expect(source).toContain('if (!refresh_world_preview(right, runtime, player) || !resources?.valid) {')
    expect(source).toContain('resources.clear(); render_inventory(resources, runtime, player); render_wanted_items(resources, board, player)')

    const refresh_body = source.split('function refresh_world_preview(')[1]?.split('function render_world_preview(')[0] ?? ''
    // Live data may be written to the camera...
    expect(refresh_body).toContain('camera.position = preview.position')
    expect(refresh_body).toContain('position.caption = preview_position_caption(preview)')
    // ...but the slider is the player's own input, and writing to it or
    // destroying it mid-drag is exactly the bug this prevents.
    expect(refresh_body).not.toContain('slider_value')
    expect(refresh_body).not.toContain('PREVIEW_ZOOM_SLIDER_NAME')
    expect(refresh_body).not.toContain('.clear()')
  })

  it('uses compact controls and one combined timestamped plan/activity tracker', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('function compact_button(')
    expect(source).toContain("'Plan Tracker / Activity'")
    // Assert the tracker is rendered from the board, not the name of whichever
    // local holds the parent element.
    expect(source).toContain('function render_tracker(')
    expect(source).toMatch(/render_tracker\(\w+, board[,)]/)
    expect(source).toContain('const previous = storage.airi_task_board_ui')
    expect(source).toContain('stamp_activity_times(next, previous, game.tick)')
    expect(source).toContain("caption: entry.timestamp ?? '--:--:--'")
    // The separate plan and activity sections were merged into the tracker.
    expect(source).not.toContain('render_steps(left, board)')
    expect(source).not.toContain('render_activity(left, board)')
  })
})
