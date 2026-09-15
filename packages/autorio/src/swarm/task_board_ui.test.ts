import { describe, expect, it } from 'vitest'
import type { SwarmTaskBoardEntry } from './task_board_ui'
import { collect_swarm_roster } from './task_board_ui'

function board(objective: string) {
  return {
    goal_id: `goal-${objective}`,
    objective,
    status: 'active' as const,
    blocker: '',
    pause_reason: '',
    completed_count: 0,
    total_steps: 1,
    active_index: 0,
    steps: [{ id: 'step-1', description: objective, status: 'active' as const }],
    activity: [],
    wanted_items: [],
  }
}

describe('swarm task board roster', () => {
  it('derives stable display names from logical agent ids and preserves per-agent boards', () => {
    const stored: Record<string, SwarmTaskBoardEntry> = {
      'agent-2': {
        agent_id: 'agent-2',
        actor_id: 'actor-2',
        display_name: 'ignored-stored-name',
        board: board('Mine copper'),
      },
    }
    const roster = collect_swarm_roster({
      actors: [
        { actorId: 'actor-1', runtime: { agentId: 'agent-1', bodyRevision: 1 }, agent: { id: 'agent-1' } },
        { actorId: 'actor-2', runtime: { agentId: 'agent-2', bodyRevision: 7 }, agent: { id: 'agent-2' } },
      ],
    }, stored)

    expect(roster.map(item => [item.agent_id, item.display_name])).toEqual([
      ['agent-1', 'AIRI-Astra'],
      ['agent-2', 'AIRI-Mika'],
    ])
    expect(roster[0].board).toBeUndefined()
    expect(roster[1].board?.objective).toBe('Mine copper')
  })

  it('does not change logical names when a physical body revision changes', () => {
    const first = collect_swarm_roster({
      actors: [{ actorId: 'actor-9', runtime: { agentId: 'agent-9', bodyRevision: 1 }, agent: { id: 'agent-9' } }],
    }, {})
    const replaced = collect_swarm_roster({
      actors: [{ actorId: 'actor-9', runtime: { agentId: 'agent-9', bodyRevision: 12 }, agent: { id: 'agent-9' } }],
    }, {})

    expect(first[0].display_name).toBe(replaced[0].display_name)
    expect(first[0].display_name).toBe('AIRI-Rhea')
  })

  it('keeps stored boards visible during temporary body loss', () => {
    const stored: Record<string, SwarmTaskBoardEntry> = {
      'agent-3': {
        agent_id: 'agent-3',
        actor_id: 'actor-3',
        display_name: 'AIRI-Nova',
        board: board('Recover body'),
      },
    }
    const roster = collect_swarm_roster({ actors: [] }, stored)
    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({ agent_id: 'agent-3', actor_id: 'actor-3', display_name: 'AIRI-Nova' })
    expect(roster[0].board?.objective).toBe('Recover body')
  })
})
