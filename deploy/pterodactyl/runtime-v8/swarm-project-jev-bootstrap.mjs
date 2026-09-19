import path from 'node:path'

import { SwarmProjectJevProcess } from './swarm-project-jev-process.mjs'
import { SwarmProjectJevRuntime } from './swarm-project-jev-runtime.mjs'

export function createSwarmProjectJevControlPlane({
  rcon,
  decisionProvider,
  root,
  stateFile,
  snapshotLimit = 12,
  pollIntervalMs = 2000,
  goalId = '',
  objective = '',
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!rcon || typeof rcon.command !== 'function') {
    throw new TypeError('Swarm Project Jev control plane requires shared RCON')
  }
  if (typeof root !== 'string' && typeof stateFile !== 'string') {
    throw new TypeError('Swarm Project Jev control plane requires root or stateFile')
  }

  const resolvedStateFile = typeof stateFile === 'string' && stateFile.length > 0
    ? stateFile
    : path.join(root, '.airi', 'swarm-strategic-project.json')

  const runtime = new SwarmProjectJevRuntime({
    rcon,
    decisionProvider,
    stateFile: resolvedStateFile,
    snapshotLimit,
    goalId,
    objective,
    now,
  })

  const process = new SwarmProjectJevProcess({
    runtime,
    pollIntervalMs,
    log,
  })

  return {
    runtime,
    process,
    stateFile: resolvedStateFile,

    async start() {
      return process.start()
    },

    async stop() {
      return process.stop()
    },

    async poll() {
      return runtime.poll()
    },

    async forceReview(reason = 'manual_review') {
      return runtime.trigger(reason)
    },

    currentBoard() {
      return runtime.currentBoard()
    },

    lastTelemetry() {
      return runtime.lastTelemetry()
    },
  }
}
