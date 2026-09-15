import type { AgentId } from './types'

export const SWARM_NPC_NAME_POOL = [
  'Astra', 'Mika', 'Nova', 'Kira', 'Nami', 'Sora', 'Luna', 'Mira',
  'Rhea', 'Iris', 'Cora', 'Lyra', 'Nia', 'Emi', 'Yuna', 'Hana',
  'Aiko', 'Mei', 'Rina', 'Aria', 'Tali', 'Vela', 'Nyx', 'Eira',
  'Faye', 'Kaia', 'Luma', 'Nori', 'Oona', 'Piri', 'Sela', 'Tira',
  'Uma', 'Vivi', 'Wren', 'Xara', 'Yori', 'Zia', 'Ada', 'Bex',
  'Cleo', 'Dara', 'Elio', 'Finn', 'Gio', 'Hugo', 'Ivo', 'Juno',
  'Kato', 'Leon', 'Milo', 'Nico', 'Orin', 'Pax', 'Quin', 'Remy',
  'Sage', 'Theo', 'Uri', 'Vera', 'Wade', 'Xeno', 'Yuki', 'Zane',
] as const

function numeric_agent_ordinal(agentId: AgentId) {
  const match = /^agent-(\d+)$/.exec(agentId)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stable_text_hash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash ^ value.charCodeAt(index)) * 16777619
    hash = hash >>> 0
  }
  return hash
}

/**
 * Stable human-facing name for a logical agent. The logical agent id is the
 * authority; replacing a Factorio character/body never changes the name.
 * Names remain unique after the base pool wraps by adding a generation suffix.
 */
export function display_name_for_agent(agentId: AgentId) {
  const ordinal = numeric_agent_ordinal(agentId) ?? (stable_text_hash(agentId) + 1)
  const index = (ordinal - 1) % SWARM_NPC_NAME_POOL.length
  const generation = Math.floor((ordinal - 1) / SWARM_NPC_NAME_POOL.length) + 1
  const base = SWARM_NPC_NAME_POOL[index]
  return generation === 1 ? `AIRI-${base}` : `AIRI-${base}-${generation}`
}

export function short_name_for_agent(agentId: AgentId) {
  const value = display_name_for_agent(agentId)
  return value.startsWith('AIRI-') ? value.slice(5) : value
}
