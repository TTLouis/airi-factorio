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

export async function providerRequest(config, messages, { fetchImpl = fetch, signal } = {}) {
  check(typeof config.key === 'string' && config.key.trim().length > 0, 'OPENAI_API_KEY is missing')
  check(typeof config.model === 'string' && /^[a-zA-Z0-9._:/-]{1,200}$/.test(config.model), 'Invalid model identifier')
  check(Array.isArray(messages) && messages.length > 0 && messages.length <= 50, 'Invalid provider message history')

  const response = await fetchImpl(providerEndpoint(config.base), {
    method: 'POST',
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(config.timeoutMs ?? 45000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto',
      max_tokens: 2000,
    }),
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
  const message = data?.choices?.[0]?.message
  check(message && typeof message === 'object', 'Provider response has no assistant message')
  return message
}
