import {
  buildSwarmJevShadowContext,
  parseSwarmJevShadowDecision,
  swarmJevShadowQuestions,
} from './swarm-jev-shadow.mjs'

function cleanError(error, max = 300) {
  const text = String(error instanceof Error ? error.message : error ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export async function runSwarmJevShadowDecision({
  decisionProvider,
  snapshot = {},
  providerOptions = {},
  now = () => Date.now(),
} = {}) {
  const context = buildSwarmJevShadowContext(snapshot)
  const questions = swarmJevShadowQuestions()

  if (typeof decisionProvider !== 'function') {
    return {
      authority: 'shadow',
      effects: [],
      status: 'provider_unavailable',
      context_schema: context.schema,
      question_ids: Object.keys(questions),
      decision: parseSwarmJevShadowDecision({ answers: {} }).decision,
      latency_ms: 0,
    }
  }

  const startedAt = now()
  try {
    const response = await decisionProvider(context, questions, providerOptions)
    const parsed = parseSwarmJevShadowDecision(response)
    return {
      authority: 'shadow',
      effects: [],
      status: 'ok',
      context_schema: context.schema,
      question_ids: Object.keys(questions),
      decision: parsed.decision,
      latency_ms: Math.max(0, now() - startedAt),
    }
  }
  catch (error) {
    return {
      authority: 'shadow',
      effects: [],
      status: 'provider_error',
      context_schema: context.schema,
      question_ids: Object.keys(questions),
      error: cleanError(error),
      decision: parseSwarmJevShadowDecision({ answers: {} }).decision,
      latency_ms: Math.max(0, now() - startedAt),
    }
  }
}
