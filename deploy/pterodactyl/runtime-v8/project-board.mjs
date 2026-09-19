const PROJECT_BOARD_NEXT_LIMIT = 3
const PROJECT_STATUSES = new Set(['active', 'blocked', 'paused', 'completed'])
const DEVELOPMENT_DIRECTIONS = new Set(['vertical', 'horizontal', 'maintain', 'recover'])

function clean(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function milestone(value, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const title = clean(value.title, 500)
  if (!title) return undefined
  return {
    id: clean(value.id, 100) || undefined,
    title,
    status,
    completion_summary: clean(value.completion_summary, 800) || undefined,
  }
}

export function sanitizeProjectBoard(value, {
  goalId = '',
  objective = '',
  status = 'active',
  now = Date.now(),
} = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const current = milestone(source.current_milestone, 'active')
  const next = (Array.isArray(source.next_milestones) ? source.next_milestones : [])
    .slice(0, PROJECT_BOARD_NEXT_LIMIT)
    .map(item => milestone(item, 'tentative'))
    .filter(Boolean)
  return {
    kind: 'project_board_v1',
    project_id: clean(source.project_id || goalId, 100),
    title: clean(source.title || objective, 500),
    status: PROJECT_STATUSES.has(status) ? status : 'active',
    current_milestone: current,
    next_milestones: next,
    development_direction: DEVELOPMENT_DIRECTIONS.has(source.development_direction)
      ? source.development_direction
      : '',
    revision: Number.isSafeInteger(source.revision) && source.revision > 0 ? source.revision : 1,
    updated_at: Number.isFinite(source.updated_at) ? source.updated_at : now,
  }
}

export function updateProjectBoard(current, patch = {}, context = {}) {
  const previous = sanitizeProjectBoard(current, context)
  const now = Number.isFinite(context.now) ? context.now : Date.now()
  return sanitizeProjectBoard({
    ...previous,
    current_milestone: patch.current_milestone === undefined ? previous.current_milestone : patch.current_milestone,
    next_milestones: patch.next_milestones === undefined ? previous.next_milestones : patch.next_milestones,
    development_direction: patch.development_direction === undefined ? previous.development_direction : patch.development_direction,
    revision: previous.revision + 1,
    updated_at: now,
  }, { ...context, now })
}
