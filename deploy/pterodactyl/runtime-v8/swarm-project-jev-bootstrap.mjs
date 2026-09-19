import path from 'node:path'

import { SwarmProjectJevProcess } from './swarm-project-jev-process.mjs'
import { SwarmProjectJevRuntime } from './swarm-project-jev-runtime.mjs'
import { createSwarmJevDecisionProvider } from './swarm-jev-provider.mjs'

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
  env = process.env,
  fetchImpl = fetch,
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

  const resolvedDecisionProvider = typeof decisionProvider === 'function'
    ? decisionProvider
    : createSwarmJevDecisionProvider({
        budgetFile: path.join(path.dirname(resolvedStateFile), 'decision-provider-budget.json'),
        env,
        fetchImpl,
      })

  const runtime = new SwarmProjectJevRuntime({
    rcon,
    decisionProvider: resolvedDecisionProvider,
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
    decisionProviderConfigured: typeof resolvedDecisionProvider === 'function',

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
