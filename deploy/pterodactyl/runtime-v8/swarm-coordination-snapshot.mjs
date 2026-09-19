const SNAPSHOT_SCHEMA = 'swarm_coordination_snapshot_v1'
const SNAPSHOT_ARRAY_FIELDS = Object.freeze([
  'missions',
  'objectives',
  'projects',
  'work',
  'requests',
  'warnings',
  'claims',
  'results',
  'agents',
  'actors',
])
const SNAPSHOT_COUNT_FIELDS = Object.freeze([
  'missions',
  'incompleteMissions',
  'objectives',
  'incompleteObjectives',
  'projects',
  'incompleteProjects',
  'work',
  'requests',
  'claims',
  'results',
  'agents',
  'actors',
  'openWork',
  'executingWork',
  'blockedWork',
  'openRequests',
  'activeClaims',
  'activeWarnings',
])

function boundedLimit(value) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(32, value)) : 12
}

function parseJsonObject(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  }
  catch {
    throw new Error('Invalid swarm coordination snapshot JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid swarm coordination snapshot object')
  }
  return parsed
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid swarm coordination snapshot ${label}`)
  }
  return value
}

function boundedRecords(source, field, limit) {
  if (!Array.isArray(source)) throw new Error(`Invalid swarm coordination snapshot ${field}`)
  if (source.length > limit) throw new Error(`Unbounded swarm coordination snapshot ${field}`)
  return source.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Invalid swarm coordination snapshot ${field} record`)
    }
    return structuredClone(record)
  })
}

export function parseSwarmCoordinationSnapshot(value, { requestedLimit = 12 } = {}) {
  const source = typeof value === 'string' ? parseJsonObject(value) : structuredClone(value)
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Invalid swarm coordination snapshot object')
  }
  if (source.schema !== SNAPSHOT_SCHEMA) {
    throw new Error('Unsupported swarm coordination snapshot schema')
  }

  const limit = boundedLimit(requestedLimit)
  const returnedLimit = nonNegativeInteger(source.limit, 'limit')
  if (returnedLimit < 1 || returnedLimit > limit) {
    throw new Error('Swarm coordination snapshot exceeded requested limit')
  }

  const counts = source.counts
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('Invalid swarm coordination snapshot counts')
  }
  const normalizedCounts = {}
  for (const field of SNAPSHOT_COUNT_FIELDS) {
    normalizedCounts[field] = nonNegativeInteger(counts[field], `count ${field}`)
  }

  const eventCursor = typeof source.eventCursor === 'string' && source.eventCursor.length <= 160
    ? source.eventCursor
    : undefined
  if (eventCursor === undefined) {
    throw new Error('Invalid swarm coordination snapshot eventCursor')
  }

  const normalized = {
    schema: SNAPSHOT_SCHEMA,
    tick: nonNegativeInteger(source.tick, 'tick'),
    eventCursor,
    limit: returnedLimit,
    counts: normalizedCounts,
  }
  for (const field of SNAPSHOT_ARRAY_FIELDS) {
    normalized[field] = boundedRecords(source[field], field, returnedLimit)
  }
  return normalized
}

export async function readSwarmCoordinationSnapshot(rcon, { limit = 12 } = {}) {
  if (!rcon || typeof rcon.command !== 'function') {
    throw new TypeError('RCON command interface is required')
  }
  const requestedLimit = boundedLimit(limit)
  const response = await rcon.command(
    `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_swarm_coordination","snapshot",${requestedLimit})))`,
  )
  return parseSwarmCoordinationSnapshot(response, { requestedLimit })
}
