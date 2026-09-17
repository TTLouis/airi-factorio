import * as core from './provider-core.mjs'

export * from './provider-core.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'
const CANDIDATE_CONTRACT = '[HARNESS] Deterministic placement contract: getPlacementCandidates and place_candidate {candidate_set_id,candidate_id} are a pair. Execute the returned candidate id directly; do not copy candidate coordinates into place_entity.'
const FALLBACK_CONTINUATION_MAX_TOKENS = 4000

function officialDeepSeek(base) {
  try {
    return new URL(base).hostname.toLowerCase() === 'api.deepseek.com'
  }
  catch {
    return false
  }
}

function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

function successfulCompletionContinuation(messages, options = {}) {
  if (options.recoveryKind === 'output_budget_exhaustion') return true
  if (options.allowTools === false || (options.recoveryAttempt ?? 0) > 0) return false
  const index = lastUserIndex(messages)
  return index >= 0
    && typeof messages[index]?.content === 'string'
    && messages[index].content.startsWith(COMPLETION_MARKER)
}

function withCandidateContract(messages, continuation) {
  if (!continuation || !Array.isArray(messages)) return messages
  const index = lastUserIndex(messages)
  if (index < 0 || !String(messages[index]?.content ?? '').startsWith(COMPLETION_MARKER)) return messages
  return [
    ...messages.slice(0, index),
    { role: 'user', content: CANDIDATE_CONTRACT },
    ...messages.slice(index),
  ]
}

function reclassifyOutputBudgetExhaustion(message) {
  const diagnostics = message?._airiProvider
  if (!diagnostics || diagnostics.finish_reason !== 'length') return message
  if (diagnostics.content_chars !== 0 || diagnostics.tool_call_count !== 0) return message
  Object.defineProperty(message, '_airiProvider', {
    configurable: true,
    enumerable: false,
    value: {
      ...diagnostics,
      diagnostic_code: 'provider_output_budget_exhausted',
      output_budget_exhausted: true,
    },
  })
  return message
}

export async function providerRequest(config, messages, options = {}) {
  const continuation = successfulCompletionContinuation(messages, options)
  const deepSeek = continuation && officialDeepSeek(config?.base)
  const fetchImpl = options.fetchImpl ?? fetch
  const policyFetch = async (url, init = {}) => {
    if (!continuation || typeof init.body !== 'string') return fetchImpl(url, init)
    let body
    try { body = JSON.parse(init.body) }
    catch { return fetchImpl(url, init) }

    if (deepSeek) body.thinking = { type: 'disabled' }
    else body.max_tokens = Math.max(Number(body.max_tokens) || 0, FALLBACK_CONTINUATION_MAX_TOKENS)

    return fetchImpl(url, { ...init, body: JSON.stringify(body) })
  }

  const message = await core.providerRequest(
    config,
    withCandidateContract(messages, continuation),
    { ...options, fetchImpl: policyFetch },
  )
  return reclassifyOutputBudgetExhaustion(message)
}
