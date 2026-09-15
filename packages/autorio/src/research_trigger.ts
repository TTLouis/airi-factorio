type TriggerSummary = {
  type: string
  item?: string
  count?: number
  entity?: string
  fluid?: string
  amount?: number
}

const STRING_FIELDS = ['item', 'entity', 'fluid'] as const
const NUMBER_FIELDS = ['count', 'amount'] as const

export function research_trigger_summary(name: string): TriggerSummary | undefined {
  const prototype = prototypes.technology[name]
  const trigger = prototype?.research_trigger as any
  if (!trigger || typeof trigger.type !== 'string') return undefined

  const result: TriggerSummary = { type: trigger.type }
  for (const key of STRING_FIELDS) {
    if (typeof trigger[key] === 'string') result[key] = trigger[key]
  }
  for (const key of NUMBER_FIELDS) {
    if (typeof trigger[key] === 'number') result[key] = trigger[key]
  }
  return result
}

export function with_research_trigger<T extends Record<string, unknown>>(name: string, technology: T) {
  const trigger = research_trigger_summary(name)
  if (!trigger) return technology
  return {
    ...technology,
    trigger_type: trigger.type,
    research_trigger: trigger,
  }
}
