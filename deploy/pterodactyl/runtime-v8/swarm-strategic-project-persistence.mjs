import { atomicWrite, readJson } from './common.mjs'

export class SwarmStrategicProjectPersistence {
  constructor({
    filename,
    store,
  } = {}) {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('Strategic project persistence requires filename')
    }
    if (!store || typeof store.snapshot !== 'function' || typeof store.restore !== 'function') {
      throw new TypeError('Strategic project persistence requires store')
    }
    this.filename = filename
    this.store = store
    this.queue = Promise.resolve()
  }

  async load() {
    const snapshot = await readJson(this.filename, null)
    if (snapshot === null) {
      return {
        loaded: false,
        board: this.store.current(),
      }
    }

    const board = this.store.restore(snapshot)
    return {
      loaded: true,
      board,
    }
  }

  save() {
    const snapshot = this.store.snapshot()
    const contents = `${JSON.stringify(snapshot, null, 2)}\n`
    this.queue = this.queue.then(() => atomicWrite(this.filename, contents, 0o600))
    return this.queue
  }

  flush() {
    return this.queue
  }
}
