import { describe, expect, it } from 'vitest'
import { display_name_for_agent, SWARM_NPC_NAME_POOL } from './names'

describe('swarm logical npc names', () => {
  it('provides a broad deterministic first generation of unique names', () => {
    const names = SWARM_NPC_NAME_POOL.map((_name, index) => display_name_for_agent(`agent-${index + 1}`))
    expect(names).toHaveLength(64)
    expect(new Set(names).size).toBe(64)
    expect(names[0]).toBe('AIRI-Astra')
    expect(names[63]).toBe('AIRI-Zane')
  })

  it('stays unique after the base pool wraps', () => {
    expect(display_name_for_agent('agent-65')).toBe('AIRI-Astra-2')
    expect(display_name_for_agent('agent-128')).toBe('AIRI-Zane-2')
    expect(display_name_for_agent('agent-129')).toBe('AIRI-Astra-3')
  })

  it('is tied to logical agent id rather than physical body identity', () => {
    expect(display_name_for_agent('agent-7')).toBe(display_name_for_agent('agent-7'))
    expect(display_name_for_agent('agent-7')).not.toBe(display_name_for_agent('agent-8'))
  })
})
