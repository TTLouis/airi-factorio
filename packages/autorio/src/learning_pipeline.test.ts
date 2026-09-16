import { beforeEach, describe, expect, it } from 'vitest'
import type { SkillDefinition } from './skills'
import {
  learning_source_for_completed_goal,
  meaningful_completed_goal,
  process_learning_candidate,
  record_experiment_learning,
} from './learning_pipeline'
import {
  list_learning_opportunities,
  list_learning_verification_queue,
  set_learning_policy,
} from './learning_opportunities'
import { get_skill_definition, list_skill_definitions } from './skills'

function candidate(x = 10, output = 'transport-belt', relation: SkillDefinition['topology']['relations'][number]['kind'] = 'item_transfer'): SkillDefinition {
  return {
    schema_version: 1,
    revision: 1,
    id: output === 'transport-belt' ? 'production-transport-belt' : `production-${output}`,
    name: output === 'transport-belt' ? 'Transport Belt Production' : `${output} Production`,
    kind: 'production',
    stage: 'executable_candidate',
    status: 'candidate',
    summary: `Produce ${output} with a reusable two-machine topology.`,
    source: {
      kind: 'observed_factory',
      observed_tick: 100,
      area: { surface_index: 1, left_top: { x, y: 20 }, right_bottom: { x: x + 8, y: 28 } },
      entity_unit_numbers: [x + 1, x + 2],
      recipe_ids: ['iron-gear-wheel', output],
      evidence_refs: [`factory-analysis:analysis-${x}`, `engine:topology:${x}`],
    },
    preconditions: [{ kind: 'item_available', subject: 'iron-plate', description: 'Iron plate input is available.' }],
    inputs: [{ item: 'iron-plate', role: 'raw input' }],
    outputs: [{ item: output, role: 'finished output' }],
    topology: {
      nodes: [
        { id: `gear-${x}`, role: 'producer', entity_name: 'assembling-machine-1', recipe: 'iron-gear-wheel' },
        { id: `output-${x}`, role: 'producer', entity_name: 'assembling-machine-1', recipe: output },
      ],
      relations: [{ kind: relation, from: `gear-${x}`, to: `output-${x}`, description: 'Reusable material flow.' }],
    },
    constraints: [{ kind: 'capacity', description: 'Inserter sustained throughput remains unvalidated.', validation: 'unvalidated', evidence_refs: [] }],
    parameters: [{ name: 'input_direction', description: 'Input side.', required: true }],
    verification: {
      structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'not_tested', production_output: 'not_tested', belt_capacity: 'not_tested',
      inserter_sustained_throughput: 'unvalidated', acceptance_conditions: [],
    },
    known_failure_modes: [],
    confidence: { level: 'medium', basis: ['Engine-observed topology.'] },
    examples: [{ summary: `Observed successful instance ${x}.` }],
  }
}

function goal(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: 'goal-1',
    objective: 'Build a small automated transport-belt production line.',
    status: 'completed' as const,
    completed_count: 4,
    total_steps: 4,
    steps: [
      { id: 's1', description: 'Build gears', status: 'completed' },
      { id: 's2', description: 'Build belts', status: 'completed' },
      { id: 's3', description: 'Connect inputs', status: 'completed' },
      { id: 's4', description: 'Observe output', status: 'completed' },
    ],
    activity: [{ kind: 'result', text: 'Transport belts observed.' }],
    ...overrides,
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 5000, connected_players: [] }
})

