import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSwarmJevShadowContext,
  parseSwarmJevShadowDecision,
  swarmJevRecoveryShadowQuestions,
  swarmJevShadowQuestions,
  validateSwarmJevShadowDecision,
} from './swarm-jev-shadow.mjs'

test('shadow controller exposes Jev envelope questions without action authority', () => {
  const questions = swarmJevShadowQuestions()
  assert.equal(questions.routing.type, 'choice')
  assert.equal(questions.reasoning_budget.type, 'choice')
  assert.equal(questions.planning_horizon.type, 'choice')
  assert.equal(questions.observation_budget.type, 'score')
})

test('builds a bounded swarm snapshot for Jev instead of raw coordination state', () => {
  const context = buildSwarmJevShadowContext({
    strategicBoard: {
      goal_id: 'goal-blue-science',
      title: 'Automate blue science',
      status: 'active',
      current_milestone: { title: 'Establish oil processing' },
      development_direction: 'vertical',
    },
    project: {
      id: 'swarm-project-implementation',
      missionId: 'mission-1',
      status: 'executing',
    },
    missions: Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, status: 'active', title: `mission ${index}` })),
    requests: [{ id: 'r-1', status: 'open', kind: 'material_request' }],
    work: [{ id: 'w-1', status: 'claimed', description: 'Bring steel' }],
    claims: [{ claimId: 'c-1', status: 'active' }],
    actors: [{ agentId: 'agent-1', state: 'online' }],
    runtime: { healthy: true, active: true },
    evidence: [{ kind: 'result', id: 'e-1', summary: 'work completed' }],
  })

  assert.equal(context.schema, 'swarm_jev_shadow_v1')
  assert.equal(context.strategic_project_board.current_milestone.title, 'Establish oil processing')
  assert.equal(context.strategic_project_board.goal_id, 'goal-blue-science')
  assert.equal(Object.hasOwn(context, 'project'), false)
  assert.equal(context.missions.length, 12)
  assert.equal(context.counts.missions, 20)
  assert.equal(context.runtime.healthy, true)
})

test('shadow decisions are telemetry only and can never directly mutate swarm state', () => {
  const parsed = parseSwarmJevShadowDecision({
    answers: {
      routing: { choice: 'wake_planner', confidence: 0.9 },
      granularity: { choice: 'split', confidence: 0.8 },
      development: { choice: 'vertical', confidence: 0.85 },
      reasoning_budget: { choice: 'strategic', confidence: 0.75 },
      planning_horizon: { choice: 'strategic' },
      observation_budget: { score: 3 },
    },
  })

  assert.equal(parsed.authority, 'shadow')
  assert.deepEqual(parsed.effects, [])
  assert.equal(parsed.decision.routing, 'wake_planner')
  assert.equal(parsed.decision.granularity, 'split')
  assert.equal(parsed.decision.development, 'vertical')
  assert.equal(validateSwarmJevShadowDecision(parsed), true)
  assert.equal(validateSwarmJevShadowDecision({ ...parsed, effects: ['mutate'] }), false)
})

test('invalid Jev output keeps conservative planner wake defaults even in shadow mode', () => {
  const parsed = parseSwarmJevShadowDecision({ answers: {} })
  assert.equal(parsed.decision.routing, 'wake_planner')
  assert.equal(parsed.decision.granularity, 'keep')
  assert.equal(parsed.decision.development, 'maintain')
  assert.equal(parsed.decision.reasoning_budget, 'normal')
  assert.equal(parsed.decision.planning_horizon, 'checkpoint')
  assert.equal(parsed.decision.observation_budget, 0)
})


test('swarm Project records are never interpreted as the strategic Project Board', () => {
  const context = buildSwarmJevShadowContext({
    project: {
      id: 'project-1',
      missionId: 'mission-1',
      objectiveId: 'objective-1',
      status: 'executing',
    },
  })
  assert.equal(context.strategic_project_board, undefined)
  assert.equal(Object.hasOwn(context, 'project'), false)
})


test('shadow context exposes evidence verdicts without inheriting mutation authority', () => {
  const context = buildSwarmJevShadowContext({
    strategicBoard: {
      goal_id: 'goal-1',
      title: 'Automate blue science',
      current_milestone: { title: 'Establish oil processing' },
    },
    outcome: {
      work: {
        status: 'completed',
        evidence: [{ kind: 'operation_receipt', id: 'batch-1', tick: 10 }],
      },
      strategicMilestoneVerification: {
        verified: true,
        evidence: [{ kind: 'operation_receipt', id: 'batch-2', tick: 11 }],
      },
      effects: ['must_not_escape'],
    },
  })

  assert.equal(context.outcome_verdict.authority, 'verdict_only')
  assert.deepEqual(context.outcome_verdict.effects, [])
  assert.equal(context.outcome_verdict.work.state, 'progress')
  assert.equal(context.outcome_verdict.work.authoritative, false)
  assert.equal(context.outcome_verdict.strategic_milestone.state, 'progress')
  assert.equal(context.outcome_verdict.strategic_milestone.authoritative, false)
  assert.equal(Object.hasOwn(context.outcome_verdict, 'must_not_escape'), false)
})

