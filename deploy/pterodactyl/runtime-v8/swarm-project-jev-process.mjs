export class SwarmProjectJevProcess {
  constructor({
    runtime,
    pollIntervalMs = 2000,
    log = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
  } = {}) {
    if (!runtime || typeof runtime.initialize !== 'function' || typeof runtime.poll !== 'function') {
      throw new TypeError('Swarm Project Jev process requires runtime')
    }

    this.runtime = runtime
    this.pollIntervalMs = Number.isSafeInteger(pollIntervalMs)
      ? Math.max(250, Math.min(60_000, pollIntervalMs))
      : 2000
    this.log = typeof log === 'function' ? log : () => {}
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.running = false
    this.timer = null
    this.inFlight = null
    this.started = false
  }

  async start() {
    if (this.started) return false
    await this.runtime.initialize()
    this.started = true
    this.running = true
    await this.runOnce('startup')
    this.schedule()
    return true
  }

  schedule() {
    if (!this.running || this.timer) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.runOnce('poll')
        .catch(error => {
          this.log(`Project Jev poll failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          this.schedule()
        })
    }, this.pollIntervalMs)
  }

  runOnce(reason = 'manual') {
    if (!this.running && reason !== 'startup' && reason !== 'manual') {
      return Promise.resolve({
        skipped: true,
        reason: 'process_not_running',
      })
    }
    if (this.inFlight) return this.inFlight

    const promise = Promise.resolve()
      .then(() => this.runtime.poll())
      .then(result => {
        if (result?.triggered) {
          this.log(`Project Jev triggered: ${result.reason || reason}`)
        }
        return result
      })
      .catch(error => {
        this.log(`Project Jev observation error: ${error instanceof Error ? error.message : String(error)}`)
        return {
          triggered: false,
          reason: 'observation_error',
          error: error instanceof Error ? error.message : String(error),
        }
      })
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null
      })

    this.inFlight = promise
    return promise
  }

  async stop() {
    if (!this.started) return false
    this.running = false
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    if (this.inFlight) await this.inFlight
    await this.runtime.flush()
    this.started = false
    return true
  }

  busy() {
    return this.inFlight !== null
  }
}
