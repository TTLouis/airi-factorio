import path from 'node:path'

import { reserveBudget } from './common.mjs'
import {
  decisionProviderConfiguration,
  decisionProviderRequest,
} from './provider.mjs'

export function createSwarmJevDecisionProvider({
  budgetFile,
  root,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const config = decisionProviderConfiguration(env)
  if (!config) return undefined

  const resolvedBudgetFile = typeof budgetFile === 'string' && budgetFile.length > 0
    ? budgetFile
    : typeof root === 'string' && root.length > 0
      ? path.join(root, '.airi', 'decision-provider-budget.json')
      : undefined

  if (!resolvedBudgetFile) {
    throw new TypeError('Configured Jev decision provider requires budgetFile or root')
  }

  return async (state, questions, options = {}) => decisionProviderRequest(
    config,
    state,
    questions,
    {
      fetchImpl,
      signal: options.signal,
      reserve: () => reserveBudget(resolvedBudgetFile, config.maxRequestsPerHour),
    },
  )
}
