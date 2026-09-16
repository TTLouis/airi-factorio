import { beforeEach, describe, expect, it } from 'vitest'
import {
  assert_safe_skill_id,
  canonicalize_skill_definition,
  create_skill_candidate,
  export_skill,
  generate_skill_markdown,
  handle_skill_export_click,
  serialize_skill_json,
  skill_export_relative_directory,
} from './skills'

const writes: Array<{ filename: string, data: string, append: boolean }> = []

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    revision: 1,
    id: 'automated-transport-belt-line',
    name: 'Automated Transport Belt Line',
    kind: 'production',
    status: 'candidate',
    stage: 'executable_candidate',
    summary: 'Produce transport belts from iron plate while preserving the gear intermediate as a reusable relationship.',
    source: {
      kind: 'observed_factory',
      observed_tick: 1234,
      entity_unit_numbers: [10, 11, 12],
      recipe_ids: ['iron-gear-wheel', 'transport-belt'],
      evidence_refs: ['observation:factory-area-1'],
      area: {
        surface_index: 1,
        left_top: { x: 10, y: 20 },
        right_bottom: { x: 18, y: 27 },
      },
    },
    preconditions: [
      { kind: 'item_available', subject: 'iron-plate', description: 'Iron plate input is available.' },
    ],
    inputs: [{ item: 'iron-plate', role: 'raw input' }],
    outputs: [{ item: 'transport-belt', role: 'finished output' }],
    topology: {
      nodes: [
        { id: 'gear-assembler', role: 'Produce gear intermediate', entity_name: 'assembling-machine-1', recipe: 'iron-gear-wheel' },
        { id: 'belt-assembler', role: 'Consume iron plate and gear output', entity_name: 'assembling-machine-1', recipe: 'transport-belt' },
      ],
      relations: [
        { kind: 'direct_item_output', from: 'gear-assembler', to: 'belt-assembler', description: 'Gear intermediate feeds the belt assembler.' },
        { kind: 'belt_input', to: 'belt-assembler', description: 'Iron plate arrives from the input belt.' },
      ],
    },
    constraints: [
      { kind: 'capacity', description: 'Inserter sustained throughput has not been measured for this layout.', validation: 'unvalidated', evidence_refs: [] },
    ],
    parameters: [
      { name: 'input_direction', description: 'Direction from which iron plate enters.', required: true },
    ],
    verification: {
      structural: 'passed',
      recipe_flow: 'passed',
      placement_rebuild: 'not_tested',
      production_output: 'not_tested',
      belt_capacity: 'passed',
      inserter_sustained_throughput: 'unvalidated',
      acceptance_conditions: [],
    },
    known_failure_modes: ['Gear intermediate starvation can stop belt production.'],
    confidence: { level: 'medium', basis: ['Observed machine recipes and item-transfer relationships.'] },
    examples: [{ summary: 'Observed player factory area.', notes: 'Coordinates are provenance, not the reusable placement definition.' }],
    ...overrides,
  }
}

beforeEach(() => {
  writes.length = 0
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 555 }
  ;(globalThis as any).helpers = {
    table_to_json: (value: unknown) => JSON.stringify(value),
    write_file: (filename: string, data: string, append: boolean) => writes.push({ filename, data, append }),
  }
})

