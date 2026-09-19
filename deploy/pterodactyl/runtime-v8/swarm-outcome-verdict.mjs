const EVIDENCE_KINDS = new Set(['observation', 'result', 'operation_receipt'])
const SEMANTIC_EVIDENCE_KINDS = new Set(['observation', 'result'])

function refs(value) {
  return (Array.isArray(value) ? value : []).filter((item) => (
    item
    && typeof item === 'object'
    && EVIDENCE_KINDS.has(String(item.kind ?? ''))
    && typeof item.id === 'string'
    && item.id.trim().length > 0
  ))
}

function hasAnyEvidence(value) {
  return refs(value).length > 0
}

export function hasSemanticEvidence(value) {
  return refs(value).some(item => SEMANTIC_EVIDENCE_KINDS.has(item.kind))
}

function acceptanceVerdict(entity = {}) {
  const conditions = Array.isArray(entity.acceptance) ? entity.acceptance : []
  const state = entity.acceptanceState && typeof entity.acceptanceState === 'object'
    ? entity.acceptanceState
    : {}

  let groundedSatisfied = 0
  let ledgerSatisfied = 0
  let receiptOnly = 0
  let unsatisfied = 0

  for (const condition of conditions) {
    const id = typeof condition?.id === 'string' ? condition.id : ''
    const evaluation = id ? state[id] : undefined
    if (evaluation?.satisfied !== true) {
      unsatisfied += 1
      continue
    }

    if (!hasAnyEvidence(evaluation.evidence)) {
      unsatisfied += 1
      continue
    }

    ledgerSatisfied += 1
    if (hasSemanticEvidence(evaluation.evidence)) groundedSatisfied += 1
    else receiptOnly += 1
  }

  return {
    has_basis: conditions.length > 0,
    total: conditions.length,
    ledger_satisfied: ledgerSatisfied,
    grounded_satisfied: groundedSatisfied,
    receipt_only: receiptOnly,
    unsatisfied,
    all_ledger_satisfied: conditions.length > 0 && ledgerSatisfied === conditions.length,
    all_grounded_satisfied: conditions.length > 0 && groundedSatisfied === conditions.length,
  }
}

function base(state, authoritative, reason, extra = {}) {
  return {
    state,
    authoritative,
    reason,
    ...extra,
  }
}

export function evaluateWorkOutcome(work = {}) {
  const status = String(work?.status ?? '')
  const evidence = refs(work?.evidence)

  if (status === 'cancelled') return base('invalidated', true, 'work_cancelled')
  if (status === 'blocked') return base('blocked', true, 'canonical_work_blocked')

  if (status === 'completed') {
    if (hasSemanticEvidence(evidence)) {
      return base('completed', true, 'completed_with_semantic_evidence', {
        evidence_count: evidence.length,
      })
    }
    if (evidence.length > 0) {
      return base('progress', false, 'receipt_only_not_semantic_completion', {
        evidence_count: evidence.length,
      })
    }
    return base('incomplete', false, 'completed_without_evidence', {
      evidence_count: 0,
    })
  }

  if (evidence.length > 0 || status === 'active' || status === 'claimed') {
    return base('progress', true, 'work_in_progress', {
      evidence_count: evidence.length,
    })
  }

  return base('incomplete', true, 'work_not_completed', {
    evidence_count: evidence.length,
  })
}

export function evaluateObjectiveOutcome(objective = {}) {
  const status = String(objective?.status ?? '')
  const acceptance = acceptanceVerdict(objective)

  if (status === 'cancelled') return base('invalidated', true, 'objective_cancelled', { acceptance })
  if (status === 'blocked') return base('blocked', true, 'canonical_objective_blocked', { acceptance })

  if (status === 'satisfied') {
    if (!acceptance.has_basis) {
      return base('incomplete', false, 'satisfied_objective_without_acceptance_basis', { acceptance })
    }
    if (acceptance.all_grounded_satisfied) {
      return base('completed', true, 'objective_acceptance_grounded', { acceptance })
    }
    if (acceptance.all_ledger_satisfied && acceptance.receipt_only > 0) {
      return base('progress', false, 'objective_acceptance_receipt_only', { acceptance })
    }
    return base('incomplete', false, 'objective_status_exceeds_acceptance_evidence', { acceptance })
  }

  if (acceptance.grounded_satisfied > 0 || hasSemanticEvidence(objective?.evidence) || status === 'active') {
    return base('progress', true, 'objective_progress', { acceptance })
  }

  return base('incomplete', true, 'objective_not_satisfied', { acceptance })
}