test('grounded mission verdict can be visible to Jev while the Jev response remains shadow-only', () => {
  const context = buildSwarmJevShadowContext({
    outcome: {
      mission: {
        status: 'satisfied',
        objectiveIds: ['o-1'],
        acceptance: [],
        acceptanceState: {},
        blockers: [],
      },
      objectives: [{
        id: 'o-1',
        status: 'satisfied',
        acceptance: [{ id: 'a-1' }],
        acceptanceState: {
          'a-1': {
            conditionId: 'a-1',
            satisfied: true,
            evidence: [{ kind: 'observation', id: 'obs-1', tick: 20 }],
            tick: 20,
          },
        },
      }],
    },
  })
  assert.equal(context.outcome_verdict.mission.state, 'completed')
  assert.equal(context.outcome_verdict.mission.authoritative, true)

  const decision = parseSwarmJevShadowDecision({
    answers: {
      routing: { choice: 'continue_runtime' },
    },
  })
  assert.equal(decision.authority, 'shadow')
  assert.deepEqual(decision.effects, [])
})


test('shadow exposes coordination wait state without polling or consuming it', () => {
  const conditionWait = {
    kind: 'swarm_condition_wait_v1',
    id: 'wait-1',
    mode: 'completion',
    state: 'active',
    condition: {
      kind: 'objective_status',
      record_id: 'objective-1',
      expected_status: 'satisfied',
    },
    checks: 2,
    max_checks: 10,
    timeout_ticks: 3600,
    registered_tick: 100,
    updated_tick: 120,
  }
  const before = structuredClone(conditionWait)

  const context = buildSwarmJevShadowContext({
    conditionWait,
    objectives: [{
      id: 'objective-1',
      status: 'active',
      revision: 4,
      description: 'Establish electric power',
    }],
    projects: [{
      id: 'project-1',
      status: 'executing',
      revision: 3,
      title: 'Build steam power',
    }],
  })

  assert.equal(context.condition_wait.id, 'wait-1')
  assert.equal(context.condition_wait.checks, 2)
  assert.equal(context.condition_wait.observation.satisfied, false)
  assert.equal(context.condition_wait.observation.progressing, true)
  assert.equal(context.counts.objectives, 1)
  assert.equal(context.counts.projects, 1)
  assert.equal(context.objectives[0].id, 'objective-1')
  assert.equal(context.projects[0].id, 'project-1')
  assert.deepEqual(conditionWait, before)
})


test('recovery shadow questions stay separate from the normal decision envelope', () => {
  const normal = swarmJevShadowQuestions()
  const recovery = swarmJevRecoveryShadowQuestions()

  assert.equal(Object.hasOwn(normal, 'failure_class'), false)
  assert.equal(recovery.failure_class.type, 'choice')
  assert.equal(recovery.next_recovery.type, 'choice')
})

test('shadow recovery capsule cannot bypass deterministic swarm reconciliation', () => {
  const context = buildSwarmJevShadowContext({
    recovery: {
      reason: 'invalid provider JSON',
      reconciliationActions: [{
        kind: 'release_claim',
        claimId: 'claim-1',
        workId: 'work-1',
        reason: 'body_revision_changed',
      }],
      runtime: { active: true },
      outcome: {
        state: 'progress',
        authoritative: true,
        reason: 'mission_progress',
      },
      effects: ['must_not_escape'],
    },
  })

  assert.equal(context.recovery.authority, 'shadow')
  assert.deepEqual(context.recovery.effects, [])
  assert.equal(context.recovery.deterministic_recovery_pending, true)
  assert.equal(context.recovery.jev_eligible, false)
  assert.equal(context.recovery.failure_class_hint, 'provider_format')
  assert.equal(Object.hasOwn(context.recovery, 'must_not_escape'), false)
})


test('global coordination snapshot keeps authoritative totals while exposing bounded samples', () => {
  const context = buildSwarmJevShadowContext({
    schema: 'swarm_coordination_snapshot_v1',
    counts: {
      missions: 25,
      objectives: 40,
      projects: 18,
      work: 70,
      requests: 9,
      claims: 4,
      results: 66,
      agents: 6,
      actors: 6,
      activeWarnings: 3,
    },
    missions: [{ id: 'mission-1', status: 'active', title: 'Mission 1' }],
    objectives: [{ id: 'objective-1', status: 'active', description: 'Objective 1' }],
    projects: [{ id: 'project-1', status: 'executing', title: 'Project 1' }],
    work: [{ id: 'work-1', status: 'active', description: 'Work 1' }],
    requests: [{ id: 'request-1', status: 'open', description: 'Need material' }],
    warnings: [{ id: 'warning-1', kind: 'supply_shortage', description: 'Iron low', active: true }],
    claims: [{ id: 'claim-1', state: 'active' }],
    results: [{ id: 'result-1', status: 'success', summary: 'Survey finished' }],
    agents: [{ id: 'agent-1', state: 'working' }],
    actors: [{ id: 'actor-1', state: 'online' }],
  })

  assert.equal(context.counts.missions, 25)
  assert.equal(context.counts.objectives, 40)
  assert.equal(context.counts.work, 70)
  assert.equal(context.counts.warnings, 3)
  assert.equal(context.counts.results, 66)
  assert.equal(context.counts.agents, 6)
  assert.equal(context.missions.length, 1)
  assert.equal(context.warnings[0].id, 'warning-1')
  assert.equal(context.results[0].id, 'result-1')
  assert.equal(context.agents[0].id, 'agent-1')
})

test('malformed external totals never replace observed sample counts', () => {
  const context = buildSwarmJevShadowContext({
    counts: {
      missions: -1,
      agents: 'many',
    },
    missions: [{ id: 'mission-1', status: 'active' }, { id: 'mission-2', status: 'active' }],
    agents: [{ id: 'agent-1', state: 'available' }],
  })

  assert.equal(context.counts.missions, 2)
  assert.equal(context.counts.agents, 1)
})
