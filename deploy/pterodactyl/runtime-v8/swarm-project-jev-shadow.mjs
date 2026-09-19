import { readSwarmCoordinationSnapshot } from './swarm-coordination-snapshot.mjs'
import { runSwarmJevShadowDecision } from './swarm-jev-shadow-controller.mjs'

function clean(value, max = 160) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function strategicRevision(board) {
  return Number.isSafeInteger(board?.revision) && board.revision > 0 ? board.revision : 0
}

function decisionKey(snapshot, strategicBoard) {
  const parts = [
    snapshot?.tick ?? 0,
    strategicRevision(strategicBoard),
    snapshot?.counts?.missions ?? 0,
    snapshot?.counts?.objectives ?? 0,
    snapshot?.counts?.projects ?? 0,
    snapshot?.counts?.work ?? 0,
    snapshot?.counts?.requests ?? 0,
    snapshot?.counts?.claims ?? 0,
    snapshot?.counts?.results ?? 0,
    snapshot?.counts?.activeWarnings ?? 0,
  ]
  return parts.join(':')
}

export function buildProjectJevShadowSnapshot(globalSnapshot, {
  strategicBoard,
  conditionWait,
  outcome,
  recovery,
} = {}) {
  if (!globalSnapshot || globalSnapshot.schema !== 'swarm_coordination_snapshot_v1') {
    throw new Error('Project Jev requires canonical swarm coordination snapshot')
  }

  return {
    strategicBoard,
    conditionWait,
    outcome,
    recovery,
    missions: globalSnapshot.missions,
    objectives: globalSnapshot.objectives,
    projects: globalSnapshot.projects,
    work: globalSnapshot.work,
    requests: globalSnapshot.requests,
    claims: globalSnapshot.claims,
    actors: globalSnapshot.actors,
    evidence: globalSnapshot.results.map(result => ({
      kind: 'result',
      id: result.id,
      summary: clean(result.summary, 240),
    })),
    runtime: {
      healthy: true,
      active: globalSnapshot.counts.work > 0 || globalSnapshot.counts.claims > 0,
      blocked: globalSnapshot.counts.activeWarnings > 0,
      reason: globalSnapshot.counts.activeWarnings > 0
        ? 'swarm_active_warnings'
        : globalSnapshot.counts.claims > 0
          ? 'swarm_active_claims'
          : globalSnapshot.counts.work > 0
            ? 'swarm_work_present'
            : 'swarm_idle',
    },
    global: {
      schema: globalSnapshot.schema,
      tick: globalSnapshot.tick,
      counts: structuredClone(globalSnapshot.counts),
      warnings: structuredClone(globalSnapshot.warnings),
      agents: structuredClone(globalSnapshot.agents),
      results: structuredClone(globalSnapshot.results),
    },
  }
}

export class SwarmProjectJevShadowController {
  constructor({
    rcon,
    decisionProvider,
    snapshotLimit = 12,
    now = () => Date.now(),
  } = {}) {
    if (!rcon || typeof rcon.command !== 'function') {
      throw new TypeError('Project Jev requires RCON command interface')
    }
    this.rcon = rcon
    this.decisionProvider = typeof decisionProvider === 'function' ? decisionProvider : null
    this.snapshotLimit = snapshotLimit
    this.now = now
    this.lastDecisionKey = ''
    this.lastTelemetry = undefined
  }

  async observe(options = {}) {
    const globalSnapshot = await readSwarmCoordinationSnapshot(this.rcon, {
      limit: this.snapshotLimit,
    })
    const key = decisionKey(globalSnapshot, options.strategicBoard)
    const snapshot = buildProjectJevShadowSnapshot(globalSnapshot, options)

    const telemetry = await runSwarmJevShadowDecision({
      decisionProvider: this.decisionProvider,
      snapshot,
      providerOptions: options.providerOptions ?? {},
      now: this.now,
    })

    const result = {
      authority: 'shadow',
      effects: [],
      scope: 'swarm_global',
      source_tick: globalSnapshot.tick,
      source_schema: globalSnapshot.schema,
      source_counts: structuredClone(globalSnapshot.counts),
      decision_key: key,
      decision: telemetry,
    }

    this.lastDecisionKey = key
    this.lastTelemetry = structuredClone(result)
    return result
  }

  last() {
    return this.lastTelemetry ? structuredClone(this.lastTelemetry) : undefined
  }
}
