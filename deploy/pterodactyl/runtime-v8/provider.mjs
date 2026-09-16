import { check, DeploymentError } from './common.mjs'
import { toolDefinitions } from './structured-policy.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'
const FAILURE_MARKER = '[MOD] Autorio operation error:'
const CHAT_MARKER = '[CHAT]'
const STEERING_MARKER = '[STEERING]'
const COMPLETION_MAX_TOKENS = 1000
const DEFAULT_MAX_TOKENS = 2000
const PLAN_STATE_MARKER = '[PLAN_STATE]'
const MEMORY_MARKER = '[MEMORY]'

const COMPACT_CONTINUATION_PROMPT = `You are AIRI, an autonomous standalone Factorio NPC. This request is a successful Autorio batch-completion continuation for an existing user goal, not a new goal.

Use the supplied [PLAN_STATE] as the canonical durable Task Board. Preserve its completed prefix and continue the active goal; do not restart or silently rewrite the plan. Mutable world state still requires observation when it is actually needed for the next decision.

Token-efficient continuation rules:
- Treat a provider turn as an observation/decision boundary, not as an operation boundary. If 2-4 consecutive operations are already fully parameterized from current observations and a later operation does not depend on a new identity/result created by an earlier one, return them together in execution order.
- If the Task Board/receipt already contains deterministic_verification with verdict verified_complete for the action that just finished, do not spend a tool call re-checking that exact fact.
- Call read-only tools only for unknown mutable facts required to choose or parameterize the next operation.
- Prefer a tightly related deterministic operation batch when every operation can be fully specified now and no later operation needs an identity/result created by an earlier one. Multiple gather_resource operations for known resources may be submitted together. When one exact observed entity needs multiple item types, prefer one supply_entity operation over separate transfer turns.
- Do not insert wait between finite Autorio operations merely to let them finish. The harness resumes you when the submitted batch completes or fails. Use wait only when actual world time must pass and no Autorio-owned finite operation already represents the work.
- Runtime navigation/reach/obstacle recovery is internal progress, not a new plan step and not a reason to call the model again. Exact transfers, recipe configuration, rotation, and exact placement may auto-approach using the controlled character's real reach.
- Do not walk AIRI onto an exact future build coordinate just to place there. place_entity can be issued from build range; the runtime approaches only as close as needed and can step AIRI aside when AIRI's own body is the likely placement blocker.
- A cancelled batch stops the failing operation and its dependent queued operations. If the receipt says placing:not_placeable, that attempted placement did not create an entity. Never invent a new unit_number or claim that a cancelled placement succeeded; observe the world after a successful placement when a later exact operation needs the new identity.
- For a bounded local construction batch, use validateConstructionPlan on the exact chosen placements, then execute only the returned validation_id and placement_count with execute_construction_plan. Do not edit coordinates or directions after validation; revalidate instead. A clean completed construction batch is deterministic evidence that every validated placement succeeded.
- research_technology submission is not completed research; verify the actual technology before depending on it. wait is never proof that a world condition became true. Item transfers may be partial and need relevant verification before depending on an exact quantity.
- When simply continuing with another operation and the human does not need to act, set chatMessage to an empty string. Use chatMessage for a blocker, a decision that needs the human, or verified final completion.
- Never emit Lua, game.*, shell/console commands, or unapproved operations.

Approved operations and bounded arguments:
walk_to_entity {entity_name,search_radius}; walk_to_entity_exact {unit_number,reach_distance}; walk_to_position {x,y,reach_distance}; walk_to_player {player_name}; follow_player {player_name,follow_distance}; stop_follow_player {}; set_auto_defense {enabled}; equip_weapon {item_name,slot}; equip_ammo {item_name,slot}; equip_armor {item_name}; select_weapon_slot {slot}; mine_entity {entity_name,count}; mine_entity_exact {unit_number}; mine_resource_at {resource_name,x,y,count}; gather_resource {resource_name,count,search_radius}; supply_entity {unit_number,items:[{item_name,count}]}; execute_construction_plan {validation_id,placement_count}; place_entity {entity_name,x?,y?,direction?}; rotate_entity {unit_number,reverse}; move_items {item_name,entity_name,max_count,to_entity}; move_items_exact {item_name,unit_number,max_count,to_entity}; move_items_with_player {item_name,player_name,max_count,to_player}; set_machine_recipe {unit_number,recipe_name}; craft_item {item_name,count}; attack_nearest_enemy {search_radius}; clear_enemy_area {search_radius}; research_technology {technology_name}; wait {ticks}.

Return exactly one strict JSON object with exactly these fields:
{"chatMessage":"","plan":["observable step"],"currentStep":0,"operations":[{"name":"approved_operation","args":{}}]}
plan is the visible canonical checklist proposal, currentStep indexes it, and operations contains only approved structured operations. If the whole goal is verified complete, return plan:[], currentStep:0, operations:[] and a short completion chatMessage.`