describe('learned skill record and export', () => {
  it('creates a versioned candidate without promoting observation to verification', () => {
    const skill = create_skill_candidate(candidate({ status: 'observed', stage: 'example' }))
    expect(skill.schema_version).toBe(1)
    expect(skill.status).toBe('candidate')
    expect(skill.stage).toBe('executable_candidate')
    expect(skill.verification.structural).toBe('passed')
    expect(skill.verification.inserter_sustained_throughput).toBe('unvalidated')
  })

  it('preserves observed, candidate, and verified lifecycle states explicitly', () => {
    expect(canonicalize_skill_definition(candidate({ status: 'observed', stage: 'example' })).status).toBe('observed')
    expect(canonicalize_skill_definition(candidate()).status).toBe('candidate')
    const verified = canonicalize_skill_definition(candidate({
      status: 'verified',
      stage: 'verified_skill',
      verification: {
        structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'passed', production_output: 'passed', belt_capacity: 'passed',
        inserter_sustained_throughput: 'unvalidated',
        acceptance_conditions: [{ id: 'rebuild', description: 'Rebuilt layout produced the expected item.', status: 'passed', evidence_refs: ['result:run-7'] }],
      },
    }))
    expect(verified.status).toBe('verified')
    expect(verified.stage).toBe('verified_skill')
  })

  it('rejects verified promotion without demonstrated acceptance evidence', () => {
    expect(() => canonicalize_skill_definition(candidate({ status: 'verified', stage: 'verified_skill' }))).toThrow(/acceptance conditions/i)
    expect(() => canonicalize_skill_definition(candidate({
      status: 'verified', stage: 'verified_skill',
      verification: {
        structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'passed', production_output: 'passed', belt_capacity: 'passed', inserter_sustained_throughput: 'unvalidated',
        acceptance_conditions: [{ id: 'rebuild', description: 'Rebuild check', status: 'not_tested', evidence_refs: [] }],
      },
    }))).toThrow(/has not passed/i)
  })

  it('keeps deterministic canonical structure and generates SKILL.md only from the structured record', () => {
    const skill = canonicalize_skill_definition(candidate())
    expect(serialize_skill_json(skill)).toBe(serialize_skill_json(skill))
    const markdown = generate_skill_markdown(skill)
    expect(markdown).toContain('# Automated Transport Belt Line')
    expect(markdown).toContain('## Procedure / Topology')
    expect(markdown).toContain('gear-assembler')
    expect(markdown).toContain('direct_item_output')
    expect(markdown).toContain('inserter sustained throughput: unvalidated')
    expect(markdown).toContain('Source coordinates and entity IDs are provenance only')
  })

  it('exports skill.json and generated SKILL.md into a fixed safe relative directory', () => {
    create_skill_candidate(candidate())
    const result = export_skill('automated-transport-belt-line')
    expect(result).toEqual({
      id: 'automated-transport-belt-line', revision: 1, duplicate: false,
      relative_path: 'script-output/airi-skills/automated-transport-belt-line/r1',
    })
    expect(writes.map(write => write.filename)).toEqual([
      'airi-skills/automated-transport-belt-line/r1/skill.json',
      'airi-skills/automated-transport-belt-line/r1/SKILL.md',
    ])
    expect(writes[0].data).toContain('"schema_version":1')
    expect(writes[0].data).toContain('"inserter_sustained_throughput":"unvalidated"')
    expect(writes[1].data).toContain('## Verification')
    expect(writes.every(write => write.append === false)).toBe(true)
  })

  it('rejects traversal and unsafe IDs before constructing an export path', () => {
    for (const id of ['../escape', '/absolute', 'skill/name', 'skill\\name', 'skill;rm', 'Skill Name', '-skill', 'skill-']) {
      expect(() => assert_safe_skill_id(id)).toThrow()
    }
    expect(skill_export_relative_directory({ id: 'safe-skill-1', revision: 2 })).toBe('airi-skills/safe-skill-1/r2')
  })

  it('treats an identical duplicate export as idempotent and refuses conflicting same-revision overwrites', () => {
    create_skill_candidate(candidate())
    expect(export_skill('automated-transport-belt-line').duplicate).toBe(false)
    expect(export_skill('automated-transport-belt-line').duplicate).toBe(true)
    expect(writes).toHaveLength(2)

    create_skill_candidate(candidate({ summary: 'Changed meaning without a revision bump.' }))
    expect(() => export_skill('automated-transport-belt-line')).toThrow(/increment revision/i)
    expect(writes).toHaveLength(2)
  })

  it('keeps definitions and duplicate-export records in Factorio storage across runtime reconstruction', () => {
    create_skill_candidate(candidate())
    const first = export_skill('automated-transport-belt-line')
    expect(first.duplicate).toBe(false)
    writes.length = 0
    const afterRestart = export_skill('automated-transport-belt-line')
    expect(afterRestart.duplicate).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('wires the UI export action to the same real export path without an LLM serialization call', () => {
    create_skill_candidate(candidate())
    const messages: string[] = []
    const player = { print: (message: string) => messages.push(message) } as any
    expect(handle_skill_export_click(player, 'airi_skill_export__automated-transport-belt-line')).toBe(true)
    expect(writes.map(write => write.filename)).toEqual([
      'airi-skills/automated-transport-belt-line/r1/skill.json',
      'airi-skills/automated-transport-belt-line/r1/SKILL.md',
    ])
    expect(messages[0]).toContain('Exported Automated Transport Belt Line r1')
    expect(messages[0]).toContain('script-output/airi-skills/automated-transport-belt-line/r1')
  })
})
