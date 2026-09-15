import { check, DeploymentError } from './common.mjs'
import { toolDefinitions } from './structured-policy.mjs'

export function providerEndpoint(base) {
  let url
  try { url = new URL(base) }
  catch { throw new DeploymentError('Invalid provider URL') }
  check(!url.username && !url.password && !url.search && !url.hash, 'Provider URL cannot contain credentials, query, or fragment')
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Remote provider URL requires HTTPS')
  url.pathname = url.pathname.replace(/\/?$/, '/') + 'chat/completions'
  return url.toString()
}

export async function providerRequest(config, messages, { fetchImpl = fetch, signal, allowTools = true } = {}) {
  check(typeof config.key === 'string' && config.key.trim().length > 0, 'OPENAI_API_KEY is missing')
  check(typeof config.model === 'string' && /^[a-zA-Z0-9._:/-]{1,200}$/.test(config.model), 'Invalid model identifier')
  check(Array.isArray(messages) && messages.length > 0 && messages.length <= 50, 'Invalid provider message history')
  check(typeof allowTools === 'boolean', 'Invalid tool availability flag')
  const timeoutMs = config.timeoutMs ?? 120000
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'Provider timeout must be an integer from 1000 to 600000 ms')

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const body = {
    model: config.model,
    messages,
    max_tokens: 2000,
  }
  if (allowTools) {
    body.tools = toolDefinitions
    body.tool_choice = 'auto'
  }

  try {
    const response = await fetchImpl(providerEndpoint(config.base), {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) throw new DeploymentError(`Provider HTTP ${response.status}; request will not be retried automatically`)
    check(response.body, 'Provider returned no response body')
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 256 * 1024) {
        await reader.cancel()
        throw new DeploymentError('Provider response too large')
      }
      chunks.push(value)
    }

    let data
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new DeploymentError('Provider returned invalid JSON') }
    const choice = data?.choices?.[0]
    const message = choice?.message
    check(message && typeof message === 'object', 'Provider response has no assistant message')
    Object.defineProperty(message, '_airiProvider', {
      configurable: true,
      enumerable: false,
      value: {
        response_id: typeof data?.id === 'string' ? data.id : undefined,
        model: typeof data?.model === 'string' ? data.model : config.model,
        finish_reason: choice?.finish_reason,
        usage: data?.usage && typeof data.usage === 'object' ? data.usage : undefined,
      },
    })
    return message
  }
  catch (error) {
    if (signal?.aborted) throw new DeploymentError('Provider request cancelled')
    if (timeoutSignal.aborted) throw new DeploymentError(`Provider timed out after ${timeoutMs} ms`)
    throw error
  }
}
