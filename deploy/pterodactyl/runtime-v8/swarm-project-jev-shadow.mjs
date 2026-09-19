import { readSwarmCoordinationSnapshot } from './swarm-coordination-snapshot.mjs'
import { runSwarmJevShadowDecision } from './swarm-jev-shadow-controller.mjs'

function clean(value, max = 160) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function strategicRevision(board) {
  return Number.isSafeInteger(board?.revision) && board.revision > 0 ? board.revision : 0
}

function recordKey(records) {
  return (Array.isArray(records) ? records : []).map(record => [
    record?.id ?? '',
    record?.revision ?? '',
    record?.status ?? '',
    record?.state ?? '',
    record?.updatedTick ?? '',
    record?.lastProgressTick ?? '',
    record?.tick ?? '',
    record?.active ?? '',
    record?.resolvedTick ?? '',
  ].join('@')).join('|')
}

function decisionKey(snapshot, {
  strategicBoard,
  conditionWait,
  outcome,
  recovery,
} = {}) {
  return JSON.stringify({
    strategic_revision: strategicRevision(strategicBoard),
    event_cursor: typeof snapshot?.eventCursor === 'string' ? snapshot.eventCursor : '',
    counts: snapshot?.counts ?? {},
    missions: recordKey(snapshot?.missions),
    objectives: recordKey(snapshot?.objectives),
    projects: recordKey(snapshot?.projects),
    work: recordKey(snapshot?.work),
    requests: recordKey(snapshot?.requests),
    warnings: recordKey(snapshot?.warnings),
    claims: recordKey(snapshot?.claims),
    results: recordKey(snapshot?.results),
    agents: recordKey(snapshot?.agents),
    actors: recordKey(snapshot?.actors),
    condition_wait: conditionWait
      ? {
          id: conditionWait.id,
          state: conditionWait.state,
          checks: conditionWait.checks,
          updated_tick: conditionWait.updated_tick,
        }
      : undefined,
    outcome: outcome
      ? {
          state: outcome.state,
          authoritative: outcome.authoritative === true,
          reason: outcome.reason,
        }
      : undefined,
    recovery: recovery
      ? {
          reason: recovery.reason,
          observationBudgetAvailable: recovery.observationBudgetAvailable,
          blockerGrounded: recovery.blockerGrounded,
          reconciliationActions: Array.isArray(recovery.reconciliationActions)
            ? recovery.reconciliationActions.length
            : 0,
        }
      : undefined,
  })
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
    counts: structuredClone(globalSnapshot.counts),
    missions: globalSnapshot.missions,
    objectives: globalSnapshot.objectives,
    projects: globalSnapshot.projects,
    work: globalSnapshot.work,
    requests: globalSnapshot.requests,
    warnings: globalSnapshot.warnings,
    claims: globalSnapshot.claims,
    results: globalSnapshot.results,
    agents: globalSnapshot.agents,
    actors: globalSnapshot.actors,
    evidence: globalSnapshot.results.map(result => ({
      kind: 'result',
      id: result.id,
      summary: clean(result.summary, 240),
    })),
    runtime: (() => {
      const sampledActiveWork = globalSnapshot.work.some(item => item?.status === 'claimed' || item?.status === 'active')
      const active = globalSnapshot.counts.activeClaims > 0 || sampledActiveWork
      return {
        healthy: true,
        active,
        blocked: globalSnapshot.counts.activeWarnings > 0,
        reason: globalSnapshot.counts.activeWarnings > 0
          ? 'swarm_active_warnings'
          : globalSnapshot.counts.activeClaims > 0
            ? 'swarm_active_claims'
            : sampledActiveWork
              ? 'swarm_sampled_active_work'
              : 'swarm_idle',
      }
    })(),
    global: {
      schema: globalSnapshot.schema,
      tick: globalSnapshot.tick,
      event_cursor: globalSnapshot.eventCursor,
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
    const key = decisionKey(globalSnapshot, options)
    if (options.force !== true && key === this.lastDecisionKey && this.lastTelemetry) {
      const reused = structuredClone(this.lastTelemetry)
      reused.source_tick = globalSnapshot.tick
      reused.reused = true
      this.lastTelemetry = structuredClone(reused)
      return reused
    }

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
      reused: false,
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
