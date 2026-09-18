const INTENTS = new Set([
  'continue_current',
  'status_query',
  'amend_current',
  'new_goal',
  'cancel_current',
  'chat_only',
])

const ROUTER_SYSTEM_PROMPT = [
  'You are AIRI\'s read-only human interaction lifecycle router.',
  'You classify the latest human message only. You have no Factorio tools, no world mutation authority, and no authority to mutate canonical task state.',
  'Return exactly one JSON object with keys: intent, queue_conflict, reply.',
  'intent must be one of: continue_current, status_query, amend_current, new_goal, cancel_current, chat_only.',
  'continue_current: a bare continue/resume instruction for the existing goal with no new constraint.',
  'status_query: asks what AIRI is doing, progress, queue/runtime state, blockers, or why it appears stuck.',
  'amend_current: changes constraints, priorities, scope, or method while preserving the same canonical goal.',
  'new_goal: a genuinely independent objective that should replace the current goal. Do not use this merely because the message is a new chat turn.',
  'cancel_current: asks to stop, pause, or cancel the current work.',
  'chat_only: conversational content that should not alter task or world state.',
  'queue_conflict must be true only for amend_current when the requested amendment conflicts with remaining queued work; otherwise false.',
  'reply is only for chat_only and must be short. For every other intent return an empty reply.',
  'Use only the bounded state supplied by the harness. Do not invent world facts.',
].join('\n')

function boundedText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max)
}

function normalizedSnapshot(snapshot = {}) {
  const runtime = snapshot.runtime && typeof snapshot.runtime === 'object' ? snapshot.runtime : {}
  return {
    canonical_objective: boundedText(snapshot.canonical_objective, 800),
    goal_status: boundedText(snapshot.goal_status, 32),
    current_step: boundedText(snapshot.current_step, 500),
    runtime: {
      task_state: boundedText(runtime.task_state, 64),
      queue_empty: runtime.queue_empty === true ? true : runtime.queue_empty === false ? false : undefined,
      queue_length: Number.isSafeInteger(runtime.queue_length) ? Math.max(0, runtime.queue_length) : undefined,
      status_error: boundedText(runtime.status_error, 240) || undefined,
    },
    latest_human_message: boundedText(snapshot.latest_human_message, 1200),
  }
}

export function interactionRouterMessages(snapshot) {
  return [
    { role: 'system', content: ROUTER_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(normalizedSnapshot(snapshot)) },
  ]
}

function stripFence(value) {
  const text = String(value ?? '').trim()
  const fenced = text.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i)
  return fenced ? fenced[1].trim() : text
}

export function parseInteractionRoute(message) {
  const raw = typeof message === 'string' ? message : message?.content
  let parsed
  try { parsed = JSON.parse(stripFence(raw)) }
  catch { throw new Error('Interaction router returned invalid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Interaction router returned a non-object')
  if (!INTENTS.has(parsed.intent)) throw new Error('Interaction router returned an invalid intent')
  if (typeof parsed.queue_conflict !== 'boolean') throw new Error('Interaction router queue_conflict must be boolean')
  if (parsed.reply !== undefined && typeof parsed.reply !== 'string') throw new Error('Interaction router reply must be a string')
  return {
    intent: parsed.intent,
    queue_conflict: parsed.intent === 'amend_current' ? parsed.queue_conflict : false,
    reply: parsed.intent === 'chat_only' ? boundedText(parsed.reply, 500) : '',
  }
}

function hasPendingGoal(snapshot) {
  const status = String(snapshot?.goal_status ?? '').toLowerCase()
  return Boolean(snapshot?.canonical_objective) && status !== '' && status !== 'completed'
}

export function fallbackInteractionRoute(snapshot = {}) {
  const text = boundedText(snapshot.latest_human_message, 1200)
  const lower = text.toLocaleLowerCase()
  if (/^(?:stop|pause|cancel|停止|停下|暂停|取消|别做了|不要做了)[\s.!。！]*$/i.test(text)
    || /(?:停止|暂停|取消).{0,8}(?:当前|这个)?(?:任务|工作|目标)/.test(text)) {
    return { intent: 'cancel_current', queue_conflict: false, reply: '' }
  }
  if (/(?:status|progress|what.{0,20}(?:doing|happening)|where.{0,20}stuck|汇报|状态|进度|卡住|在做什么|做到哪)/i.test(text)) {
    return { intent: 'status_query', queue_conflict: false, reply: '' }
  }
  if (/^(?:continue|resume|继续|继续吧|继续做|接着|接着做)[\s.!。！]*$/i.test(text)) {
    return { intent: hasPendingGoal(snapshot) ? 'continue_current' : 'chat_only', queue_conflict: false, reply: '' }
  }
  if (/^(?:hi|hello|hey|thanks|thank you|你好|谢谢|辛苦了)[\s.!。！]*$/i.test(lower)) {
    return { intent: 'chat_only', queue_conflict: false, reply: '' }
  }
  if (hasPendingGoal(snapshot)) {
    return { intent: 'amend_current', queue_conflict: true, reply: '' }
  }
  return { intent: 'new_goal', queue_conflict: false, reply: '' }
}

export async function routeHumanInteraction(provider, snapshot) {
  if (typeof provider !== 'function') throw new Error('Interaction router provider is unavailable')
  const message = await provider(interactionRouterMessages(snapshot), {
    allowTools: false,
    lifecycle: 'interaction_router',
    sideChannel: true,
    requestBodyPatch: {
      max_tokens: 256,
      response_format: { type: 'json_object' },
    },
  })
  return parseInteractionRoute(message)
}