function objectivesForMission(mission, objectives) {
  const byId = new Map()
  for (const objective of Array.isArray(objectives) ? objectives : []) {
    if (objective && typeof objective.id === 'string') byId.set(objective.id, objective)
  }
  const ids = Array.isArray(mission?.objectiveIds) ? mission.objectiveIds : []
  return ids.map(id => byId.get(id)).filter(Boolean)
}

export function evaluateMissionOutcome(mission = {}, { objectives = [] } = {}) {
  const status = String(mission?.status ?? '')
  const blockers = Array.isArray(mission?.blockers) ? mission.blockers : []
  const acceptance = acceptanceVerdict(mission)
  const missionObjectives = objectivesForMission(mission, objectives)
  const expectedObjectiveIds = Array.isArray(mission?.objectiveIds) ? mission.objectiveIds : []
  const objectiveVerdicts = missionObjectives.map(objective => ({
    id: objective.id,
    verdict: evaluateObjectiveOutcome(objective),
  }))
  const allObjectivesPresent = missionObjectives.length === expectedObjectiveIds.length
  const allObjectivesCompleted = allObjectivesPresent
    && objectiveVerdicts.every(item => item.verdict.state === 'completed' && item.verdict.authoritative === true)
  const ownAcceptanceGrounded = acceptance.total === 0 || acceptance.all_grounded_satisfied
  const hasAcceptanceBasis = expectedObjectiveIds.length > 0 || acceptance.total > 0

  if (status === 'cancelled' || status === 'failed') {
    return base('invalidated', true, status === 'failed' ? 'mission_failed' : 'mission_cancelled', {
      acceptance,
      objectives: objectiveVerdicts,
    })
  }

  if (status === 'blocked' || blockers.length > 0) {
    return base('blocked', true, 'canonical_mission_blocked', {
      acceptance,
      objectives: objectiveVerdicts,
    })
  }

  if (status === 'satisfied') {
    if (!hasAcceptanceBasis) {
      return base('incomplete', false, 'satisfied_mission_without_acceptance_basis', {
        acceptance,
        objectives: objectiveVerdicts,
      })
    }
    if (!allObjectivesPresent) {
      return base('incomplete', false, 'mission_objective_snapshot_incomplete', {
        acceptance,
        objectives: objectiveVerdicts,
      })
    }
    if (allObjectivesCompleted && ownAcceptanceGrounded) {
      return base('completed', true, 'mission_acceptance_grounded', {
        acceptance,
        objectives: objectiveVerdicts,
      })
    }
    return base('progress', false, 'mission_status_exceeds_grounded_evidence', {
      acceptance,
      objectives: objectiveVerdicts,
    })
  }

  const anyObjectiveProgress = objectiveVerdicts.some(item => ['progress', 'completed'].includes(item.verdict.state))
  if (anyObjectiveProgress || acceptance.grounded_satisfied > 0 || status === 'active') {
    return base('progress', true, 'mission_progress', {
      acceptance,
      objectives: objectiveVerdicts,
    })
  }

  return base('incomplete', true, 'mission_not_satisfied', {
    acceptance,
    objectives: objectiveVerdicts,
  })
}

export function evaluateStrategicMilestoneOutcome(board = {}, verification = {}) {
  const milestone = board?.current_milestone
  if (!milestone || typeof milestone !== 'object') {
    return base('incomplete', true, 'no_current_strategic_milestone')
  }

  if (verification?.invalidated === true) {
    return base('invalidated', true, 'strategic_milestone_invalidated')
  }

  if (verification?.verified !== true) {
    return base('incomplete', true, 'strategic_milestone_not_verified')
  }

  if (!hasSemanticEvidence(verification?.evidence)) {
    return hasAnyEvidence(verification?.evidence)
      ? base('progress', false, 'strategic_milestone_receipt_only')
      : base('incomplete', false, 'strategic_milestone_verification_without_evidence')
  }

  return base('completed', true, 'strategic_milestone_verified')
}

export function evaluateSwarmOutcomeSnapshot({
  work,
  objective,
  mission,
  objectives = [],
  strategicBoard,
  strategicMilestoneVerification,
} = {}) {
  return {
    authority: 'verdict_only',
    effects: [],
    work: work ? evaluateWorkOutcome(work) : undefined,
    objective: objective ? evaluateObjectiveOutcome(objective) : undefined,
    mission: mission ? evaluateMissionOutcome(mission, { objectives }) : undefined,
    strategic_milestone: strategicBoard
      ? evaluateStrategicMilestoneOutcome(strategicBoard, strategicMilestoneVerification)
      : undefined,
  }
}
