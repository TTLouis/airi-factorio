import { NpcAgentLoop as BaseNpcAgentLoop } from '../staging/npc-agent-loop.mjs'

const ENTITY_STATUS_TOOL = 'getEntityStatus'
const ENTITY_STATUS_BASELINE_LIMIT = 4
const ENTITY_STATUS_CONTEXT_CHARS = 12000
const INSTALL_MARK = Symbol.for('airi.runtime-v8.entity-status-diff')

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function boundedRadius(value) {
  if (!Number.isFinite(value)) return 8
  return Math.max(1, Math.min(32, Math.floor(value)))
}

function queryFor(args = {}) {
  return {
    name: String(args.name ?? '').slice(0, 200),
    radius: boundedRadius(args.radius),
  }
}

function queryKey(args) {
  return JSON.stringify(queryFor(args))
}

function entityReference(status, query) {
  if (status?.found !== true) return `entity-query:${query.name}@${query.radius}`
  const entity = status.entity
  if (Number.isSafeInteger(entity?.unit_number)) return `entity:${entity.unit_number}`
  const position = entity?.position
  return `entity-fallback:${entity?.name ?? query.name}:${entity?.type ?? 'unknown'}:${position?.x ?? '?'}:${position?.y ?? '?'}`
}

function decisionView(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined
  return {
    found: status.found === true,
    error: typeof status.error === 'string' ? status.error : undefined,
    entity: status.entity && typeof status.entity === 'object' && !Array.isArray(status.entity)
      ? status.entity
      : undefined,
  }
}

function changedEntity(previous, current) {
  const changes = {}
  const keys = new Set([
    ...Object.keys(previous ?? {}),
    ...Object.keys(current ?? {}),
  ])
  for (const key of keys) {
    if (!sameJson(previous?.[key], current?.[key])) changes[key] = current?.[key] ?? null
  }
  return changes
}

function fullObservation(status, query, reference, identityChanged) {
  return {
    observation_mode: 'full',
    source: 'live_factorio_entity_status',
    reference,
    query,
    ...(identityChanged ? { identity_changed: true } : {}),
    found: status.found === true,
    ...(status.error !== undefined ? { error: status.error } : {}),
    ...(status.actor_position !== undefined ? { actor_position: status.actor_position } : {}),
    ...(status.entity !== undefined ? { entity: status.entity } : {}),
  }
}

function diffObservation(previous, status, query, reference) {
  const current = decisionView(status)
  if (!current) return undefined
  if (!previous || previous.reference !== reference || previous.view.found !== current.found) {
    return fullObservation(status, query, reference, !!previous)
  }

  const changes = {}
  if (!sameJson(previous.view.error, current.error)) changes.error = current.error ?? null
  const entityChanges = changedEntity(previous.view.entity, current.entity)
  if (Object.keys(entityChanges).length > 0) changes.entity = entityChanges
  if (Object.keys(changes).length === 0) {
    return {
      observation_mode: 'unchanged',
      source: 'live_factorio_entity_status',
      reference,
      query,
    }
  }
  return {
    observation_mode: 'diff',
    source: 'live_factorio_entity_status',
    reference,
    query,
    changes,
  }
}

function ensureState(loop) {
  loop.entityStatusBaselines ??= new Map()
  loop.entityStatusBaselineOrder ??= []
}

function rememberBaseline(loop, key, entry) {
  ensureState(loop)
  loop.entityStatusBaselines.set(key, entry)
  const previousIndex = loop.entityStatusBaselineOrder.indexOf(key)
  if (previousIndex >= 0) loop.entityStatusBaselineOrder.splice(previousIndex, 1)
  loop.entityStatusBaselineOrder.push(key)
  while (loop.entityStatusBaselineOrder.length > ENTITY_STATUS_BASELINE_LIMIT) {
    const oldest = loop.entityStatusBaselineOrder.shift()
    if (oldest !== undefined) loop.entityStatusBaselines.delete(oldest)
  }
}

function baselineContext(loop) {
  ensureState(loop)
  const selected = []
  let chars = 0
  for (let index = loop.entityStatusBaselineOrder.length - 1; index >= 0; index--) {
    const entry = loop.entityStatusBaselines.get(loop.entityStatusBaselineOrder[index])
    if (!entry) continue
    const visible = {
      reference: entry.reference,
      query: entry.query,
      ...entry.view,
    }
    const candidateChars = JSON.stringify(visible).length
    if (selected.length > 0 && chars + candidateChars > ENTITY_STATUS_CONTEXT_CHARS) break
    selected.push(visible)
    chars += candidateChars
    if (selected.length >= ENTITY_STATUS_BASELINE_LIMIT) break
  }
  if (selected.length === 0) return ''
  selected.reverse()
  return `[ENTITY_STATUS_BASELINE] Last live mutable entity-status snapshots for this request. These snapshots may now be stale; use them only to interpret later getEntityStatus diff/unchanged responses. Re-observe live mutable state before depending on it.\n${JSON.stringify(selected)}`
}

function transformEntityStatus(loop, entry, resultMessage) {
  if (entry?.tool?.function?.name !== ENTITY_STATUS_TOOL) return
  const raw = String(resultMessage?.content ?? '')
  if (!raw || raw.startsWith('[HARNESS]')) return
  let status
  try { status = JSON.parse(raw) }
  catch { return }
  const view = decisionView(status)
  if (!view) return
  const query = queryFor(entry.args)
  const key = queryKey(entry.args)
  ensureState(loop)
  const previous = loop.entityStatusBaselines.get(key)
  const reference = entityReference(status, query)
  const providerObservation = diffObservation(previous, status, query, reference)
  if (!providerObservation) return
  rememberBaseline(loop, key, { query, reference, view })
  resultMessage.content = JSON.stringify(providerObservation)
}

function installEntityStatusDiffs(Base) {
  const prototype = Base.prototype
  if (prototype[INSTALL_MARK]) return
  Object.defineProperty(prototype, INSTALL_MARK, { value: true })

  const originalRequest = prototype.request
  prototype.request = async function (...args) {
    this.entityStatusBaselines = new Map()
    this.entityStatusBaselineOrder = []
    return originalRequest.apply(this, args)
  }

  const originalPrepareContinuationContext = prototype.prepareContinuationContext
  prototype.prepareContinuationContext = function (...args) {
    const result = originalPrepareContinuationContext.apply(this, args)
    const context = baselineContext(this)
    if (context) this.messages.push({ role: 'user', content: context })
    return result
  }

  const originalHandleToolBatch = prototype.handleToolBatch
  prototype.handleToolBatch = async function (message, prepared = this.prepareToolBatch(message)) {
    const beforeCount = this.messages.length
    await originalHandleToolBatch.call(this, message, prepared)
    const results = this.messages.slice(beforeCount + 1).filter(item => item.role === 'tool')
    for (let index = 0; index < prepared.length; index++) {
      const result = results.find(item => item.tool_call_id === prepared[index]?.tool?.id)
      if (result) transformEntityStatus(this, prepared[index], result)
    }
    this.compactWorkingContext()
  }
}

installEntityStatusDiffs(BaseNpcAgentLoop)

export * from '../staging/supervisor-adapter.mjs'
