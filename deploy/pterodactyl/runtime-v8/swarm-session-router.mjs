export const SWARM_NPC_NAME_POOL = [
  'Astra', 'Mika', 'Nova', 'Kira', 'Nami', 'Sora', 'Luna', 'Mira',
  'Rhea', 'Iris', 'Cora', 'Lyra', 'Nia', 'Emi', 'Yuna', 'Hana',
  'Aiko', 'Mei', 'Rina', 'Aria', 'Tali', 'Vela', 'Nyx', 'Eira',
  'Faye', 'Kaia', 'Luma', 'Nori', 'Oona', 'Piri', 'Sela', 'Tira',
  'Uma', 'Vivi', 'Wren', 'Xara', 'Yori', 'Zia', 'Ada', 'Bex',
  'Cleo', 'Dara', 'Elio', 'Finn', 'Gio', 'Hugo', 'Ivo', 'Juno',
  'Kato', 'Leon', 'Milo', 'Nico', 'Orin', 'Pax', 'Quin', 'Remy',
  'Sage', 'Theo', 'Uri', 'Vera', 'Wade', 'Xeno', 'Yuki', 'Zane',
]

function positiveAgentOrdinal(agentId) {
  const match = /^agent-(\d+)$/.exec(String(agentId ?? ''))
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stableTextHash(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) hash = (hash * 131 + value.charCodeAt(index)) % 2147483647
  return hash
}

export function displayNameForAgent(agentId) {
  const id = String(agentId ?? '')
  const ordinal = positiveAgentOrdinal(id) ?? (stableTextHash(id) + 1)
  const index = (ordinal - 1) % SWARM_NPC_NAME_POOL.length
  const generation = Math.floor((ordinal - 1) / SWARM_NPC_NAME_POOL.length) + 1
  const base = SWARM_NPC_NAME_POOL[index]
  return generation === 1 ? `AIRI-${base}` : `AIRI-${base}-${generation}`
}

export function canonicalMemoryKey(agentId) {
  return `npc:${String(agentId ?? '').trim()}`
}

function cleanId(value) {
  const id = String(value ?? '').trim()
  return id.length >= 1 && id.length <= 128 ? id : undefined
}

export function normalizeSwarmRoster(rawStatus) {
  const actors = Array.isArray(rawStatus?.actors) ? rawStatus.actors : []
  const result = []
  const seenAgents = new Set()
  for (const item of actors) {
    const agentId = cleanId(item?.agent?.id ?? item?.runtime?.agentId)
    const actorId = cleanId(item?.actorId)
    if (!agentId || !actorId || seenAgents.has(agentId)) continue
    seenAgents.add(agentId)
    result.push({
      agentId,
      actorId,
      displayName: displayNameForAgent(agentId),
      canonicalKey: canonicalMemoryKey(agentId),
      available: item?.runtime?.state === 'online' && item?.agent?.state !== 'disabled',
      agentState: cleanId(item?.agent?.state) ?? 'unknown',
      actorState: cleanId(item?.runtime?.state) ?? 'unknown',
      bodyRevision: Number.isSafeInteger(item?.runtime?.bodyRevision) ? item.runtime.bodyRevision : 0,
    })
  }
  result.sort((left, right) => left.agentId.localeCompare(right.agentId))
  return result
}

function aliases(entry) {
  const display = entry.displayName.toLowerCase()
  const short = display.startsWith('airi-') ? display.slice(5) : display
  return new Set([
    entry.agentId.toLowerCase(),
    display,
    short,
  ])
}

function findAgent(roster, token) {
  const normalized = String(token ?? '').trim().toLowerCase()
  if (!normalized) return undefined
  return roster.find(entry => aliases(entry).has(normalized))
}

function defaultAgent(roster, requestedDefault) {
  if (requestedDefault) {
    const exact = roster.find(entry => entry.agentId === requestedDefault)
    if (exact?.available) return exact
  }
  return roster.find(entry => entry.available) ?? roster[0]
}

/**
 * Deterministic chat routing. Only an explicit leading @target or a leading
 * known "target:" prefix can select a non-default NPC. Ordinary prose is never
 * scanned for names and is never broadcast to every session.
 */
export function routeSwarmMessage(message, roster, defaultAgentId) {
  const input = String(message ?? '').trim()
  if (!input) return { kind: 'empty' }

  const mention = /^@([^\s:]+)\s*(?::\s*|\s+)([\s\S]*)$/.exec(input)
  if (mention) {
    const target = findAgent(roster, mention[1])
    if (!target) return { kind: 'unknown_target', requested: mention[1], text: mention[2].trim() }
    return { kind: 'agent', explicit: true, agent: target, text: mention[2].trim() }
  }

  const colon = /^([^:]{1,64}):\s*([\s\S]*)$/.exec(input)
  if (colon) {
    const target = findAgent(roster, colon[1])
    if (target) return { kind: 'agent', explicit: true, agent: target, text: colon[2].trim() }
  }

  const target = defaultAgent(roster, defaultAgentId)
  if (!target) return { kind: 'no_agent', text: input }
  return { kind: 'agent', explicit: false, agent: target, text: input }
}

/**
 * Reconcile logical-agent sessions without tying their lifetime to a physical
 * Factorio body. Existing session objects survive actor/body replacement.
 */
export class SwarmSessionDirectory {
  constructor(createSession) {
    if (typeof createSession !== 'function') throw new TypeError('createSession must be a function')
    this.createSession = createSession
    this.records = new Map()
  }

  reconcile(rawStatus) {
    const roster = normalizeSwarmRoster(rawStatus)
    const visible = new Set()
    for (const entry of roster) {
      visible.add(entry.agentId)
      let record = this.records.get(entry.agentId)
      if (!record) {
        record = {
          ...entry,
          present: true,
          session: this.createSession(entry),
        }
        this.records.set(entry.agentId, record)
      }
      else {
        record.actorId = entry.actorId
        record.displayName = entry.displayName
        record.canonicalKey = entry.canonicalKey
        record.available = entry.available
        record.agentState = entry.agentState
        record.actorState = entry.actorState
        record.bodyRevision = entry.bodyRevision
        record.present = true
      }
      if (typeof record.session?.bindActor === 'function') record.session.bindActor(entry.actorId, entry.bodyRevision)
    }
    for (const [agentId, record] of this.records) {
      if (visible.has(agentId)) continue
      record.present = false
      record.available = false
    }
    return this.list()
  }

  list() {
    return [...this.records.values()].sort((left, right) => left.agentId.localeCompare(right.agentId))
  }

  get(agentId) {
    return this.records.get(agentId)
  }

  route(message, defaultAgentId) {
    return routeSwarmMessage(message, this.list().filter(record => record.present), defaultAgentId)
  }
}
