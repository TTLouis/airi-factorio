export function authorizeStrategicMilestoneCompletion(outcomeSnapshot) {
  if (!outcomeSnapshot || typeof outcomeSnapshot !== 'object' || Array.isArray(outcomeSnapshot)) {
    return {
      authorized: false,
      reason: 'missing_outcome_snapshot',
    }
  }

  if (outcomeSnapshot.authority !== 'verdict_only') {
    return {
      authorized: false,
      reason: 'outcome_snapshot_not_verdict_authority',
    }
  }

  if (!Array.isArray(outcomeSnapshot.effects) || outcomeSnapshot.effects.length !== 0) {
    return {
      authorized: false,
      reason: 'outcome_snapshot_has_effects',
    }
  }

  const milestone = outcomeSnapshot.strategic_milestone
  if (!milestone || typeof milestone !== 'object' || Array.isArray(milestone)) {
    return {
      authorized: false,
      reason: 'missing_strategic_milestone_verdict',
    }
  }

  if (milestone.state !== 'completed' || milestone.authoritative !== true) {
    return {
      authorized: false,
      reason: 'strategic_milestone_not_authoritatively_complete',
      verdict: milestone,
    }
  }

  if (milestone.reason !== 'strategic_milestone_verified') {
    return {
      authorized: false,
      reason: 'strategic_milestone_verdict_source_mismatch',
      verdict: milestone,
    }
  }

  return {
    authorized: true,
    reason: 'strategic_milestone_verified',
    verdict: milestone,
  }
}
