import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProjectJevShadowSnapshot,
  SwarmProjectJevShadowController,
} from './swarm-project-jev-shadow.mjs'

function globalSnapshot() {
  return {
    schema: 'swarm_coordination_snapshot_v1',
    tick: 900,
    limit: 12,
    counts: {
      missions: 1,
      objectives: 2,
      projects: 1,
      work: 3,
      requests: 1,
      claims: 1,
      results: 2,
      agents: 2,
      actors: 2,
      activeWarnings: 1,
    },
    missions: [{ id: 'mission-1', status: 'active', title: 'Automate science' }],
    objectives: [
      { id: 'objective-1', status: 'satisfied', description: 'Bootstrap power' },
      { id: 'objective-2', status: 'active', description: 'Automate red science' },
    ],
    projects: [{ id: 'project-1', status: 'executing', title: 'Build red science line' }],
    work: [{ id: 'work-1', status: 'active', title: 'Place assemblers' }],
    requests: [{ id: 'request-1', status: 'open', description: 'Need iron plates' }],
    warnings: [{ id: 'warning-1', active: true, description: 'Supply shortage' }],
    claims: [{ id: 'claim-1', workId: 'work-1', agentId: 'agent-1', actorId: 'actor-1' }],
    results: [
      { id: 'result-1', workId: 'work-0', summary: 'Power established' },
      { id: 'result-2', workId: 'work-1', summary: 'Assemblers partially placed' },
    ],
    agents: [
      { id: 'agent-1', state: 'working' },
      { id: 'agent-2', state: 'available' },
    ],
    actors: [
      { id: 'actor-1', state: 'online' },
      { id: 'actor-2', state: 'online' },
    ],
  }
}

test('project Jev snapshot is built from the one canonical global swarm projection', () => {
  const source = globalSnapshot()
  const projected = buildProjectJevShadowSnapshot(source, {
    strategicBoard: {
      goal_id: 'goal-rocket',
      title: 'Launch a rocket',
      revision: 4,
      current_milestone: { title: 'Automate science' },
    },
  })

  assert.equal(projected.global.tick, 900)
  assert.equal(projected.missions[0].id, 'mission-1')
  assert.equal(projected.objectives.length, 2)
  assert.equal(projected.projects[0].id, 'project-1')
  assert.equal(projected.runtime.active, true)
  assert.equal(projected.runtime.blocked, true)
  assert.equal(projected.evidence[0].kind, 'result')
})

test('project Jev controller performs one global RCON snapshot read and one shadow decision call', async () => {
  const commands = []
  let decisionCalls = 0
  const rcon = {
    async command(command) {
      commands.push(command)
      return JSON.stringify(globalSnapshot())
    },
  }
  const controller = new SwarmProjectJevShadowController({
    rcon,
    decisionProvider: async (state, questions) => {
      decisionCalls += 1
      assert.equal(state.schema, 'swarm_jev_shadow_v1')
      assert.equal(state.strategic_project_board.title, 'Launch a rocket')
      assert.equal(state.counts.missions, 1)
      assert.equal(questions.development.type, 'choice')
      return {
        answers: {
          routing: { choice: 'continue_runtime', confidence: 0.9 },
          granularity: { choice: 'keep', confidence: 0.8 },
          development: { choice: 'vertical', confidence: 0.85 },
          reasoning_budget: { choice: 'normal', confidence: 0.7 },
          planning_horizon: { choice: 'subgoal' },
          observation_budget: { score: 2 },
        },
      }
    },
  })

  const result = await controller.observe({
    strategicBoard: {
      kind: 'strategic_project_board_v1',
      goal_id: 'goal-rocket',
      title: 'Launch a rocket',
      revision: 4,
      current_milestone: { title: 'Automate science' },
      next_milestones: [],
      completed_milestones: [],
      development_direction: 'vertical',
      transition_state: '',
      status: 'active',
      updated_at: 100,
    },
  })

  assert.equal(commands.length, 1)
  assert.match(commands[0], /autorio_swarm_coordination","snapshot",12/)
  assert.equal(decisionCalls, 1)
  assert.equal(result.scope, 'swarm_global')
  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.equal(result.source_tick, 900)
  assert.equal(result.decision.decision.development, 'vertical')
  assert.equal(result.decision.decision.routing, 'continue_runtime')
})

test('project-level Jev stays independent of any logical NPC or actor identity', async () => {
  const controller = new SwarmProjectJevShadowController({
    rcon: {
      async command() {
        return JSON.stringify(globalSnapshot())
      },
    },
    decisionProvider: async (state, _questions, options) => {
      assert.equal(Object.hasOwn(state, 'npc_id'), false)
      assert.equal(Object.hasOwn(state, 'agent_id'), false)
      assert.equal(Object.hasOwn(state, 'actor_id'), false)
      assert.deepEqual(options, {})
      return { answers: {} }
    },
  })

  const result = await controller.observe()
  assert.equal(result.scope, 'swarm_global')
  assert.equal(result.decision.decision.routing, 'wake_planner')
})

test('project controller telemetry remains shadow-only even when Jev asks to split', async () => {
  const controller = new SwarmProjectJevShadowController({
    rcon: {
      async command() {
        return JSON.stringify(globalSnapshot())
      },
    },
    decisionProvider: async () => ({
      answers: {
        routing: { choice: 'wake_planner', confidence: 0.9 },
        granularity: { choice: 'split', confidence: 0.95 },
        development: { choice: 'horizontal', confidence: 0.8 },
        reasoning_budget: { choice: 'strategic', confidence: 0.9 },
        planning_horizon: { choice: 'strategic' },
        observation_budget: { score: 4 },
      },
    }),
  })

  const result = await controller.observe()
  assert.equal(result.decision.decision.granularity, 'split')
  assert.equal(result.decision.decision.development, 'horizontal')
  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.deepEqual(result.decision.effects, [])
})

test('last telemetry is defensive-copied and cannot mutate controller state', async () => {
  const controller = new SwarmProjectJevShadowController({
    rcon: {
      async command() {
        return JSON.stringify(globalSnapshot())
      },
    },
  })

  await controller.observe()
  const first = controller.last()
  first.source_counts.missions = 999
  const second = controller.last()
  assert.equal(second.source_counts.missions, 1)
})


test('completed historical work does not make project Jev think runtime is active', () => {
  const source = globalSnapshot()
  source.counts.work = 25
  source.counts.claims = 0
  source.work = [
    { id: 'work-20', status: 'completed', title: 'Historical work' },
  ]
  source.warnings = []
  source.counts.activeWarnings = 0

  const projected = buildProjectJevShadowSnapshot(source)
  assert.equal(projected.runtime.active, false)
  assert.equal(projected.runtime.reason, 'swarm_idle')
})

test('claimed or active sampled work remains authoritative runtime activity', () => {
  const source = globalSnapshot()
  source.counts.claims = 0
  source.work = [
    { id: 'work-live', status: 'active', title: 'Live work' },
  ]

  const projected = buildProjectJevShadowSnapshot(source)
  assert.equal(projected.runtime.active, true)
  assert.equal(projected.runtime.reason, 'swarm_active_warnings')
})
