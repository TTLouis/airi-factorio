function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function operationalCounts(snapshot) {
  const counts = snapshot?.counts && typeof snapshot.counts === 'object'
    ? snapshot.counts
    : {}
  const required = [
    'missions',
    'incompleteMissions',
    'objectives',
    'incompleteObjectives',
    'projects',
    'incompleteProjects',
    'openWork',
    'executingWork',
    'blockedWork',
    'openRequests',
    'activeClaims',
    'activeWarnings',
  ]
  const normalized = {}
  for (const key of required) {
    const value = nonNegativeInteger(counts[key])
    if (value === undefined) {
      return {
        valid: false,
        reason: `missing_or_invalid_count_${key}`,
      }
    }
    normalized[key] = value
  }
  return {
    valid: true,
    counts: normalized,
  }
}

export function evaluateStrategicProjectCompletionFacts(board, coordinationSnapshot) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    return {
      ready: false,
      reason: 'missing_strategic_board',
    }
  }
  if (!coordinationSnapshot || coordinationSnapshot.schema !== 'swarm_coordination_snapshot_v1') {
    return {
      ready: false,
      reason: 'missing_canonical_coordination_snapshot',
    }
  }

  const operational = operationalCounts(coordinationSnapshot)
  if (!operational.valid) {
    return {
      ready: false,
      reason: operational.reason,
    }
  }
  const counts = operational.counts

  if (board.status === 'completed') {
    return {
      ready: true,
      reason: 'already_completed',
      counts,
    }
  }
  if (board.status !== 'active') {
    return {
      ready: false,
      reason: 'strategic_board_not_active',
      counts,
    }
  }
  if (board.current_milestone) {
    return {
      ready: false,
      reason: 'current_milestone_still_active',
      counts,
    }
  }
  if (Array.isArray(board.next_milestones) && board.next_milestones.length > 0) {
    return {
      ready: false,
      reason: 'tentative_milestones_remain',
      counts,
    }
  }
  if (!['awaiting_next_milestone', 'awaiting_project_review'].includes(board.transition_state)) {
    return {
      ready: false,
      reason: 'final_milestone_transition_not_verified',
      counts,
    }
  }
  if (!Array.isArray(board.completed_milestones) || board.completed_milestones.length === 0) {
    return {
      ready: false,
      reason: 'no_verified_milestone_history',
      counts,
    }
  }
  if (counts.missions === 0) {
    return {
      ready: false,
      reason: 'no_swarm_mission_history',
      counts,
    }
  }
  if (counts.incompleteMissions > 0) {
    return {
      ready: false,
      reason: 'swarm_missions_incomplete',
      counts,
    }
  }
  if (counts.incompleteObjectives > 0) {
    return {
      ready: false,
      reason: 'swarm_objectives_incomplete',
      counts,
    }
  }
  if (counts.incompleteProjects > 0) {
    return {
      ready: false,
      reason: 'swarm_projects_incomplete',
      counts,
    }
  }
  if (counts.openWork > 0 || counts.executingWork > 0 || counts.blockedWork > 0) {
    return {
      ready: false,
      reason: 'swarm_work_not_quiescent',
      counts,
    }
  }
  if (counts.openRequests > 0) {
    return {
      ready: false,
      reason: 'swarm_requests_open',
      counts,
    }
  }
  if (counts.activeClaims > 0) {
    return {
      ready: false,
      reason: 'swarm_claims_active',
      counts,
    }
  }
  if (counts.activeWarnings > 0) {
    return {
      ready: false,
      reason: 'swarm_warnings_active',
      counts,
    }
  }

  return {
    ready: true,
    reason: 'strategic_project_deterministically_complete',
    counts,
  }
}

export function strategicProjectCompletionCandidate(jevDecision) {
  return jevDecision?.milestone_transition === 'project_complete_candidate'
}

export function authorizeStrategicProjectCompletion({
  board,
  coordinationSnapshot,
  jevDecision,
} = {}) {
  const facts = evaluateStrategicProjectCompletionFacts(board, coordinationSnapshot)
  return {
    authorized: facts.ready === true,
    reason: facts.reason,
    candidate: strategicProjectCompletionCandidate(jevDecision),
    facts,
  }
}
