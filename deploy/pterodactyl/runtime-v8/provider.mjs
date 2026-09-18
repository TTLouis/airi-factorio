import { providerEndpoint, providerRequest as baseProviderRequest } from './provider-base.mjs'

export * from './provider-base.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'
const FAILURE_MARKER = '[MOD] Autorio operation error:'
const CHAT_MARKER = '[CHAT]'

function deepSeekModel(config) {
  return /^deepseek(?:[-_./:]|$)/i.test(String(config?.model ?? ''))
}

function lastUserContent(messages) {
  if (!Array.isArray(messages)) return ''
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  return typeof lastUser?.content === 'string' ? lastUser.content : ''
}

function completionContinuation(messages, options = {}) {
  if (options.allowTools === false || (options.recoveryAttempt ?? 0) > 0) return false
  return lastUserContent(messages).startsWith(COMPLETION_MARKER)
}

function currentDifficultySignals(messages) {
  if (!Array.isArray(messages)) return 0
  let start = 0
  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]?.role === 'user' && typeof messages[index].content === 'string'
      ? messages[index].content
      : ''
    if (content.startsWith(CHAT_MARKER) || content.startsWith(COMPLETION_MARKER)) start = index
  }

  let failures = 0
  for (let index = start + 1; index < messages.length; index++) {
    const content = messages[index]?.role === 'user' && typeof messages[index].content === 'string'
      ? messages[index].content
      : ''
    if (!content) continue
    if (content.startsWith(FAILURE_MARKER)) {
      failures++
      continue
    }
    if (!content.startsWith('[HARNESS]')) continue
    if (/Tool-validation failure|Repeated tool observation loop|Recovery attempt \d+ was invalid|Invalid provider content|invalid tool call|admission|preflight/i.test(content)) {
      failures++
    }
  }
  return failures
}

export function selectReasoningPolicy(config, messages, options = {}) {
  if (!deepSeekModel(config)) return undefined
  if (options.recoveryKind === 'output_budget_exhaustion') {
    return { effort: 'none', reason: 'output_budget_recovery' }
  }
  if (Number.isSafeInteger(options.recoveryAttempt) && options.recoveryAttempt > 0) {
    return { effort: 'none', reason: 'strict_recovery' }
  }
  if (completionContinuation(messages, options)) {
    return { effort: 'low', reason: 'deterministic_completion' }
  }

  const failures = currentDifficultySignals(messages)
  if (failures >= 2) return { effort: 'max', reason: 'repeated_failure' }
  if (failures === 1 || options.triggerSource === 'failure') {
    return { effort: 'high', reason: 'ordinary_replan' }
  }

  const currentUser = lastUserContent(messages)
  if (currentUser.startsWith(CHAT_MARKER)) return { effort: 'high', reason: 'new_goal' }
  return { effort: 'high', reason: 'ordinary_planning' }
}

function reasoningBodyPatch(policy) {
  return {
    reasoning_effort: policy.effort,
    thinking: { type: policy.effort === 'none' ? 'disabled' : 'enabled' },
  }
}

/**
 * Provider policy shim.
 *
 * The runtime selects a deterministic reasoning policy from observable request
 * state. Capability encoding remains model-sensitive: DeepSeek-compatible
 * models may run behind arbitrary OpenAI-compatible base URLs, so hostname
 * alone never decides whether DeepSeek reasoning fields are emitted.
 */
export async function providerRequest(config, messages, options = {}) {
  const policy = selectReasoningPolicy(config, messages, options)
  if (!policy) return baseProviderRequest(config, messages, options)

  const actualFetch = options.fetchImpl ?? fetch
  const actualEndpoint = providerEndpoint(config.base)
  const requestOptions = {
    ...options,
    requestBodyPatch: reasoningBodyPatch(policy),
    providerPolicy: policy,
  }
  const compactPath = options.recoveryKind === 'output_budget_exhaustion' || completionContinuation(messages, options)

  if (!compactPath) return baseProviderRequest(config, messages, requestOptions)

  // Keep the existing compact prompt/tool/output-budget path intact. The base
  // implementation uses the official DeepSeek base only as a capability hint;
  // transport is still routed to the user's configured endpoint.
  const routedFetch = async (_url, init) => actualFetch(actualEndpoint, init)
  return baseProviderRequest(
    { ...config, base: 'https://api.deepseek.com' },
    messages,
    { ...requestOptions, fetchImpl: routedFetch },
  )
}
