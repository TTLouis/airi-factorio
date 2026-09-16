import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SkillDefinition } from './skills'
import {
  MAX_LEARNING_OPPORTUNITIES,
  assess_skill_reusability,
  classify_verification_cost_risk,
  create_learning_opportunity,
  get_learning_policy,
  list_learning_opportunities,
  list_learning_verification_queue,
  merge_duplicate_skill,
  queue_learning_verification,
  set_learning_policy,
  skill_novelty_key,
} from './learning_opportunities'

function skill(x = 10, relationKind: SkillDefinition['topology']['relations'][number]['kind'] = 'item_transfer'): SkillDefinition {
  return {
    schema_version: 1,
    revision: 1,
    id: 'production-transport-belt',
    name: 'Transport Belt Production',
    kind: 'production',
    stage: 'executable_candidate',
    status: 'candidate',
    summary: 'Reusable belt production cell.',
    source: {
      kind: 'observed_factory', observed_tick: 100,
      area: { surface_index: 1, left_top: { x, y: 20 }, right_bottom: { x: x + 8, y: 28 } },
      entity_unit_numbers: [x + 1, x + 2], recipe_ids: ['iron-gear-wheel', 'transport-belt'],
      evidence_refs: [`observation:${x}`],
    },
    preconditions: [{ kind: 'item_available', subject: 'iron-plate', description: 'Iron plate input.' }],
    inputs: [{ item: 'iron-plate', role: 'raw input' }],
    outputs: [{ item: 'transport-belt', role: 'finished output' }],
    topology: {
      nodes: [
        { id: `gear-${x}`, role: 'producer', entity_name: 'assembling-machine-1', recipe: 'iron-gear-wheel' },
        { id: `belt-${x}`, role: 'producer', entity_name: 'assembling-machine-1', recipe: 'transport-belt' },
      ],
      relations: [{ kind: relationKind, from: `gear-${x}`, to: `belt-${x}` }],
    },
    constraints: [{ kind: 'capacity', description: 'Sustained inserter throughput remains unvalidated.', validation: 'unvalidated', evidence_refs: [] }],
    parameters: [{ name: 'input_direction', description: 'Input side.', required: true }],
    verification: {
      structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'not_tested', production_output: 'not_tested', belt_capacity: 'not_tested',
      inserter_sustained_throughput: 'unvalidated', acceptance_conditions: [],
    },
    known_failure_modes: [],
    confidence: { level: 'medium', basis: ['Engine-observed topology.'] },
    examples: [{ summary: `Observed instance at ${x}.` }],
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 1000 }
})

describe('autonomous learning opportunity state', () => {
  it('defaults to assisted policy and distinguishes verification cost from candidate creation', () => {
    expect(get_learning_policy()).toBe('assisted')
    expect(set_learning_policy('autonomous_bounded')).toBe('autonomous_bounded')
    expect(classify_verification_cost_risk(skill())).toEqual({ estimated_cost: 'moderate', risk: 'safe' })
  })

  it('normalizes translated topology without absolute coordinates or node ids', () => {
    expect(skill_novelty_key(skill(10))).toBe(skill_novelty_key(skill(200)))
    expect(skill_novelty_key(skill(10))).not.toContain('200')
  })

  it('does not incorrectly deduplicate materially different topology', () => {
    expect(skill_novelty_key(skill(10, 'item_transfer'))).not.toBe(skill_novelty_key(skill(10, 'belt_output')))
  })

  it('rejects trivial single-node candidates but accepts reusable multi-entity structure', () => {
    expect(assess_skill_reusability(skill()).reusable).toBe(true)
    const trivial = skill()
    trivial.topology = { nodes: [{ id: 'lamp', role: 'lamp', entity_name: 'small-lamp' }], relations: [] }
    trivial.outputs = [{ item: 'light' }]
    expect(assess_skill_reusability(trivial).reusable).toBe(false)
  })

  it('merges duplicate provenance/evidence without changing semantic topology or verification', () => {
    const first = skill(10)
    const second = skill(200)
    const merged = merge_duplicate_skill(first, second)
    expect(merged.revision).toBe(2)
    expect(merged.topology).toEqual(first.topology)
    expect(merged.constraints).toEqual(first.constraints)
    expect(merged.verification).toEqual(first.verification)
    expect(merged.source.evidence_refs).toEqual(['observation:10', 'observation:200'])
    expect(merged.examples).toHaveLength(2)
    expect(merged.status).toBe('candidate')
  })

  it('bounds opportunity history and verification queue in persistent storage', () => {
    for (let index = 0; index < MAX_LEARNING_OPPORTUNITIES + 5; index++) {
      create_learning_opportunity({
        source: 'completed_goal', evidence_refs: [`goal:${index}`], novelty_key: `k${index}`,
        estimated_cost: 'cheap', risk: 'safe', reason: `goal ${index}`,
      })
    }
    expect(list_learning_opportunities()).toHaveLength(MAX_LEARNING_OPPORTUNITIES)
    const newest = list_learning_opportunities()[0]
    queue_learning_verification(newest.id, 'production-transport-belt', 'moderate', 'safe', 'Verifier is not available yet.')
    expect(list_learning_verification_queue()).toHaveLength(1)
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')
  })

  it('survives runtime reconstruction because state is stored in Factorio storage', () => {
    const opportunity = create_learning_opportunity({
      source: 'manual', evidence_refs: ['manual:1'], novelty_key: 'same-key',
      estimated_cost: 'cheap', risk: 'safe', reason: 'manual study',
    })
    const persisted = (globalThis as any).storage
    ;(globalThis as any).storage = persisted
    expect(list_learning_opportunities()[0].id).toBe(opportunity.id)
  })

  it('contains no provider dependency in deterministic opportunity state', () => {
    const source = readFileSync(new URL('./learning_opportunities.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/openai|providerRequest|tool_calls/i)
  })
})