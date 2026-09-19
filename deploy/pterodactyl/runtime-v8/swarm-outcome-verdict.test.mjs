import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateMissionOutcome,
  evaluateObjectiveOutcome,
  evaluateStrategicMilestoneOutcome,
  evaluateSwarmOutcomeSnapshot,
  evaluateWorkOutcome,
  hasSemanticEvidence,
} from './swarm-outcome-verdict.mjs'

const observation = { kind: 'observation', id: 'obs-1', tick: 10 }
const result = { kind: 'result', id: 'result-1', tick: 11 }
const receipt = { kind: 'operation_receipt', id: 'batch-1', tick: 12 }

test('operation receipts alone never prove semantic work completion', () => {
  assert.equal(hasSemanticEvidence([receipt]), false)
  assert.equal(hasSemanticEvidence([observation]), true)

  const receiptOnly = evaluateWorkOutcome({
    status: 'completed',
    evidence: [receipt],
  })
  assert.equal(receiptOnly.state, 'progress')
  assert.equal(receiptOnly.authoritative, false)
  assert.equal(receiptOnly.reason, 'receipt_only_not_semantic_completion')

  const grounded = evaluateWorkOutcome({
    status: 'completed',
    evidence: [result],
  })
  assert.equal(grounded.state, 'completed')
  assert.equal(grounded.authoritative, true)
})

test('objective completion requires grounded acceptance evidence, not only a satisfied flag', () => {
  const receiptOnly = evaluateObjectiveOutcome({
    status: 'satisfied',
    acceptance: [{ id: 'a-1' }],
    acceptanceState: {
      'a-1': { conditionId: 'a-1', satisfied: true, evidence: [receipt], tick: 20 },
    },
  })
  assert.equal(receiptOnly.state, 'progress')
  assert.equal(receiptOnly.authoritative, false)
  assert.equal(receiptOnly.reason, 'objective_acceptance_receipt_only')

  const grounded = evaluateObjectiveOutcome({
    status: 'satisfied',
    acceptance: [{ id: 'a-1' }],
    acceptanceState: {
      'a-1': { conditionId: 'a-1', satisfied: true, evidence: [observation], tick: 20 },
    },
  })
  assert.equal(grounded.state, 'completed')
  assert.equal(grounded.authoritative, true)
})

test('mission completion requires all referenced objectives to be present and grounded', () => {
  const mission = {
    status: 'satisfied',
    objectiveIds: ['o-1', 'o-2'],
    acceptance: [],
    acceptanceState: {},
    blockers: [],
  }
  const completedObjective = {
    id: 'o-1',
    status: 'satisfied',
    acceptance: [{ id: 'a-1' }],
    acceptanceState: {
      'a-1': { conditionId: 'a-1', satisfied: true, evidence: [result], tick: 30 },
    },
  }
  const receiptObjective = {
    id: 'o-2',
    status: 'satisfied',
    acceptance: [{ id: 'a-2' }],
    acceptanceState: {
      'a-2': { conditionId: 'a-2', satisfied: true, evidence: [receipt], tick: 30 },
    },
  }

  const weak = evaluateMissionOutcome(mission, {
    objectives: [completedObjective, receiptObjective],
  })
  assert.equal(weak.state, 'progress')
  assert.equal(weak.authoritative, false)

  const complete = evaluateMissionOutcome(mission, {
    objectives: [
      completedObjective,
      {
        ...receiptObjective,
        acceptanceState: {
          'a-2': { conditionId: 'a-2', satisfied: true, evidence: [observation], tick: 30 },
        },
      },
    ],
  })
  assert.equal(complete.state, 'completed')
  assert.equal(complete.authoritative, true)
})

test('missing mission objective snapshots never count as completion', () => {
  const verdict = evaluateMissionOutcome({
    status: 'satisfied',
    objectiveIds: ['o-1', 'o-2'],
    acceptance: [],
    acceptanceState: {},
    blockers: [],
  }, {
    objectives: [{
      id: 'o-1',
      status: 'satisfied',
      acceptance: [{ id: 'a-1' }],
      acceptanceState: {
        'a-1': { conditionId: 'a-1', satisfied: true, evidence: [result], tick: 30 },
      },
    }],
  })
  assert.equal(verdict.state, 'incomplete')
  assert.equal(verdict.authoritative, false)
  assert.equal(verdict.reason, 'mission_objective_snapshot_incomplete')
})

test('canonical blocked and cancelled states remain visible without granting mutation authority', () => {
  assert.equal(evaluateWorkOutcome({ status: 'blocked', evidence: [] }).state, 'blocked')
  assert.equal(evaluateObjectiveOutcome({ status: 'cancelled' }).state, 'invalidated')
  assert.equal(evaluateMissionOutcome({ status: 'failed', objectiveIds: [], blockers: [] }).state, 'invalidated')
})

test('strategic milestone never closes merely because a mission is complete', () => {
  const board = {
    current_milestone: { id: 'm-1', title: 'Establish oil processing' },
  }

  assert.equal(evaluateStrategicMilestoneOutcome(board, {
    verified: false,
    evidence: [observation],
  }).state, 'incomplete')

  const receiptOnly = evaluateStrategicMilestoneOutcome(board, {
    verified: true,
    evidence: [receipt],
  })
  assert.equal(receiptOnly.state, 'progress')
  assert.equal(receiptOnly.authoritative, false)

  const verified = evaluateStrategicMilestoneOutcome(board, {
    verified: true,
    evidence: [observation],
  })
  assert.equal(verified.state, 'completed')
  assert.equal(verified.authoritative, true)
})

test('snapshot evaluator is verdict-only and has no state effects', () => {
  const evaluated = evaluateSwarmOutcomeSnapshot({
    work: { status: 'completed', evidence: [result] },
    strategicBoard: {
      current_milestone: { id: 'm-1', title: 'Bootstrap' },
    },
    strategicMilestoneVerification: {
      verified: true,
      evidence: [observation],
    },
  })

  assert.equal(evaluated.authority, 'verdict_only')
  assert.deepEqual(evaluated.effects, [])
  assert.equal(evaluated.work.state, 'completed')
  assert.equal(evaluated.strategic_milestone.state, 'completed')
})
