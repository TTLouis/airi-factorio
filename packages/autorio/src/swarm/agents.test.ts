import { describe, expect, it } from 'vitest'
import { allocate_logical_actor_id, bind_agent_actor, create_agent, update_agent_commitment } from './agents'
import { create_empty_swarm_storage } from './storage'

describe('logical swarm identity', () => {
  it('keeps agent and actor ids separate and revision protected', () => {
    const swarm = create_empty_swarm_storage()
    const agent = create_agent(swarm)
    const actor = allocate_logical_actor_id(swarm)
    const revision = agent.revision

    expect(bind_agent_actor(swarm, agent.id, revision, actor).ok).toBe(true)
    expect(bind_agent_actor(swarm, agent.id, revision, allocate_logical_actor_id(swarm)))
      .toMatchObject({ ok: false, code: 'revision_mismatch' })
  })

  it('does not allow one logical actor to be bound to two agents', () => {
    const swarm = create_empty_swarm_storage()
    const actor = allocate_logical_actor_id(swarm)

    create_agent(swarm, actor)
    expect(() => create_agent(swarm, actor)).toThrow('already bound')
  })

  it('persists current commitment rather than a permanent role', () => {
    const swarm = create_empty_swarm_storage()
    const agent = create_agent(swarm, allocate_logical_actor_id(swarm))
    const updated = update_agent_commitment(swarm, {
      agentId: agent.id,
      expectedRevision: agent.revision,
      tick: 100,
      state: 'working',
      currentWorkId: 'work-7',
      focusDescription: 'Deliver belts',
    })

    expect(updated).toMatchObject({ ok: true, agent: { currentWorkId: 'work-7', state: 'working' } })
    expect('role' in (updated.ok ? updated.agent : {})).toBe(false)
  })
})
