import { check, DeploymentError } from './common.mjs'
import { toolDefinitions } from './structured-policy.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'
const COMPLETION_MAX_TOKENS = 1000
const DEFAULT_MAX_TOKENS = 2000
const PLAN_STATE_MARKER = '[PLAN_STATE]'
const MEMORY_MARKER = '[MEMORY]'

const COMPACT_CONTINUATION_PROMPT = `You are AIRI, an autonomous standalone Factorio NPC. This request is a successful Autorio batch-completion continuation for an existing user goal, not a new goal.

Use the supplied [PLAN_STATE] as the canonical durable Task Board. Preserve its completed prefix and continue the active goal; do not restart or silently rewrite the plan. Mutable world state still requires observation when it is actually needed for the next decision.

Token-efficient continuation rules:
- If the Task Board/receipt already contains deterministic_verification with verdict verified_complete for the action that just finished, do not spend a tool call re-checking that exact fact.
- Call read-only tools only for unknown mutable facts required to choose or parameterize the next operation.
- Prefer a tightly related deterministic operation batch when every operation can be fully specified now and no later operation needs an identity/result created by an earlier one. Multiple gather_resource operations for known resources may be submitted together. When one exact observed entity needs multiple item types, prefer one supply_entity operation over separate transfer turns.
- Runtime navigation/reach/obstacle recovery is internal progress, not a new plan step and not a reason to call the model again.
- research_technology submission is not completed research; verify the actual technology before depending on it. wait is never proof that a world condition became true. Item transfers may be partial and need relevant verification before depending on an exact quantity.
- When simply continuing with another operation and the human does not need to act, set chatMessage to an empty string. Use chatMessage for a blocker, a decision that needs the human, or verified final completion.
- Never emit Lua, game.*, shell/console commands, or unapproved operations.

Approved operations and bounded arguments:
walk_to_entity {entity_name,search_radius}; walk_to_player {player_name}; follow_player {player_name,follow_distance}; stop_follow_player {}; set_auto_defense {enabled}; equip_weapon {item_name,slot}; equip_ammo {item_name,slot}; equip_armor {item_name}; select_weapon_slot {slot}; mine_entity {entity_name,count}; gather_resource {resource_name,count,search_radius}; supply_entity {unit_number,items:[{item_name,count}]}; place_entity {entity_name,x?,y?,direction?}; move_items {item_name,entity_name,max_count,to_entity}; move_items_exact {item_name,unit_number,max_count,to_entity}; move_items_with_player {item_name,player_name,max_count,to_player}; set_machine_recipe {unit_number,recipe_name}; craft_item {item_name,count}; attack_nearest_enemy {search_radius}; clear_enemy_area {search_radius}; research_technology {technology_name}; wait {ticks}.

Return exactly one strict JSON object with exactly these fields:
{"chatMessage":"","plan":["observable step"],"currentStep":0,"operations":[{"name":"approved_operation","args":{}}]}
plan is the visible canonical checklist proposal, currentStep indexes it, and operations contains only approved structured operations. If the whole goal is verified complete, return plan:[], currentStep:0, operations:[] and a short completion chatMessage.`

function isSuccessfulCompletionContinuation(messages, { allowTools, recoveryAttempt }) {
  if (!allowTools || recoveryAttempt > 0 || !Array.isArray(messages)) return false
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  return typeof lastUser?.content === 'string' && lastUser.content.startsWith(COMPLETION_MARKER)
}

function leanTaskBoard(board) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return undefined
  return {
    kind: board.kind,
    goal_id: board.goal_id,
    status: board.status,
    blocker: board.blocker,
    pause_reason: board.pause_reason,
    revision: board.revision,
    completed_count: board.completed_count,
    total_steps: board.total_steps,
    active_index: board.active_index,
    active_step_id: board.active_step_id,
    steps: Array.isArray(board.steps)
      ? board.steps.slice(0, 30).map(step => ({
          id: step?.id,
          description: step?.description,
          status: step?.status,
        }))
      : undefined,
    evidence: Array.isArray(board.evidence) ? board.evidence.slice(-4) : undefined,
  }
}

