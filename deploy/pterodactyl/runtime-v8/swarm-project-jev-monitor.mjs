import { readSwarmCoordinationSnapshot } from './swarm-coordination-snapshot.mjs'
import { projectJevTriggerReasons } from './swarm-project-jev-trigger-policy.mjs'

export class SwarmProjectJevMonitor {
  constructor({
    rcon,
    service,
    strategicBoard = () => undefined,
    snapshotLimit = 12,
  } = {}) {
    if (!rcon || typeof rcon.command !== 'function') {
      throw new TypeError('Project Jev monitor requires RCON command interface')
    }
    if (!service || typeof service.trigger !== 'function') {
      throw new TypeError('Project Jev monitor requires shadow service')
    }
    this.rcon = rcon
    this.service = service
    this.strategicBoard = typeof strategicBoard === 'function'
      ? strategicBoard
      : () => strategicBoard
    this.snapshotLimit = snapshotLimit
    this.previousSnapshot = undefined
    this.previousBoard = undefined
    this.pollPromise = null
  }

  poll() {
    if (this.pollPromise) return this.pollPromise

    const promise = this.runPoll().finally(() => {
      if (this.pollPromise === promise) this.pollPromise = null
    })
    this.pollPromise = promise
    return promise
  }

  async runPoll() {
    const snapshot = await readSwarmCoordinationSnapshot(this.rcon, {
      limit: this.snapshotLimit,
    })
    const board = this.strategicBoard()
    const policy = projectJevTriggerReasons(
      this.previousSnapshot,
      snapshot,
      {
        previousBoard: this.previousBoard,
        currentBoard: board,
      },
    )

    this.previousSnapshot = structuredClone(snapshot)
    this.previousBoard = board ? structuredClone(board) : undefined

    if (!policy.trigger) {
      return {
        triggered: false,
        reasons: [],
        reason: policy.reason,
        source_tick: snapshot.tick,
        source_event_cursor: snapshot.eventCursor,
      }
    }

    const telemetry = await this.service.trigger(policy.reason, {
      snapshot,
    })
    return {
      triggered: true,
      reasons: [...policy.reasons],
      reason: policy.reason,
      source_tick: snapshot.tick,
      source_event_cursor: snapshot.eventCursor,
      telemetry,
    }
  }

  resetBaseline() {
    this.previousSnapshot = undefined
    this.previousBoard = undefined
  }
}
