import { describe, expect, it } from 'vitest'
import { create_work, record_blackboard_event } from './blackboard'
import { build_message_board_snapshot, query_blackboard_events } from './queries'
import { create_empty_swarm_storage } from './storage'

describe('bounded board queries', () => {
  it('reports lost cursors after retained history rotates', () => {
    const swarm = create_empty_swarm_storage()
    const first = record_blackboard_event(swarm, { recordId: 'x', event: 'created', tick: 1, revision: 1 })
    for (let i = 0; i < 520; i++) record_blackboard_event(swarm, { recordId: 'x', event: 'updated', tick: i + 2, revision: i + 2 })
    expect(query_blackboard_events(swarm, { afterEventId: first.id }).cursorLost).toBe(true)
  })

  it('builds a priority-ordered message board read model including dependency-pending work', () => {
    const swarm = create_empty_swarm_storage()
    create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'low' }, requirements: { capabilities: [] }, priority: 1, createdTick: 1 })
    const high = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'high' }, requirements: { capabilities: [] }, priority: 99, createdTick: 1 })
    const pending = create_work(swarm, { createdBy: 'system', goal: { kind: 'custom', description: 'pending' }, requirements: { capabilities: [] }, priority: 50, dependencies: ['work-missing'], createdTick: 1 })
    const snapshot = build_message_board_snapshot(swarm, 4)
    expect(snapshot.work[0].id).toBe(high.id)
    expect(snapshot.work.some(work => work.id === pending.id)).toBe(true)
    expect(snapshot.counts.blockedWork).toBe(1)
  })
})