describe('Autonomous Learning Opportunity Pipeline V1', () => {
  it('recognizes a meaningful completed goal and rejects an ordinary trivial completion', () => {
    expect(meaningful_completed_goal(goal())).toBe(true)
    expect(meaningful_completed_goal(goal({
      objective: 'Walk to a chest.', completed_count: 1, total_steps: 1,
      steps: [{ id: 's1', description: 'Walk to chest', status: 'completed' }],
    }))).toBe(false)
  })

  it('classifies completed experiments and observed-factory study without hard-coded patterns', () => {
    expect(learning_source_for_completed_goal(goal({ objective: 'Experiment with a small burner mining arrangement.' }))).toBe('experiment')
    expect(learning_source_for_completed_goal(goal({ objective: 'Study and analyze this existing factory block.' }))).toBe('observed_factory')
    expect(learning_source_for_completed_goal(goal())).toBe('completed_goal')
  })

  it('creates an existing SkillDefinition candidate and queues real verification work without promoting it', () => {
    const result = process_learning_candidate(candidate(), 'completed_goal', {
      goal_id: 'goal-1', evidence_refs: ['goal:goal-1'], reason: 'Completed reusable production goal.',
    })
    expect(result.novelty).toBe('new')
    expect(result.skill?.status).toBe('candidate')
    expect(result.skill?.stage).toBe('executable_candidate')
    expect(result.skill?.verification.placement_rebuild).toBe('not_tested')
    expect(result.skill?.verification.production_output).toBe('not_tested')
    expect(result.skill?.verification.inserter_sustained_throughput).toBe('unvalidated')
    expect(get_skill_definition('production-transport-belt')?.status).toBe('candidate')
    expect(list_learning_verification_queue()).toHaveLength(1)
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')
  })

  it('deduplicates equivalent translated topology and attaches provenance/evidence instead', () => {
    process_learning_candidate(candidate(10), 'completed_goal', { goal_id: 'goal-1', evidence_refs: ['goal:goal-1'] })
    const second = process_learning_candidate(candidate(200), 'observed_factory', { evidence_refs: ['goal:goal-2'] })
    expect(second.novelty).toBe('known')
    expect(list_skill_definitions()).toHaveLength(1)
    const stored = get_skill_definition('production-transport-belt')!
    expect(stored.revision).toBe(2)
    expect(stored.source.evidence_refs).toContain('engine:topology:10')
    expect(stored.source.evidence_refs).toContain('engine:topology:200')
    expect(stored.examples).toHaveLength(2)
    expect(second.opportunity.state).toBe('duplicate')
  })

  it('keeps genuinely different topology separate', () => {
    process_learning_candidate(candidate(10, 'transport-belt', 'item_transfer'), 'completed_goal')
    const second = process_learning_candidate(candidate(10, 'transport-belt', 'belt_output'), 'observed_factory')
    expect(second.novelty).toBe('new')
    expect(list_skill_definitions()).toHaveLength(2)
  })

  it('manual policy records automatic opportunities but does not create candidates, while manual study still can', () => {
    set_learning_policy('manual')
    const automatic = process_learning_candidate(candidate(), 'completed_goal')
    expect(automatic.skill).toBeUndefined()
    expect(automatic.opportunity.state).toBe('rejected')
    const manual = process_learning_candidate(candidate(20), 'manual')
    expect(manual.skill?.status).toBe('candidate')
  })

  it('failed experiments record failure evidence and never become verified skills', () => {
    const result = record_experiment_learning({ success: false, goal_id: 'experiment-1', evidence_refs: ['receipt:failed'], reason: 'Output was not observed.' }) as any
    expect(result.skill_created).toBe(false)
    expect(result.opportunity.state).toBe('failed')
    expect(list_skill_definitions()).toHaveLength(0)
    expect(list_learning_verification_queue()).toHaveLength(0)
  })

  it('assisted policy queues expensive verification rather than executing or fabricating it', () => {
    const large = candidate()
    large.topology.nodes.push(
      { id: 'n3', role: 'producer', entity_name: 'assembling-machine-1', recipe: 'a' },
      { id: 'n4', role: 'producer', entity_name: 'assembling-machine-1', recipe: 'b' },
      { id: 'n5', role: 'producer', entity_name: 'assembling-machine-1', recipe: 'c' },
    )
    const result = process_learning_candidate(large, 'completed_goal')
    expect(result.skill?.status).toBe('candidate')
    expect(list_learning_verification_queue()[0].estimated_cost).toBe('expensive')
    expect(list_learning_verification_queue()[0].state).toBe('queued')
  })
})