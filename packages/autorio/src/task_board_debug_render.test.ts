import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SGLuna debug layout', () => {
  it('keeps context and errors full width while splitting dense diagnostics into two columns', () => {
    const source = readFileSync(new URL('./task_board_debug_render.ts', import.meta.url), 'utf8')

    expect(source).toContain('const DEBUG_COLUMN_WIDTH')
    expect(source).toContain("caption: 'LLM / Jev / Decision'")
    expect(source).toContain("caption: 'Step / Runtime'")
    expect(source).toContain("add_row(overview, 'AI reply'")
    expect(source).toContain("add_compact_row(decision_table, 'Tokens · request cumulative'")
    expect(source).toContain('add_debug_decision_rows(decision_table, debug)')
    expect(source).toContain('add_debug_step_rows(runtime_table, debug)')
    expect(source).toContain("add_row(errors, 'Decision error'")
    expect(source).toContain("add_row(errors, 'Last error'")
    expect(source).toContain('build_debug_activity(root)')
  })
})
