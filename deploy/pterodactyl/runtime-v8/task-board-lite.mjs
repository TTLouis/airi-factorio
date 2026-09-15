const MAX_STEPS = 30
const MAX_EVENTS = 64
const MAX_EVIDENCE = 32

function cleanText(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function normalizeStep(value) {
  return cleanText(value, 500).toLocaleLowerCase()
}

function boundedPlan(plan) {
  return Array.isArray(plan) ? plan.slice(0, MAX_STEPS).map(step => cleanText(step, 500)).filter(Boolean) : []
}

function clampIndex(value, length) {
  if (length <= 0) return 0
  if (!Number.isSafeInteger(value)) return 0
  return Math.min(Math.max(value, 0), length - 1)
}

function event(board, type, now, details = {}) {
  const events = [...(board.events ?? []), {
    seq: (board.event_sequence ?? 0) + 1,
    type,
    at: now,
    revision: board.revision,
    ...details,
  }].slice(-MAX_EVENTS)
  return { ...board, event_sequence: (board.event_sequence ?? 0) + 1, events }
}

function stepId(index) {
  return `step_${index + 1}`
}

function statusForIndex(index, activeIndex, boardStatus) {
  if (index < activeIndex || boardStatus === 'completed') return 'completed'
  if (index > activeIndex) return 'pending'
  if (boardStatus === 'blocked') return 'blocked'
  if (boardStatus === 'paused') return 'paused'
  return 'active'
}

function applyStatuses(board, activeIndex = board.active_index ?? 0) {
  const safeIndex = clampIndex(activeIndex, board.steps.length)
  return {
    ...board,
    active_index: safeIndex,
    active_step_id: board.status === 'completed' || board.steps.length === 0 ? undefined : board.steps[safeIndex]?.id,
    completed_count: board.status === 'completed' ? board.steps.length : safeIndex,
    total_steps: board.steps.length,
    steps: board.steps.map((step, index) => ({ ...step, status: statusForIndex(index, safeIndex, board.status) })),
  }
}

export function createTaskBoard(plan, currentStep, { goalId = '', now = Date.now() } = {}) {
  const descriptions = boundedPlan(plan)
  const activeIndex = clampIndex(currentStep, descriptions.length)
  let board = {
    kind: 'task_board_lite',
    goal_id: cleanText(goalId, 100),
    status: descriptions.length ? 'active' : 'completed',
    blocker: '',
    pause_reason: '',
    revision: 1,
    event_sequence: 0,
    active_index: activeIndex,
    active_step_id: undefined,
    completed_count: descriptions.length ? activeIndex : 0,
    total_steps: descriptions.length,
    steps: descriptions.map((description, index) => ({ id: stepId(index), description, status: 'pending', revision: 1 })),
    evidence: [],
    events: [],
    created_at: now,
    updated_at: now,
  }
  board = applyStatuses(board, activeIndex)
  return event(board, 'created', now, { active_step_id: board.active_step_id, total_steps: board.total_steps })
}

function findStep(board, description) {
  const target = normalizeStep(description)
  if (!target) return -1
  return board.steps.findIndex(step => normalizeStep(step.description) === target)
}

function completedPrefixMatches(board, incoming) {
  const count = board.completed_count ?? 0
  if (count <= 0 || incoming.length < count) return false
  for (let index = 0; index < count; index++) {
    if (normalizeStep(board.steps[index]?.description) !== normalizeStep(incoming[index])) return false
  }
  return true
}

function replanRemaining(board, incoming, incomingIndex, now) {
  const completed = board.steps.slice(0, board.completed_count).map(step => ({ ...step, status: 'completed' }))
  const remainingDescriptions = incoming.slice(Math.max(incomingIndex, board.completed_count))
  if (remainingDescriptions.length === 0) return board
  const steps = [
    ...completed,
    ...remainingDescriptions.map((description, offset) => ({
      id: stepId(completed.length + offset),
      description,
      status: 'pending',
      revision: 1,
    })),
  ].slice(0, MAX_STEPS)
  let next = {
    ...board,
    status: 'active',
    blocker: '',
    pause_reason: '',
    revision: board.revision + 1,
    steps,
    active_index: completed.length,
    updated_at: now,
  }
  next = applyStatuses(next, completed.length)
  return event(next, 'replanned', now, { preserved_completed: completed.length, total_steps: next.total_steps })
}

export function reconcileTaskBoard(board, plan, currentStep, { now = Date.now(), allowReplan = false } = {}) {
  const incoming = boundedPlan(plan)
  if (!board || board.kind !== 'task_board_lite') return createTaskBoard(incoming, currentStep, { now })
  if (incoming.length === 0) return board

  const incomingIndex = clampIndex(currentStep, incoming.length)
  const incomingActive = incoming[incomingIndex]
  const matchedIndex = findStep(board, incomingActive)
  const currentIndex = board.active_index ?? 0

  if (matchedIndex >= currentIndex) {
    if (matchedIndex === currentIndex) return board
    let next = {
      ...board,
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: board.revision + 1,
      updated_at: now,
    }
    next = applyStatuses(next, matchedIndex)
    return event(next, 'advanced', now, { from_step: board.active_step_id, to_step: next.active_step_id })
  }

  const exactSamePlan = incoming.length === board.steps.length
    && incoming.every((description, index) => normalizeStep(description) === normalizeStep(board.steps[index]?.description))
  if (exactSamePlan && incomingIndex > currentIndex) {
    let next = { ...board, status: 'active', blocker: '', pause_reason: '', revision: board.revision + 1, updated_at: now }
    next = applyStatuses(next, incomingIndex)
    return event(next, 'advanced', now, { from_step: board.active_step_id, to_step: next.active_step_id })
  }

  // Normal continuation updates do not get to silently rewrite the canonical
  // task list. Once progress exists, a model may revise only the remaining
  // suffix while preserving the completed prefix. Explicit failure recovery
  // can also replace the remaining suffix without resetting completed work.
  if ((allowReplan || completedPrefixMatches(board, incoming)) && incomingActive && normalizeStep(incomingActive) !== normalizeStep(board.steps[currentIndex]?.description)) {
    return replanRemaining(board, incoming, incomingIndex, now)
  }

  return board
}

export function setTaskBoardStatus(board, status, { blocker = '', pauseReason = '', now = Date.now() } = {}) {
  if (!board || board.kind !== 'task_board_lite') return board
  if (!['active', 'blocked', 'paused', 'completed'].includes(status)) return board
  if (board.status === status && board.blocker === blocker && board.pause_reason === pauseReason) return board
  let next = {
    ...board,
    status,
    blocker: cleanText(blocker, 500),
    pause_reason: cleanText(pauseReason, 300),
    revision: board.revision + 1,
    updated_at: now,
  }
  next = applyStatuses(next, next.active_index)
  return event(next, status, now, { active_step_id: next.active_step_id })
}

export function addTaskBoardEvidence(board, { kind = 'operation_receipt', summary = '', ref = '', now = Date.now() } = {}) {
  if (!board || board.kind !== 'task_board_lite') return board
  const record = {
    id: `evidence_${(board.evidence_sequence ?? 0) + 1}`,
    kind: cleanText(kind, 64),
    summary: cleanText(summary, 1200),
    ref: cleanText(ref, 160),
    at: now,
    step_id: board.active_step_id,
  }
  let next = {
    ...board,
    evidence_sequence: (board.evidence_sequence ?? 0) + 1,
    evidence: [...(board.evidence ?? []), record].slice(-MAX_EVIDENCE),
    revision: board.revision + 1,
    updated_at: now,
  }
  return event(next, 'evidence', now, { evidence_id: record.id, step_id: record.step_id })
}

export function taskBoardProgress(board) {
  if (!board || board.kind !== 'task_board_lite') return undefined
  const active = board.steps[board.active_index ?? 0]
  return {
    status: board.status,
    completed: board.completed_count ?? 0,
    total: board.total_steps ?? board.steps.length,
    index: board.status === 'completed' ? board.steps.length : (board.active_index ?? 0) + 1,
    step_id: board.active_step_id,
    step: active?.description ?? '',
    blocker: board.blocker ?? '',
    pause_reason: board.pause_reason ?? '',
    revision: board.revision,
  }
}

export function sanitizeTaskBoard(value, { fallbackPlan = [], fallbackCurrentStep = 0, goalId = '', now = Date.now() } = {}) {
  if (!value || value.kind !== 'task_board_lite' || !Array.isArray(value.steps)) {
    return createTaskBoard(fallbackPlan, fallbackCurrentStep, { goalId, now })
  }
  const descriptions = value.steps.slice(0, MAX_STEPS).map(step => cleanText(step?.description, 500)).filter(Boolean)
  let board = createTaskBoard(descriptions, value.active_index, { goalId: value.goal_id ?? goalId, now: Number.isFinite(value.created_at) ? value.created_at : now })
  board = {
    ...board,
    status: ['active', 'blocked', 'paused', 'completed'].includes(value.status) ? value.status : board.status,
    blocker: cleanText(value.blocker, 500),
    pause_reason: cleanText(value.pause_reason, 300),
    revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : board.revision,
    event_sequence: Number.isSafeInteger(value.event_sequence) && value.event_sequence >= 0 ? value.event_sequence : board.event_sequence,
    evidence_sequence: Number.isSafeInteger(value.evidence_sequence) && value.evidence_sequence >= 0 ? value.evidence_sequence : 0,
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).slice(-MAX_EVIDENCE).map(item => ({
      id: cleanText(item?.id, 80),
      kind: cleanText(item?.kind, 64),
      summary: cleanText(item?.summary, 1200),
      ref: cleanText(item?.ref, 160),
      at: Number.isFinite(item?.at) ? item.at : now,
      step_id: cleanText(item?.step_id, 80) || undefined,
    })),
    events: (Array.isArray(value.events) ? value.events : []).slice(-MAX_EVENTS).map(item => ({
      seq: Number.isSafeInteger(item?.seq) ? item.seq : 0,
      type: cleanText(item?.type, 64),
      at: Number.isFinite(item?.at) ? item.at : now,
      revision: Number.isSafeInteger(item?.revision) ? item.revision : 0,
      active_step_id: cleanText(item?.active_step_id, 80) || undefined,
      total_steps: Number.isSafeInteger(item?.total_steps) ? item.total_steps : undefined,
      preserved_completed: Number.isSafeInteger(item?.preserved_completed) ? item.preserved_completed : undefined,
      from_step: cleanText(item?.from_step, 80) || undefined,
      to_step: cleanText(item?.to_step, 80) || undefined,
      evidence_id: cleanText(item?.evidence_id, 80) || undefined,
      step_id: cleanText(item?.step_id, 80) || undefined,
    })),
    created_at: Number.isFinite(value.created_at) ? value.created_at : now,
    updated_at: Number.isFinite(value.updated_at) ? value.updated_at : now,
  }
  return applyStatuses(board, value.active_index)
}
