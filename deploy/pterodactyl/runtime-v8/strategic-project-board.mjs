const NEXT_MILESTONE_LIMIT = 3
const COMPLETED_MILESTONE_LIMIT = 12
const BOARD_STATUSES = new Set(['active', 'blocked', 'paused', 'completed'])
const DEVELOPMENT_DIRECTIONS = new Set(['vertical', 'horizontal', 'maintain', 'recover'])

function clean(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function milestoneId(title) {
  let hash = 2166136261
  for (let index = 0; index < title.length; index++) {
    hash ^= title.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'milestone'
  return `milestone_${slug}_${(hash >>> 0).toString(36)}`
}

function milestone(value, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const title = clean(value.title, 500)
  if (!title) return undefined
  return {
    id: clean(value.id, 100) || milestoneId(title),
    title,
    status,
    completion_summary: clean(value.completion_summary, 800) || undefined,
  }
}

export function sanitizeStrategicProjectBoard(value, {
  goalId = '',
  objective = '',
  status = 'active',
  now = Date.now(),
} = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const current = milestone(source.current_milestone, 'active')
  const completed = (Array.isArray(source.completed_milestones) ? source.completed_milestones : [])
    .slice(-COMPLETED_MILESTONE_LIMIT)
    .map(item => milestone(item, 'completed'))
    .filter(Boolean)
  const next = (Array.isArray(source.next_milestones) ? source.next_milestones : [])
    .slice(0, NEXT_MILESTONE_LIMIT)
    .map(item => milestone(item, 'tentative'))
    .filter(Boolean)

  return {
    kind: 'strategic_project_board_v1',
    goal_id: clean(source.goal_id || goalId, 100),
    title: clean(source.title || objective, 500),
    status: BOARD_STATUSES.has(status) ? status : 'active',
    completed_milestones: completed,
    current_milestone: current,
    next_milestones: next,
    development_direction: DEVELOPMENT_DIRECTIONS.has(source.development_direction)
      ? source.development_direction
      : '',
    transition_state: source.transition_state === 'awaiting_next_milestone'
      ? 'awaiting_next_milestone'
      : '',
    revision: Number.isSafeInteger(source.revision) && source.revision > 0 ? source.revision : 1,
    updated_at: Number.isFinite(source.updated_at) ? source.updated_at : now,
  }
}

export function updateStrategicProjectBoard(current, patch = {}, context = {}) {
  const previous = sanitizeStrategicProjectBoard(current, context)
  const now = Number.isFinite(context.now) ? context.now : Date.now()
  return sanitizeStrategicProjectBoard({
    ...previous,
    completed_milestones: patch.completed_milestones === undefined ? previous.completed_milestones : patch.completed_milestones,
    current_milestone: patch.current_milestone === undefined ? previous.current_milestone : patch.current_milestone,
    next_milestones: patch.next_milestones === undefined ? previous.next_milestones : patch.next_milestones,
    development_direction: patch.development_direction === undefined ? previous.development_direction : patch.development_direction,
    transition_state: patch.transition_state === undefined ? previous.transition_state : patch.transition_state,
    revision: previous.revision + 1,
    updated_at: now,
  }, { ...context, now })
}

export function parseStrategicProjectProposal(value) {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid strategic project proposal')
  const allowed = new Set(['currentMilestone', 'nextMilestones', 'developmentDirection'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Invalid strategic project proposal field')

  const parseMilestone = (entry, label) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid ${label}`)
    if (Object.keys(entry).some(key => !['title', 'completionSummary'].includes(key))) throw new Error(`Invalid ${label} field`)
    const title = clean(entry.title, 500)
    if (!title) throw new Error(`Invalid ${label} title`)
    return { title, completion_summary: clean(entry.completionSummary, 800) || undefined }
  }

  const current = parseMilestone(value.currentMilestone, 'currentMilestone')
  const nextRaw = value.nextMilestones === undefined ? [] : value.nextMilestones
  if (!Array.isArray(nextRaw) || nextRaw.length > NEXT_MILESTONE_LIMIT) throw new Error('Invalid nextMilestones')
  const next = nextRaw.map((entry, index) => parseMilestone(entry, `nextMilestones[${index}]`))
  const direction = value.developmentDirection === undefined ? '' : value.developmentDirection
  if (direction && !DEVELOPMENT_DIRECTIONS.has(direction)) throw new Error('Invalid developmentDirection')

  return {
    current_milestone: current,
    next_milestones: next,
    development_direction: direction,
  }
}

export function completeCurrentStrategicMilestone(current, {
  verified = false,
  now = Date.now(),
  goalId = '',
  objective = '',
  status = 'active',
} = {}) {
  const board = sanitizeStrategicProjectBoard(current, { goalId, objective, status, now })
  if (!verified || !board.current_milestone) {
    return {
      board,
      changed: false,
      reason: verified ? 'no_current_milestone' : 'completion_not_verified',
    }
  }

  const completed = [
    ...board.completed_milestones,
    { ...board.current_milestone, status: 'completed' },
  ].slice(-COMPLETED_MILESTONE_LIMIT)

  return {
    board: sanitizeStrategicProjectBoard({
      ...board,
      completed_milestones: completed,
      current_milestone: undefined,
      transition_state: 'awaiting_next_milestone',
      revision: board.revision + 1,
      updated_at: now,
    }, { goalId, objective, status: 'active', now }),
    changed: true,
    reason: 'milestone_verified_complete',
  }
}

export function activateNextStrategicMilestone(current, {
  now = Date.now(),
  goalId = '',
  objective = '',
  status = 'active',
} = {}) {
  const board = sanitizeStrategicProjectBoard(current, { goalId, objective, status, now })
  if (board.current_milestone) {
    return { board, changed: false, reason: 'current_milestone_still_active' }
  }
  if (board.transition_state !== 'awaiting_next_milestone') {
    return { board, changed: false, reason: 'not_awaiting_next_milestone' }
  }

  const [next, ...rest] = board.next_milestones
  if (!next) return { board, changed: false, reason: 'no_tentative_next_milestone' }

  return {
    board: sanitizeStrategicProjectBoard({
      ...board,
      current_milestone: { ...next, status: 'active' },
      next_milestones: rest,
      transition_state: '',
      revision: board.revision + 1,
      updated_at: now,
    }, { goalId, objective, status, now }),
    changed: true,
    reason: 'next_milestone_activated',
  }
}
