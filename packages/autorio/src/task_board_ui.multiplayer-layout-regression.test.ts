import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('task board multiplayer layout regression', () => {
  it('keeps synchronized GUI sizing independent from client display settings', () => {
    const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const runtimeHeight = source.split('function player_gui_height(')[1]?.split('\n}\n\nfunction preview_position_caption')[0] ?? ''

    expect(source).toContain('synced_gui_height: 1080,')
    expect(runtimeHeight).toContain('return CONSOLE_LAYOUT.synced_gui_height')
    expect(runtimeHeight).not.toContain('display_resolution')
    expect(runtimeHeight).not.toContain('display_scale')
    expect(source).not.toContain('player.display_resolution')
    expect(source).not.toContain('player.display_scale')
  })
})