function isSuccessfulCompletionContinuation(messages, { allowTools, recoveryAttempt }) {
  if (!allowTools || recoveryAttempt > 0 || !Array.isArray(messages)) return false
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  return typeof lastUser?.content === 'string' && lastUser.content.startsWith(COMPLETION_MARKER)
}

function topLevelJsonObjectSpans(text) {
  const spans = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }

    if (depth > 0 && char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        spans.push([start, index + 1])
        start = -1
      }
    }
  }

  return depth === 0 && !inString ? spans : []
}

export function normalizeProviderPlanContent(content) {
  const text = String(content ?? '').trim()
  if (!text) return text

  try {
    JSON.parse(text)
    return text
  }
  catch {}

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) {
    const candidate = fenced[1].trim()
    try {
      JSON.parse(candidate)
      return candidate
    }
    catch {}
  }

  const spans = topLevelJsonObjectSpans(text)
  if (spans.length !== 1) return text
  const candidate = text.slice(spans[0][0], spans[0][1]).trim()
  try {
    JSON.parse(candidate)
    return candidate
  }
  catch {
    return text
  }
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

function parsePlanStateFromContent(content) {
  const text = String(content ?? '')
  const markerAt = text.lastIndexOf(PLAN_STATE_MARKER)
  if (markerAt < 0) return undefined
  const planText = text.slice(markerAt)
  const newlineAt = planText.indexOf('\n')
  if (newlineAt < 0) return undefined
  try {
    const state = JSON.parse(planText.slice(newlineAt + 1))
    return state && typeof state === 'object' && !Array.isArray(state) ? state : undefined
  }
  catch {
    return undefined
  }
}

function currentPlanState(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string' || !message.content.includes(PLAN_STATE_MARKER)) continue
    const state = parsePlanStateFromContent(message.content)
    if (state) return state
  }
  return undefined
}

function latestDirectChat(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    const text = message.content.trim()
    if (!text.startsWith(CHAT_MARKER)) continue
    const body = text.slice(CHAT_MARKER.length).trim()
    const separator = body.indexOf(':')
    const sender = separator >= 0 ? body.slice(0, separator).trim() : 'unknown'
    const request = (separator >= 0 ? body.slice(separator + 1) : body).trim()
    return { sender: sender.slice(0, 128), text: request.slice(0, 1200) }
  }
  return undefined
}

