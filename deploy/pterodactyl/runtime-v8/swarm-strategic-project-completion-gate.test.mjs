import test from 'node:test'
import assert from 'node:assert/strict'

import {
  authorizeStrategicProjectCompletion,
  evaluateStrategicProjectCompletionFacts,
  strategicProjectCompletionCandidate,
} from './swarm-strategic-project-completion-gate.mjs'

function board() {
  return {
    kind: 'strategic_project_board_v1',
    goal_id: 'goal-rocket',
    title: 'Launch a rocket',
    status: 'active',
    completed_milestones: [{ id: 'm-1', title: 'Final milestone', status: 'completed' }],
    current_milestone: undefined,
    next_milestones: [],
    development_direction: 'vertical',
    transition_state: 'awaiting_next_milestone',
    revision: 8,
  }
}

function snapshot() {
  return {
    schema: 'swarm_coordination_snapshot_v1',
    counts: {
      missions: 3,
      incompleteMissions: 0,
      objectives: 8,
      incompleteObjectives: 0,
      projects: 5,
      incompleteProjects: 0,
      openWork: 0,
      executingWork: 0,
      blockedWork: 0,
      openRequests: 0,
      activeClaims: 0,
      activeWarnings: 0,
    },
  }
}

test('deterministic global quiescence authorizes strategic project completion', () => {
  const result = evaluateStrategicProjectCompletionFacts(board(), snapshot())
  assert.equal(result.ready, true)
  assert.equal(result.reason, 'strategic_project_deterministically_complete')
})

test('Jev project-complete candidate is advisory and does not create authority', () => {
  assert.equal(strategicProjectCompletionCandidate({
    milestone_transition: 'project_complete_candidate',
  }), true)

  const blocked = snapshot()
  blocked.counts.incompleteMissions = 1
  const result = authorizeStrategicProjectCompletion({
    board: board(),
    coordinationSnapshot: blocked,
    jevDecision: {
      milestone_transition: 'project_complete_candidate',
    },
  })

  assert.equal(result.candidate, true)
  assert.equal(result.authorized, false)
  assert.equal(result.reason, 'swarm_missions_incomplete')
})

test('project may complete without a Jev candidate when deterministic authority is conclusive', () => {
  const result = authorizeStrategicProjectCompletion({
    board: board(),
    coordinationSnapshot: snapshot(),
    jevDecision: {
      milestone_transition: 'advance_next',
    },
  })

  assert.equal(result.candidate, false)
  assert.equal(result.authorized, true)
})

test('remaining tentative milestone prevents whole-project completion', () => {
  const value = board()
  value.next_milestones = [{ id: 'm-2', title: 'Still planned', status: 'tentative' }]
  const result = evaluateStrategicProjectCompletionFacts(value, snapshot())
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'tentative_milestones_remain')
})

test('missing final verified milestone transition prevents completion', () => {
  const value = board()
  value.transition_state = ''
  const result = evaluateStrategicProjectCompletionFacts(value, snapshot())
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'final_milestone_transition_not_verified')
})

test('empty project cannot auto-complete merely because runtime is idle', () => {
  const value = board()
  value.completed_milestones = []
  const empty = snapshot()
  empty.counts.missions = 0
  const result = evaluateStrategicProjectCompletionFacts(value, empty)
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'no_verified_milestone_history')
})

test('open runtime coordination records independently block completion', () => {
  const cases = [
    ['incompleteObjectives', 1, 'swarm_objectives_incomplete'],
    ['incompleteProjects', 1, 'swarm_projects_incomplete'],
    ['openWork', 1, 'swarm_work_not_quiescent'],
    ['executingWork', 1, 'swarm_work_not_quiescent'],
    ['blockedWork', 1, 'swarm_work_not_quiescent'],
    ['openRequests', 1, 'swarm_requests_open'],
    ['activeClaims', 1, 'swarm_claims_active'],
    ['activeWarnings', 1, 'swarm_warnings_active'],
  ]

  for (const [key, value, reason] of cases) {
    const state = snapshot()
    state.counts[key] = value
    const result = evaluateStrategicProjectCompletionFacts(board(), state)
    assert.equal(result.ready, false, key)
    assert.equal(result.reason, reason, key)
  }
})

test('malformed or incomplete canonical counts fail closed', () => {
  const state = snapshot()
  delete state.counts.activeClaims
  const result = evaluateStrategicProjectCompletionFacts(board(), state)
  assert.equal(result.ready, false)
  assert.equal(result.reason, 'missing_or_invalid_count_activeClaims')
})
