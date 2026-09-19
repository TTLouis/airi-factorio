import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function activePlan() {
  return {
    goal_id: 'goal_existing',
    owner: 'tester',
    objective: 'build an early burner coal loop',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['place and start the loop', 'verify it stays fueled'],
    current_step: 0,
    revision: 1,
    last_chat_message: 'Building.',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_existing',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'place and start the loop', status: 'active' },
        { id: 'step_2', description: 'verify it stays fueled', status: 'pending' },
      ],
      evidence: [],
    },
  }
}

class TestRcon {
  constructor({ followHealthy = false } = {}) {
    this.followHealthy = followHealthy
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify(this.followHealthy
        ? {
            active: true,
            healthy: true,
            controller_live: true,
            state: 'following',
            target_player: 'tester',
            current_distance: 4,
            desired_distance: 4,
          }
        : { active: false, healthy: false, controller_live: false })
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: 7, task_count: 1, task_types: ['placing'], tick: 1234 },
      })
    }
    return '{}'
  }
}

function decisionResponse(route) {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      route: {
        type: 'choice',
        choice: route,
        probabilities: {
          continue_current: route === 'continue_current' ? 0.9 : 0.03,
          replan: route === 'replan' ? 0.9 : 0.03,
          wait_runtime: route === 'wait_runtime' ? 0.9 : 0.03,
          fallback_planner: route === 'fallback_planner' ? 0.9 : 0.03,
        },
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 80, output_tokens: 8, cost: 0.00000336 },
  }
}

function agentForRoute(route, { followHealthy = false, decisionProvider } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', activePlan())
  const events = []
  const agent = new NpcAgentLoop({
    rcon: new TestRcon({ followHealthy }),
    memory,
    systemPrompt: 'main planner',
    npcId: 'airi',
    provider: async () => { throw new Error('main planner should not run in this focused router test') },
    interactionDecisionProvider: decisionProvider ?? (async () => decisionResponse(route)),
    traceFile: null,
    decisionTraceFile: null,
    stateFile: null,
    onActivity: (event, data) => events.push({ event, data }),
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:airi'
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: '[CHAT] tester: build an early burner coal loop' },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  agent.requestInfo = {
    memoryKey: 'npc:airi',
    turnId: 1,
    sender: 'tester',
    text: 'build an early burner coal loop',
  }
  return { agent, memory, events }
}

test('findSkills remains discovery-only while getSkillDetails creates task-local Skill Context', async () => {
  const { agent } = agentForRoute('fallback_planner')
  const discovery = JSON.stringify({
    ok: true,
    results: [{ id: 'burner-coal-loop', name: 'Burner Coal Loop', summary: 'search metadata only' }],
  })
  assert.equal(agent.recordLoadedSkillToolResult('findSkills', { query: 'coal loop' }, discovery), false)
  assert.equal(agent.skillContext(), '')

  const skill = {
    schema_version: 1,
    revision: 1,
    id: 'burner-coal-loop',
    name: 'Burner Coal Loop',
    kind: 'production',
    stage: 'pattern',
    status: 'candidate',
    summary: 'Bootstrap coal production with starter fuel and a self-feeding miner loop.',
    preconditions: [{ kind: 'bootstrap', subject: 'starter-fuel', description: 'Starter fuel is available.' }],
    topology: { relations: [{ kind: 'direct_item_output', from: 'miner-a', to: 'miner-b', description: 'Feed the next miner.' }] },
    constraints: [{ kind: 'placement', description: 'Verify actual output direction and resource coverage.' }],
    parameters: [{ name: 'miner_count', description: 'Choose from live patch geometry.', required: false, default_value: 2 }],
    verification: { mode: 'deterministic' },
  }
  assert.ok(agent.recordLoadedSkillToolResult('getSkillDetails', { id: 'burner-coal-loop' }, JSON.stringify(skill)))

  let context = agent.skillContext()
  assert.match(context, /^\[SKILL_CONTEXT\]/)
  assert.match(context, /burner-coal-loop/)
  assert.match(context, /Verify actual output direction/)

  agent.messages.push({ role: 'assistant', content: JSON.stringify({ chatMessage: '', plan: ['verify'], currentStep: 0, operations: [] }) })
  agent.prepareContinuationContext()
  context = agent.skillContext()
  assert.match(context, /^\[SKILL_CONTEXT\]/)
  assert.match(context, /burner-coal-loop/)

  await agent.pausePersistentPlan('ui_pause')
  assert.match(agent.skillContext(), /^\[SKILL_CONTEXT\]/)

  agent.cancel('user_stop_immediate')
  assert.match(agent.skillContext(), /^\[SKILL_CONTEXT\]/)

  agent.cancel('ui_terminate')
  assert.equal(agent.skillContext(), '')
})

test('active Jev post-step continue and replan routes map to low/high planner trigger overrides', async () => {
  for (const [route, expectedTrigger] of [['continue_current', 'continue_current'], ['replan', 'post_step_replan']]) {
    const { agent } = agentForRoute(route)
    agent.taskStatusReceipt = async () => ({
      raw: '{}',
      view: { task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
      providerStatus: { observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
    })
    agent.continueFromModMessage = async () => ({ triggerSource: agent.reasoningTriggerSource })
    const result = await agent.completed()
    assert.equal(result.triggerSource, expectedTrigger)
    assert.equal(agent.reasoningTriggerSource, null)
  }
})

test('wait_runtime skips the planner only with authoritative healthy persistent runtime evidence', async () => {
  const healthy = agentForRoute('wait_runtime', { followHealthy: true })
  const healthyRoute = await healthy.agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  assert.equal(healthyRoute.route, 'wait_runtime')
  assert.ok(healthy.events.some(entry => entry.event === 'planner.skipped'))

  const unhealthy = agentForRoute('wait_runtime', { followHealthy: false })
  const unhealthyRoute = await unhealthy.agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  assert.equal(unhealthyRoute.route, 'fallback_planner')
  assert.equal(unhealthyRoute.fallback_reason, 'wait_runtime_without_authoritative_healthy_persistent_runtime')
  assert.ok(unhealthy.events.some(entry => entry.event === 'planner.wake'))
})

test('invalid Jev post-step output fails open to the planner', async () => {
  const { agent, events } = agentForRoute('continue_current', {
    decisionProvider: async () => ({ model: 'jev-latest', provider: 'TypeSafe', answers: {} }),
  })
  const routed = await agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  assert.equal(routed.route, 'fallback_planner')
  assert.match(routed.error, /invalid post-step route/)
  assert.ok(events.some(entry => entry.event === 'planner.wake'))
})

test('cancellation aborts an in-flight Jev post-step decision and cannot wake a stale planner', async () => {
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const { agent, events } = agentForRoute('continue_current', {
    decisionProvider: async (_state, _questions, context) => new Promise((resolve, reject) => {
      startedResolve()
      context.signal.addEventListener('abort', () => reject(new Error('Decision provider request cancelled')), { once: true })
    }),
  })

  const routing = agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  await started
  agent.cancel('test_cancel')
  await assert.rejects(routing, /Model turn was cancelled or superseded/)
  assert.equal(events.some(entry => entry.event === 'planner.wake'), false)
})