function isResumeText(value) {
  const text = String(value ?? '').trim().toLocaleLowerCase()
  if (!text) return false
  const prefixes = ['continue', 'resume', '继续', '继续吧', '继续做', '接着', '接着做']
  return prefixes.some(prefix => text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}，`) || text.startsWith(`${prefix},`))
}

export function classifyUserSteering(messages) {
  const chat = latestDirectChat(messages)
  if (!chat) return undefined
  const state = currentPlanState(messages)
  const hasPendingGoal = state && state.status !== 'completed'
  const sameAsDurableObjective = hasPendingGoal
    && typeof state?.objective === 'string'
    && state.objective.trim() === chat.text.trim()
  const mode = isResumeText(chat.text)
    ? (hasPendingGoal ? 'resume_existing_goal' : 'new_goal')
    : sameAsDurableObjective
      ? 'current_goal'
      : (hasPendingGoal ? 'steer_existing_goal' : 'new_goal')
  return {
    mode,
    sender: chat.sender,
    text: chat.text,
    goal_id: state?.goal_id,
    goal_status: state?.status,
    active_step: state?.current_step_text,
  }
}

function latestFailure(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    if (message.content.startsWith(FAILURE_MARKER)) return message.content.slice(0, 5000)
  }
  return ''
}

function failureRecoveryHint(failure) {
  if (!failure) return ''
  if (/PLANNED_COLLISION|WORLD_COLLISION|placing:not_placeable|not_placeable/i.test(failure)) {
    return 'placement_failure: do not retry the same coordinate blindly; use returned footprint/blocker geometry or validate a revised local construction batch before execution'
  }
  if (/too_far/i.test(failure)) {
    return 'range_failure: do not create a walk/action/model loop; use exact target identity when available and let runtime reach recovery handle deterministic approach, re-observing only if the target itself is stale'
  }
  if (/target[^\n]{0,80}(?:missing|not found)|entity[^\n]{0,80}not found/i.test(failure)) {
    return 'stale_target: re-observe the exact entity identity instead of substituting an arbitrary same-name target'
  }
  if (/ITEMS_MISSING|missing items|insufficient inventory/i.test(failure)) {
    return 'inventory_failure: satisfy the deterministic inventory deficit before retrying the blocked construction/action'
  }
  return 'operation_failure: the failed operation and dependent queued operations are not successful; use the receipt to choose the smallest necessary recovery'
}

function steeringDomain(state, failure) {
  const haystack = JSON.stringify({
    objective: state?.objective,
    step: state?.current_step_text,
    operations: state?.last_operations,
    blocker: state?.blocker,
    failure,
  })
  if (/place_entity|placing|construction|PLANNED_COLLISION|WORLD_COLLISION|execute_construction_plan|validateConstructionPlan/i.test(haystack)) return 'construction'
  if (/gather_resource|mine_entity|mine_resource|mining/i.test(haystack)) return 'mining'
  if (/move_items|supply_entity|moving_items|transfer/i.test(haystack)) return 'logistics'
  return 'general'
}

function receiptDelta(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    const text = message.content
    if (!text.startsWith(COMPLETION_MARKER)) continue
    const receiptAt = text.indexOf('Detailed task receipt:')
    if (receiptAt < 0) return 'last_receipt=completed; treat the completion receipt as authoritative evidence for the submitted batch'
    try {
      const status = JSON.parse(text.slice(receiptAt + 'Detailed task receipt:'.length).trim())
      const batch = status?.last_completed_batch
      const types = Array.isArray(batch?.task_types) ? batch.task_types.slice(0, 6).join(',') : ''
      const resultCode = status?.basic_operation?.last_result?.code
      return `last_receipt=completed${Number.isSafeInteger(batch?.batch_id) ? ` batch=${batch.batch_id}` : ''}${types ? ` tasks=${types}` : ''}${resultCode ? ` result=${resultCode}` : ''}; do not re-check deterministic facts already proven by this receipt`
    }
    catch {
      return 'last_receipt=completed; treat the completion receipt as authoritative evidence for the submitted batch'
    }
  }
  return ''
}

export function buildSteeringContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const state = currentPlanState(messages)
  const user = classifyUserSteering(messages)
  const failure = latestFailure(messages)
  const failureHint = failureRecoveryHint(failure)
  const domain = steeringDomain(state, failure)
  const lines = [
    `${STEERING_MARKER} Harness-generated decision guidance; this is not Factorio world state.`,
    `domain=${domain}`,
    'decision_order=exact observed identity > nearest-name lookup; deterministic validator > trial-and-error action; small fully-parameterized batch > one-operation-per-turn; runtime fact > prototype fact > remembered game knowledge',
    'batch_boundary=stop before an operation that needs a new unit_number, mutable result, or other observation that does not exist yet',
    'success_evidence=never claim a world-changing action succeeded from intent alone; require an operation receipt or subsequent observation',
  ]

  if (user) {
    lines.push(`user_mode=${user.mode}${user.goal_id ? ` goal=${user.goal_id}` : ''}${user.goal_status ? ` status=${user.goal_status}` : ''}`)
    lines.push(`latest_human=${JSON.stringify(user.text)}`)
    if (user.mode === 'steer_existing_goal') {
      lines.push('user_steering=the latest human instruction is authoritative for pending intent; preserve verified completed evidence, revise/reorder/drop remaining steps as needed, and do not treat the older durable objective as overriding this steering')
    }
    else if (user.mode === 'resume_existing_goal') {
      lines.push('user_steering=resume the existing durable goal; do not reinterpret a bare continue/resume as a new independent goal')
    }
    else if (user.mode === 'current_goal') {
      lines.push('user_steering=this is the original current durable goal, not a new mid-plan steering event; preserve completed evidence and continue the canonical active plan unless live evidence requires a replan')
    }
    else {
      lines.push('user_steering=treat this as the current human goal; prior completed history is context, not an instruction to continue an older goal')
    }
  }

  if (domain === 'construction') {
    lines.push('construction=physical collision footprint != mining/working area != selection box != pickup/drop position; validate multiple exact placements together before executing them')
  }
  if (failureHint) lines.push(`recovery=${failureHint}`)
  const delta = receiptDelta(messages)
  if (delta) lines.push(delta)
  return lines.join('\n').slice(0, 3600)
}

export function applySteeringMessages(messages, sourceMessages = messages) {
  const output = Array.isArray(messages) ? messages.map(message => ({ ...message })) : []
  const steering = buildSteeringContext(sourceMessages)
  if (!steering) return output
  const steeringMessage = { role: 'user', content: steering }
  const last = output.at(-1)
  if (last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith('[MOD]')) {
    output.splice(Math.max(0, output.length - 1), 0, steeringMessage)
  }
  else {
    output.push(steeringMessage)
  }
  return output
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
  const compactedMessages = compactContinuation ? compactCompletionMessages(messages) : messages
  const body = {
    model: config.model,
    messages: applySteeringMessages(compactedMessages, messages),
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
    if (message.tool_calls === undefined && typeof message.content === 'string') {
      message.content = normalizeProviderPlanContent(message.content)
    }
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
