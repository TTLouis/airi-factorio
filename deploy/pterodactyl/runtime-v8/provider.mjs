import { providerEndpoint, providerRequest as baseProviderRequest } from './provider-base.mjs'

export * from './provider-base.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'

function deepSeekModel(config) {
  return /^deepseek(?:[-_./:]|$)/i.test(String(config?.model ?? ''))
}

function completionContinuation(messages, options = {}) {
  if (options.allowTools === false || (options.recoveryAttempt ?? 0) > 0 || !Array.isArray(messages)) return false
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  return typeof lastUser?.content === 'string' && lastUser.content.startsWith(COMPLETION_MARKER)
}

function wantsNoThinking(messages, options = {}) {
  return options.recoveryKind === 'output_budget_exhaustion'
    || (Number.isSafeInteger(options.recoveryAttempt) && options.recoveryAttempt > 0)
    || completionContinuation(messages, options)
}

function withDisabledThinking(fetchImpl) {
  return async (url, init = {}) => {
    if (typeof init.body !== 'string') return fetchImpl(url, init)
    let body
    try { body = JSON.parse(init.body) }
    catch { return fetchImpl(url, init) }
    if (body.thinking === undefined) body.thinking = { type: 'disabled' }
    return fetchImpl(url, { ...init, body: JSON.stringify(body) })
  }
}

/**
 * Provider policy shim.
 *
 * Runtime policy decides whether a turn should avoid reasoning. Provider
 * capability/encoding is handled separately. DeepSeek-compatible models may
 * run behind a custom OpenAI-compatible base URL, so hostname alone must not
 * decide whether `thinking: {type:"disabled"}` is emitted.
 */
export async function providerRequest(config, messages, options = {}) {
  const forceNoThinking = deepSeekModel(config) && wantsNoThinking(messages, options)
  if (!forceNoThinking) return baseProviderRequest(config, messages, options)

  const actualFetch = options.fetchImpl ?? fetch
  const actualEndpoint = providerEndpoint(config.base)
  const isCompactPath = options.recoveryKind === 'output_budget_exhaustion' || completionContinuation(messages, options)

  if (isCompactPath) {
    // Let the existing provider implementation apply its compact prompt,
    // reduced output budget, trace metadata, and native DeepSeek thinking
    // encoding. Rewrite only the transport URL so custom DeepSeek-compatible
    // gateways remain authoritative.
    const routedFetch = async (_url, init) => actualFetch(actualEndpoint, init)
    return baseProviderRequest(
      { ...config, base: 'https://api.deepseek.com' },
      messages,
      { ...options, fetchImpl: routedFetch },
    )
  }

  // Strict JSON/validation recovery is intentionally no-thinking too. The
  // base implementation does not currently classify generic recovery as a
  // compact continuation, so enforce the provider encoding at the transport
  // boundary without changing the endpoint or recovery semantics.
  return baseProviderRequest(config, messages, {
    ...options,
    fetchImpl: withDisabledThinking(actualFetch),
  })
}