export function compactPlanStateContent(content) {
  const text = String(content ?? '')
  const markerAt = text.lastIndexOf(PLAN_STATE_MARKER)
  if (markerAt < 0) {
    if (text.startsWith(MEMORY_MARKER)) {
      return '[MEMORY COMPACTED] Prior dialogue is omitted for this successful deterministic continuation; use the original current chat request, previous assistant plan, and live tools when needed.'
    }
    return text
  }

  const planText = text.slice(markerAt)
  const newlineAt = planText.indexOf('\n')
  if (newlineAt < 0) return planText
  try {
    const state = JSON.parse(planText.slice(newlineAt + 1))
    if (!state || typeof state !== 'object' || Array.isArray(state)) return planText
    const lean = {
      goal_id: state.goal_id,
      owner: state.owner,
      objective: state.objective,
      status: state.status,
      blocker: state.blocker,
      pause_reason: state.pause_reason,
      persistent_runtime: state.persistent_runtime,
      task_board: leanTaskBoard(state.task_board),
      plan: Array.isArray(state.plan) ? state.plan.slice(0, 30) : undefined,
      current_step: state.current_step,
      current_step_text: state.current_step_text,
      revision: state.revision,
      last_operations: Array.isArray(state.last_operations) ? state.last_operations.slice(-16) : undefined,
    }
    return `${PLAN_STATE_MARKER} Compact harness-owned durable goal/plan state for this successful continuation.\n${JSON.stringify(lean)}`
  }
  catch {
    // Even if the state cannot be parsed, discard older dialogue before the
    // marker. Recovery attempts use the original unmodified messages.
    return planText
  }
}

export function compactCompletionReceipt(content) {
  const text = String(content ?? '')
  if (!text.startsWith(COMPLETION_MARKER)) return text
  const receiptAt = text.indexOf('Detailed task receipt:')
  if (receiptAt < 0) return text
  const raw = text.slice(receiptAt + 'Detailed task receipt:'.length).trim()
  try {
    const status = JSON.parse(raw)
    if (!status || typeof status !== 'object' || Array.isArray(status)) return text
    const lean = {
      task_state: status.task_state,
      queue_empty: status.queue_empty,
      queue_length: status.queue_length,
      last_completed_batch: status.last_completed_batch,
      last_cancelled_batch: status.last_cancelled_batch,
      basic_operation: status.basic_operation?.last_result
        ? { last_result: status.basic_operation.last_result }
        : undefined,
    }
    return `${COMPLETION_MARKER} Compact task receipt: ${JSON.stringify(lean)}`
  }
  catch {
    return text
  }
}

export function compactCompletionMessages(messages) {
  let replacedSystem = false
  return messages.map((message) => {
    if (!replacedSystem && message?.role === 'system') {
      replacedSystem = true
      return { ...message, content: COMPACT_CONTINUATION_PROMPT }
    }
    if (message?.role === 'user' && typeof message.content === 'string') {
      if (message.content.startsWith(COMPLETION_MARKER)) {
        return { ...message, content: compactCompletionReceipt(message.content) }
      }
      if (message.content.startsWith(MEMORY_MARKER) || message.content.includes(PLAN_STATE_MARKER)) {
        return { ...message, content: compactPlanStateContent(message.content) }
      }
    }
    return { ...message }
  })
}

export function compactCompletionTools(definitions = toolDefinitions) {
  return definitions.map((tool) => {
    if (tool?.type !== 'function' || !tool.function) return tool
    const description = typeof tool.function.description === 'string'
      ? tool.function.description.replace(/\s+/g, ' ').trim().slice(0, 120)
      : undefined
    return {
      ...tool,
      function: {
        ...tool.function,
        ...(description ? { description } : {}),
      },
    }
  })
}

export function providerEndpoint(base) {
  let url
  try { url = new URL(base) }
  catch { throw new DeploymentError('Invalid provider URL') }
  check(!url.username && !url.password && !url.search && !url.hash, 'Provider URL cannot contain credentials, query, or fragment')
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Remote provider URL requires HTTPS')
  url.pathname = url.pathname.replace(/\/?$/, '/') + 'chat/completions'
  return url.toString()
}

export async function providerRequest(config, messages, { fetchImpl = fetch, signal, allowTools = true, recoveryAttempt = 0 } = {}) {
  check(typeof config.key === 'string' && config.key.trim().length > 0, 'OPENAI_API_KEY is missing')
  check(typeof config.model === 'string' && /^[a-zA-Z0-9._:/-]{1,200}$/.test(config.model), 'Invalid model identifier')
  check(Array.isArray(messages) && messages.length > 0 && messages.length <= 50, 'Invalid provider message history')
  check(typeof allowTools === 'boolean', 'Invalid tool availability flag')
  check(Number.isSafeInteger(recoveryAttempt) && recoveryAttempt >= 0 && recoveryAttempt <= 100, 'Invalid provider recovery attempt')
  const timeoutMs = config.timeoutMs ?? 120000
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'Provider timeout must be an integer from 1000 to 600000 ms')

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const compactContinuation = isSuccessfulCompletionContinuation(messages, { allowTools, recoveryAttempt })
  const body = {
    model: config.model,
    messages: compactContinuation ? compactCompletionMessages(messages) : messages,
    max_tokens: compactContinuation ? COMPLETION_MAX_TOKENS : DEFAULT_MAX_TOKENS,
  }
  if (allowTools) {
    body.tools = compactContinuation ? compactCompletionTools(toolDefinitions) : toolDefinitions
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
