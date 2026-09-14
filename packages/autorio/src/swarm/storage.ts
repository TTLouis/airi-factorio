import type { SwarmBoardStorage, SwarmIdByKind, SwarmIdKind, SwarmStorage } from './types'

export const SWARM_STORAGE_VERSION = 1

export type PartialBoardStorage = Partial<SwarmBoardStorage>
export type PartialSwarmStorage = Partial<Omit<SwarmStorage, 'board'>> & {
  board?: PartialBoardStorage
}

export interface SwarmStorageRoot {
  airi_swarm?: PartialSwarmStorage
}

declare const storage: SwarmStorageRoot

function create_empty_board(): SwarmBoardStorage {
  return {
    work: {},
    requests: {},
    observations: {},
    warnings: {},
    claims: {},
    results: {},
    reservations: {},
    events: [],
  }
}

export function create_empty_swarm_storage(): SwarmStorage {
  return {
    version: SWARM_STORAGE_VERSION,
    agents: {},
    board: create_empty_board(),
    missions: {},
    objectives: {},
    projects: {},
    counters: {},
  }
}

function normalize_current_storage(current: PartialSwarmStorage): SwarmStorage {
  if (!current.agents) current.agents = {}
  if (!current.board) current.board = {}
  if (!current.board.work) current.board.work = {}
  if (!current.board.requests) current.board.requests = {}
  if (!current.board.observations) current.board.observations = {}
  if (!current.board.warnings) current.board.warnings = {}
  if (!current.board.claims) current.board.claims = {}
  if (!current.board.results) current.board.results = {}
  if (!current.board.reservations) current.board.reservations = {}
  if (!current.board.events) current.board.events = []
  if (!current.missions) current.missions = {}
  if (!current.objectives) current.objectives = {}
  if (!current.projects) current.projects = {}
  if (!current.counters) current.counters = {}
  return current as SwarmStorage
}

export function get_swarm_storage(root?: SwarmStorageRoot): SwarmStorage {
  const target = root ?? storage
  const current = target.airi_swarm
  if (!current) {
    const initialized = create_empty_swarm_storage()
    target.airi_swarm = initialized
    return initialized
  }

  if (current.version !== SWARM_STORAGE_VERSION) {
    throw new Error(`Unsupported swarm storage version: ${current.version ?? 'missing'}`)
  }

  return normalize_current_storage(current)
}

const ID_PREFIX: Record<SwarmIdKind, string> = {
  agent: 'agent',
  actor: 'actor',
  work: 'work',
  request: 'request',
  claim: 'claim',
  mission: 'mission',
  objective: 'objective',
  project: 'project',
  observation: 'observation',
  warning: 'warning',
  result: 'result',
  reservation: 'reservation',
  event: 'event',
}

export function allocate_swarm_id<K extends SwarmIdKind>(kind: K, swarm?: SwarmStorage): SwarmIdByKind[K] {
  const current = swarm ?? get_swarm_storage()
  const next = (current.counters[kind] ?? 0) + 1
  current.counters[kind] = next
  return `${ID_PREFIX[kind]}-${next}` as SwarmIdByKind[K]
}
