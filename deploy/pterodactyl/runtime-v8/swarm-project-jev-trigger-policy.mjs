function count(snapshot, key) {
  const value = snapshot?.counts?.[key]
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function busy(snapshot) {
  return count(snapshot, 'executingWork') > 0
    || count(snapshot, 'activeClaims') > 0
}

function blocked(snapshot) {
  return count(snapshot, 'blockedWork') > 0
    || count(snapshot, 'activeWarnings') > 0
}

function hierarchyTuple(snapshot) {
  return [
    count(snapshot, 'incompleteMissions'),
    count(snapshot, 'incompleteObjectives'),
    count(snapshot, 'incompleteProjects'),
  ].join(':')
}

function strategicRevision(board) {
  return Number.isSafeInteger(board?.revision) && board.revision > 0
    ? board.revision
    : 0
}

export function projectJevTriggerReasons(previousSnapshot, currentSnapshot, {
  previousBoard,
  currentBoard,
} = {}) {
  if (!currentSnapshot || currentSnapshot.schema !== 'swarm_coordination_snapshot_v1') {
    return {
      trigger: false,
      reasons: [],
      reason: 'invalid_current_snapshot',
    }
  }

  if (!previousSnapshot) {
    return {
      trigger: true,
      reasons: ['initial_snapshot'],
      reason: 'initial_snapshot',
    }
  }

  const reasons = []

  const previousCursor = typeof previousSnapshot.eventCursor === 'string'
    ? previousSnapshot.eventCursor
    : ''
  const currentCursor = typeof currentSnapshot.eventCursor === 'string'
    ? currentSnapshot.eventCursor
    : ''
  if (currentCursor !== previousCursor) reasons.push('coordination_event')

  if (strategicRevision(currentBoard) !== strategicRevision(previousBoard)) {
    reasons.push('strategic_board_changed')
  }

  const wasBusy = busy(previousSnapshot)
  const isBusy = busy(currentSnapshot)
  if (wasBusy && !isBusy) reasons.push('runtime_became_quiescent')
  else if (!wasBusy && isBusy) reasons.push('runtime_became_active')

  if (blocked(previousSnapshot) !== blocked(currentSnapshot)) {
    reasons.push('blocker_state_changed')
  }

  if (hierarchyTuple(previousSnapshot) !== hierarchyTuple(currentSnapshot)) {
    reasons.push('hierarchy_completion_changed')
  }

  if (count(previousSnapshot, 'openRequests') !== count(currentSnapshot, 'openRequests')) {
    reasons.push('request_pressure_changed')
  }

  return {
    trigger: reasons.length > 0,
    reasons,
    reason: reasons.join(',') || 'no_semantic_change',
  }
}
