const DEFAULT_TIMEOUT_TICKS = 30 * 60 * 60
const MAX_TIMEOUT_TICKS = 2 * 60 * 60 * 60
const MAX_CHECKS = 7200

const CONDITION_STATUS = Object.freeze({
  request_status: 'satisfied',
  work_status: 'completed',
  objective_status: 'satisfied',
  mission_status: 'satisfied',
  project_status: 'complete',
})

function clean(value, max = 120) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedTimeoutTicks(value) {
  return Number.isSafeInteger(value)
    ? Math.max(60, Math.min(value, MAX_TIMEOUT_TICKS))
    : DEFAULT_TIMEOUT_TICKS
}

export function sanitizeSwarmWaitCondition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = String(raw.kind ?? '')
  const expected_status = CONDITION_STATUS[kind]
  if (!expected_status) return undefined

  const record_id = clean(raw.record_id ?? raw.id, 120)
  if (!record_id) return undefined

  return {
    kind,
    record_id,
    expected_status,
    min_revision: nonNegativeInteger(raw.min_revision),
  }
}

export function makeSwarmConditionWait(condition, {
  id,
  mode = 'completion',
  registeredTick = 0,
  timeoutTicks = DEFAULT_TIMEOUT_TICKS,
  maxChecks = 900,
  ownerGoalId,
  ownerMilestoneId,
} = {}) {
  const normalized = sanitizeSwarmWaitCondition(condition)
  const tick = nonNegativeInteger(registeredTick)
  if (!normalized || tick === undefined) return undefined

  return {
    kind: 'swarm_condition_wait_v1',
    id: clean(id || `swarm_wait_${tick.toString(36)}`, 120),
    owner_goal_id: clean(ownerGoalId, 120) || undefined,
    owner_milestone_id: clean(ownerMilestoneId, 120) || undefined,
    mode: mode === 'passive_progress' ? 'passive_progress' : 'completion',
    condition: normalized,
    state: 'active',
    checks: 0,
    max_checks: Number.isSafeInteger(maxChecks)
      ? Math.max(1, Math.min(maxChecks, MAX_CHECKS))
      : 900,
    timeout_ticks: boundedTimeoutTicks(timeoutTicks),
    registered_tick: tick,
    updated_tick: tick,
  }
}

function collectionFor(snapshot, kind) {
  if (!snapshot || typeof snapshot !== 'object') return []
  if (kind === 'request_status') return Array.isArray(snapshot.requests) ? snapshot.requests : []
  if (kind === 'work_status') return Array.isArray(snapshot.work) ? snapshot.work : []
  if (kind === 'objective_status') return Array.isArray(snapshot.objectives) ? snapshot.objectives : []
  if (kind === 'mission_status') return Array.isArray(snapshot.missions) ? snapshot.missions : []
  if (kind === 'project_status') return Array.isArray(snapshot.projects) ? snapshot.projects : []
  return []
}

export function observeSwarmWaitCondition(condition, snapshot = {}) {
  const normalized = sanitizeSwarmWaitCondition(condition)
  if (!normalized) {
    return {
      stale: true,
      error: 'invalid_condition',
      satisfied: false,
      progressing: false,
      progress_known: true,
    }
  }

  const record = collectionFor(snapshot, normalized.kind)
    .find(item => String(item?.id ?? '') === normalized.record_id)

  if (!record) {
    return {
      stale: true,
      error: 'exact_target_missing',
      satisfied: false,
      progressing: false,
      progress_known: true,
    }
  }

  const revision = nonNegativeInteger(record.revision)
  if (normalized.min_revision !== undefined && (revision === undefined || revision < normalized.min_revision)) {
    return {
      stale: true,
      error: 'target_revision_regressed',
      satisfied: false,
      progressing: false,
      progress_known: true,
      revision,
    }
  }

  const status = clean(record.status, 80)
  const satisfied = status === normalized.expected_status
  const terminalUnsatisfied = (
    status === 'cancelled'
    || status === 'failed'
  )

  return {
    stale: false,
    satisfied,
    progressing: !satisfied && !terminalUnsatisfied,
    progress_known: true,
    terminal_unsatisfied: terminalUnsatisfied,
    status,
    revision,
  }
}

export function applySwarmConditionObservation(wait, observation, {
  tick,
} = {}) {
  if (!wait || wait.state !== 'active') return { wait, action: 'stale' }

  const nowTick = nonNegativeInteger(tick)
  if (nowTick === undefined) {
    return {
      wait: { ...wait, state: 'failed' },
      action: 'failed',
      reason: 'missing_simulation_tick',
    }
  }

  const checks = (Number.isSafeInteger(wait.checks) ? wait.checks : 0) + 1
  const base = {
    ...wait,
    checks,
    updated_tick: nowTick,
    last_observation: observation,
  }

  if (observation?.stale === true) {
    return {
      wait: { ...base, state: 'failed' },
      action: 'failed',
      reason: clean(observation?.error || 'stale_exact_identity', 160),
    }
  }

  if (observation?.error) {
    return {
      wait: { ...base, state: 'failed' },
      action: 'failed',
      reason: clean(observation.error, 160),
    }
  }

  const elapsed = Number.isSafeInteger(wait.registered_tick)
    ? Math.max(0, nowTick - wait.registered_tick)
    : 0
  const timedOut = Number.isSafeInteger(wait.timeout_ticks)
    && elapsed >= wait.timeout_ticks
  const checksExhausted = Number.isSafeInteger(wait.max_checks)
    && checks >= wait.max_checks

  if (observation?.satisfied === true) {
    return {
      wait: { ...base, state: 'satisfied' },
      action: 'verified',
    }
  }

  if (timedOut || checksExhausted) {
    return {
      wait: { ...base, state: 'timeout' },
      action: 'timeout',
      reason: 'condition_timeout',
    }
  }

  if (observation?.terminal_unsatisfied === true) {
    return {
      wait: { ...base, state: 'failed' },
      action: 'wake',
      reason: 'target_terminal_without_satisfaction',
    }
  }

  if (wait.mode === 'passive_progress' && observation?.progressing !== true) {
    return {
      wait: { ...base, state: 'failed' },
      action: 'wake',
      reason: 'passive_progress_stopped',
    }
  }

  return {
    wait: base,
    action: 'waiting',
  }
}

export function pollSwarmConditionWait(wait, snapshot, { tick } = {}) {
  if (!wait || wait.state !== 'active') return { wait, action: 'stale' }
  const observation = observeSwarmWaitCondition(wait.condition, snapshot)
  return applySwarmConditionObservation(wait, observation, { tick })
}
