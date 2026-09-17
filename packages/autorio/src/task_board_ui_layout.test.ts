import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { step_caption, task_board_game_time, task_board_gui_height, task_board_preview_min_height, task_board_tracker_heights } from './task_board_ui'

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

    expect(source).toContain('const PREVIEW_CAMERA_WIDTH = PREVIEW_COLUMN_WIDTH - 2 * SECTION_PADDING')
    expect(source).toContain('camera.style.width = PREVIEW_CAMERA_WIDTH')
    expect(source).toContain('camera.style.minimal_height = preview_min_height')
    expect(source).toContain('camera.style.vertically_stretchable = true')
    expect(source).not.toContain('1:1')
    expect(source).toContain('return `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}`')
    expect(source).toContain('name: PREVIEW_ZOOM_SLIDER_NAME')
    expect(source).toContain('minimum_value: PREVIEW_ZOOM_MIN')
    expect(source).toContain('maximum_value: PREVIEW_ZOOM_MAX')
    expect(source).toContain('value_step: PREVIEW_ZOOM_STEP')
  })

  it('sizes the console from the player display so a big screen is used and a small one still fits', () => {
    expect(task_board_gui_height(2160, 2)).toBe(1080)
    expect(task_board_gui_height(1080, 1)).toBe(1080)
    expect(task_board_gui_height(1080, 0)).toBe(1080)

    const small = task_board_tracker_heights(720)
    expect(small.steps + small.activity).toBe(306)

    const tall = task_board_tracker_heights(1440)
    expect(tall.steps + tall.activity).toBeGreaterThan(600)
    expect(tall.steps).toBeLessThan(tall.activity)

    const huge = task_board_tracker_heights(4320)
    expect(huge.steps + huge.activity).toBe(900)

    expect(task_board_preview_min_height(720)).toBe(360)
    expect(task_board_preview_min_height(1440)).toBe(720)
    expect(task_board_preview_min_height(4320)).toBe(900)
  })

  it('spends the plan list leftovers on the activity feed instead of reserving them', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('fixed_height: 560,')
    expect(source).not.toContain('const CONSOLE_FIXED_HEIGHT')
    expect(source).toContain('task_board_tracker_heights(player_gui_height(player), board === undefined ? 0 : math.min(board.steps.length, MAX_STEPS))')

    const short_plan = task_board_tracker_heights(1286, 6)
    const long_plan = task_board_tracker_heights(1286, 24)
    expect(short_plan.steps + short_plan.activity).toBe(long_plan.steps + long_plan.activity)
    expect(short_plan.steps).toBeLessThan(long_plan.steps)
    expect(short_plan.activity).toBeGreaterThan(long_plan.activity)

    expect(task_board_tracker_heights(1286, 1).steps).toBe(120)
    const no_plan = task_board_tracker_heights(1286, 0)
    expect(no_plan.steps).toBe(0)
    expect(no_plan.activity).toBe(long_plan.steps + long_plan.activity)
  })

  it('spends the left column width on the panel that wraps text, not on the button grid', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('const CONTROLS_SECTION_WIDTH = 264')
    expect(source).toContain('const STATUS_SECTION_WIDTH = LEFT_COLUMN_WIDTH - COLUMN_SPACING - CONTROLS_SECTION_WIDTH')
    expect(source).toContain('const STATUS_VALUE_WIDTH = STATUS_SECTION_WIDTH - 2 * SECTION_PADDING - KEY_COLUMN_WIDTH - 12')
    expect(source).toContain('issue.style.maximal_width = CONTROLS_SECTION_WIDTH - 2 * SECTION_PADDING')
    expect(source).not.toContain('HALF_SECTION_WIDTH')
    expect(source).not.toContain('HALF_VALUE_WIDTH')
    expect(source).toContain("caption: skills_open ? 'CLOSE' : 'LEARN'")
    expect(source).toContain('Open area learning and saved skill candidates in a separate movable window.')
  })

  it('does not print the plan step number twice when the plan numbers itself', () => {
    expect(step_caption('1. Craft iron gear wheels')).toBe('Craft iron gear wheels')
    expect(step_caption('12) Connect the boiler')).toBe('Connect the boiler')
    expect(step_caption('Craft 1. iron gear wheels')).toBe('Craft 1. iron gear wheels')
    expect(step_caption('2026 was the year')).toBe('2026 was the year')
    expect(step_caption('Place 4 boilers')).toBe('Place 4 boilers')
    expect(step_caption('3.')).toBe('3.')
    expect(step_caption('')).toBe('')
  })

  it('gives every control the same size and aligns controls in a two-column grid', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('const COMPACT_BUTTON_WIDTH = (CONTROLS_SECTION_WIDTH - 2 * SECTION_PADDING - COMPACT_BUTTON_SPACING) / 2')
    expect(source).toContain('function compact_button(button: LuaGuiElement)')
    expect(source).not.toContain('COMPACT_TASK_BUTTON_WIDTH')
    expect(source).not.toContain('COMPACT_ACTION_BUTTON_WIDTH')
    expect(source).toContain("const controls = body.add({ type: 'table', column_count: 2 })")
    expect(source).toContain('controls.style.horizontal_spacing = COMPACT_BUTTON_SPACING')
    expect(source).toContain('controls.style.vertical_spacing = COMPACT_BUTTON_SPACING')

    expect(source).not.toContain('pause.enabled')
    expect(source).not.toContain('terminate.enabled')

    expect(source).toContain('caption: debug_ui.follow_button_caption(follow?.active === true)')
    expect(source).toContain('Distance: ${math.floor(follow.current_distance * 10) / 10} tiles')
    expect(source).toContain('if (issue_text.length > 0)')
  })

  it('keeps the large inventory beside a wanted/equipped sidebar below the world preview', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const build_columns = source.split('function build_columns(')[1]?.split('function refresh_columns(')[0] ?? ''
    const preview_index = build_columns.indexOf('render_world_preview(right, runtime, player)')
    const resources_index = build_columns.indexOf("right.add({ type: 'flow', name: RIGHT_RESOURCES_NAME, direction: 'horizontal' })")
    expect(preview_index).toBeGreaterThanOrEqual(0)
    expect(resources_index).toBeGreaterThan(preview_index)
    expect(build_columns).toContain('render_inventory(resources, runtime, player)')
    expect(build_columns).toContain('render_resource_sidebar(resources, board, runtime, player)')

    const sidebar = source.split('function render_resource_sidebar(')[1]?.split('function render_prompt(')[0] ?? ''
    const wanted_index = sidebar.indexOf('render_wanted_items(sidebar, board, player)')
    const equipped_index = sidebar.indexOf("create_section(sidebar, 'Equipped'")
    expect(wanted_index).toBeGreaterThanOrEqual(0)
    expect(equipped_index).toBeGreaterThan(wanted_index)
    expect(sidebar).toContain("add_equipped_row('GUN', runtime.guns)")
    expect(sidebar).toContain("add_equipped_row('AMMO', runtime.ammo)")
    expect(source).toContain('defines.inventory.character_guns')
    expect(source).toContain('defines.inventory.character_ammo')

    const left_dynamic = source.split('function build_left_dynamic(')[1]?.split('function build_columns(')[0] ?? ''
    expect(left_dynamic).not.toContain('render_inventory(')
    expect(left_dynamic).not.toContain('render_wanted_items(')
    expect(left_dynamic).not.toContain("create_section(sidebar, 'Equipped'")
  })

  it('refreshes the world preview in place so dragging zoom is never cancelled', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('function refresh_world_preview(')
    expect(source).toContain('const resources = right[RIGHT_RESOURCES_NAME]')
    expect(source).toContain('if (!refresh_world_preview(right, runtime, player) || !resources?.valid) {')
    expect(source).toContain('resources.clear(); render_inventory(resources, runtime, player); render_resource_sidebar(resources, board, runtime, player)')

    const refresh_body = source.split('function refresh_world_preview(')[1]?.split('function render_world_preview(')[0] ?? ''
    expect(refresh_body).toContain('camera.position = preview.position')
    expect(refresh_body).toContain('position.caption = preview_position_caption(preview)')
    expect(refresh_body).not.toContain('slider_value')
    expect(refresh_body).not.toContain('PREVIEW_ZOOM_SLIDER_NAME')
    expect(refresh_body).not.toContain('.clear()')
  })

  it('uses compact controls and one combined timestamped plan/activity tracker', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('function compact_button(')
    expect(source).toContain("'Plan & Activity'")
    expect(source).toContain('function render_tracker(')
    expect(source).toMatch(/render_tracker\(\w+, board[,)]/)
    expect(source).toContain('const previous = storage.airi_task_board_ui')
    expect(source).toContain('stamp_activity_times(next, previous, game.tick)')
    expect(source).toContain("caption: entry.timestamp ?? '--:--:--'")
    expect(source).not.toContain('render_steps(left, board)')
    expect(source).not.toContain('render_activity(left, board)')
  })

  // Conversation has always carried its LIVE control in its subheader. The
  // tracker used to grow a second "Recent activity" header row inside its body
  // for the same kind of control, which put one selector in a heading and one
  // below it. Every feed control belongs in its section heading.
  it('keeps every feed control in its section heading', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const tracker = source.split('function render_tracker(')[1]?.split('function refresh_tracker(')[0] ?? ''
    expect(tracker).toContain('const activity_header = header.add(')
    expect(tracker).not.toContain('const activity_header = body.add(')
    expect(tracker).not.toContain("caption: 'Recent activity'")
    expect(tracker).toContain('activity_state.style_feed_button(')
    expect(source).toContain('const activity_header = header[TRACKER.activity_header]')

    const debug_source = readFileSync(new URL('./task_board_debug.ts', import.meta.url), 'utf8')
    expect(debug_source).toContain('activity_state.style_feed_button(header.add(')
    expect(debug_source).not.toContain("style: 'mini_button'")

    // One styler for every feed, so the two headings cannot drift apart again.
    const projects = readFileSync(new URL('./projects/project_window.ts', import.meta.url), 'utf8')
    expect(projects).toContain('activity_state.style_feed_button(parent.add(')
    expect(projects).not.toContain("button.style.font = 'default-small-semibold'")
  })

  // The button is a live readout of which model is answering, not a static icon.
  it('dresses the mod-GUI button with the current provider avatar', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    expect(source).toContain('button.sprite = provider_ui.provider_button_sprite(player.index, BUTTON_SPRITE)')
    expect(source).toContain("button.tooltip = provider_ui.provider_button_tooltip('AIRI NPC Console')")
    expect(source).toContain('provider_ui.remember_provider_model(stamped.debug?.provider_model)')

    // Joining is where the variant is decided, in synchronized storage, rather
    // than while drawing - the button must not be a client-local choice.
    expect(source).toContain('provider_ui.roll_provider_avatar(player.index, game.tick)')
  })

  // The avatars are prototypes, so the data stage has to declare every variant
  // the control stage can resolve to. A count that drifts leaves a blank button
  // for whichever players rolled the missing one, which is the kind of bug that
  // only shows up for some players on some sessions.
  it('declares every avatar variant the resolver can pick', () => {
    const data_stage = readFileSync(new URL('../data.lua', import.meta.url), 'utf8')
    const provider_source = readFileSync(new URL('./task_board_provider.ts', import.meta.url), 'utf8')

    const declared = new Map<string, number>()
    for (const [, id, count] of data_stage.matchAll(/\{"(\w+)", (\d+)\}/g)) declared.set(id, Number(count))
    const resolved = new Map<string, number>()
    for (const [, id, count] of provider_source.matchAll(/id: '(\w+)',[^}]*?variants: (\d+)/g)) resolved.set(id, Number(count))

    expect(resolved.size).toBe(5)
    expect([...declared.entries()].sort()).toEqual([...resolved.entries()].sort())
    expect(data_stage).toContain('"__autorio__/graphics/icons/provider/" .. id .. ".png"')
  })
})
