export class SwarmProjectJevShadowService {
  constructor({
    controller,
    strategicBoard = () => undefined,
    conditionWait = () => undefined,
    outcome = () => undefined,
    recovery = () => undefined,
    providerOptions = () => ({}),
  } = {}) {
    if (!controller || typeof controller.observe !== 'function') {
      throw new TypeError('Project Jev shadow service requires a controller')
    }
    this.controller = controller
    this.strategicBoard = typeof strategicBoard === 'function' ? strategicBoard : () => strategicBoard
    this.conditionWait = typeof conditionWait === 'function' ? conditionWait : () => conditionWait
    this.outcome = typeof outcome === 'function' ? outcome : () => outcome
    this.recovery = typeof recovery === 'function' ? recovery : () => recovery
    this.providerOptions = typeof providerOptions === 'function' ? providerOptions : () => providerOptions
    this.inFlight = null
    this.pendingReasons = new Set()
    this.pendingSnapshot = undefined
    this.sequence = 0
    this.lastCompleted = undefined
  }

  normalizeReason(reason) {
    return String(reason ?? 'unspecified').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'unspecified'
  }

  async runCycle(reasons, snapshot) {
    const sequence = ++this.sequence
    try {
      const options = {
        strategicBoard: this.strategicBoard(),
        conditionWait: this.conditionWait(),
        outcome: this.outcome(),
        recovery: this.recovery(),
        providerOptions: this.providerOptions(),
      }
      const result = snapshot && typeof this.controller.observeSnapshot === 'function'
        ? await this.controller.observeSnapshot(snapshot, options)
        : await this.controller.observe(options)
      return {
        ...result,
        trigger_sequence: sequence,
        trigger_reason: reasons.join(',').slice(0, 320),
        trigger_reasons: [...reasons],
      }
    }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error ?? 'unknown error')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300)
      return {
        authority: 'shadow',
        effects: [],
        scope: 'swarm_global',
        status: 'observation_error',
        error: message,
        trigger_sequence: sequence,
        trigger_reason: reasons.join(',').slice(0, 320),
        trigger_reasons: [...reasons],
      }
    }
  }

  async drain() {
    let completed
    while (this.pendingReasons.size > 0) {
      const reasons = [...this.pendingReasons]
      const snapshot = this.pendingSnapshot
      this.pendingReasons.clear()
      this.pendingSnapshot = undefined
      completed = await this.runCycle(reasons, snapshot)
      this.lastCompleted = structuredClone(completed)
    }
    return completed
  }

  trigger(reason = 'unspecified', { snapshot } = {}) {
    this.pendingReasons.add(this.normalizeReason(reason))
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      this.pendingSnapshot = structuredClone(snapshot)
    }
    if (this.inFlight) return this.inFlight

    const promise = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null
      })

    this.inFlight = promise
    return promise
  }

  last() {
    return this.lastCompleted ? structuredClone(this.lastCompleted) : undefined
  }

  busy() {
    return this.inFlight !== null
  }
}
