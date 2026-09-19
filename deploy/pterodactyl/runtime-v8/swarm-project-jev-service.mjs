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
    this.sequence = 0
    this.lastCompleted = undefined
  }

  trigger(reason = 'unspecified') {
    if (this.inFlight) return this.inFlight

    const sequence = ++this.sequence
    const normalizedReason = String(reason ?? 'unspecified').slice(0, 160)
    const promise = Promise.resolve().then(async () => {
      const result = await this.controller.observe({
        strategicBoard: this.strategicBoard(),
        conditionWait: this.conditionWait(),
        outcome: this.outcome(),
        recovery: this.recovery(),
        providerOptions: this.providerOptions(),
      })
      const completed = {
        ...result,
        trigger_sequence: sequence,
        trigger_reason: normalizedReason,
      }
      this.lastCompleted = structuredClone(completed)
      return completed
    }).finally(() => {
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
