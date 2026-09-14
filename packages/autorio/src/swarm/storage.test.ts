import { describe, expect, it } from 'vitest'
import { allocate_swarm_id, get_swarm_storage, SWARM_STORAGE_VERSION } from './storage'

describe('swarm storage foundation', () => {
  it('initializes without overwriting unrelated save state', () => {
    const root: any = { existing_npc_state: 'preserve-me' }
    const swarm = get_swarm_storage(root)
    expect(swarm.version).toBe(SWARM_STORAGE_VERSION)
    expect(swarm.actors).toEqual({})
    expect(swarm.board.events).toEqual([])
    expect(swarm.board.reservations).toEqual({})
    expect(root.existing_npc_state).toBe('preserve-me')
  })

  it('fills missing version-1 tables without discarding counters', () => {
    const root: any = { airi_swarm: { version: SWARM_STORAGE_VERSION, counters: { work: 4 } } }
    const swarm = get_swarm_storage(root)
    expect(swarm.board.work).toEqual({})
    expect(swarm.agents).toEqual({})
    expect(swarm.actors).toEqual({})
    expect(allocate_swarm_id('work', swarm)).toBe('work-5')
  })

  it('reconstructs unbound actor metadata for older version-1 agent bindings', () => {
    const root: any = {
      airi_swarm: {
        version: SWARM_STORAGE_VERSION,
        agents: {
          'agent-1': {
            id: 'agent-1',
            actorId: 'actor-7',
            state: 'available',
            activeRequestIds: [],
            revision: 1,
          },
        },
      },
    }
    const swarm = get_swarm_storage(root)
    expect(swarm.actors['actor-7']).toEqual({
      id: 'actor-7',
      state: 'unbound',
      bodyRevision: 0,
      revision: 1,
    })
  })

  it('allocates independent deterministic logical ids', () => {
    const swarm = get_swarm_storage({})
    expect(allocate_swarm_id('agent', swarm)).toBe('agent-1')
    expect(allocate_swarm_id('actor', swarm)).toBe('actor-1')
    expect(allocate_swarm_id('agent', swarm)).toBe('agent-2')
    expect(allocate_swarm_id('work', swarm)).toBe('work-1')
  })

  it('rejects unsupported schema versions', () => {
    expect(() => get_swarm_storage({ airi_swarm: { version: SWARM_STORAGE_VERSION + 1 } })).toThrow('Unsupported swarm storage version')
  })
})
