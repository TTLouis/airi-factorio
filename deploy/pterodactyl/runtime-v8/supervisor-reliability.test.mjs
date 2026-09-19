import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hierarchyTransitionPending,
  liveAgentDebugEvent,
  liveAgentEvent,
  navigationObstaclePolicy,
  pauseStrandedPlanAfterRequestError,
  recoverInterruptedAgentPlan,
  taskBoardUiSnapshot,
} from './supervisor.mjs'

test('natural obstacle clearing defaults on for ordinary new requests', () => {
  assert.deepEqual(navigationObstaclePolicy('去最近的石矿'), {
    shouldUpdate: true,
    clearObstacles: true,
  })
  assert.deepEqual(navigationObstaclePolicy('follow me'), {
    shouldUpdate: true,
    clearObstacles: true,
  })
})

test('explicit requests to preserve trees or rocks disable automatic clearing', () => {
  for (const request of [
    '去石矿，但是不要砍树',
    '跟着我，别挖石头',
    '不要自动清障，绕过去',
    'Follow me but do not clear obstacles',
    "Go there but don't cut trees",
    "Reach the ore but don't mine rocks",
    'Preserve trees while walking there',
  ]) {
    assert.deepEqual(navigationObstaclePolicy(request), {
      shouldUpdate: true,
      clearObstacles: false,
    }, request)
  }
})

test('bare continue preserves the obstacle policy of the durable request', () => {
  for (const request of ['继续', '继续吧', 'resume', 'continue']) {
    assert.equal(navigationObstaclePolicy(request).shouldUpdate, false, request)
  }
})

test('Jev shadow diagnostics survive the following planner request reset and remain separate from planner usage', () => {
  const shadow = {
    intent: 'new_goal',
    intent_confidence: 0.91,
    queue_conflict_probability: 0.17,
    model: 'jev-latest',
    provider: 'TypeSafe',
    usage: { input_tokens: 120, output_tokens: 20, cost: 0.00000504 },
  }

  const routed = liveAgentDebugEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow: shadow,
    decision_shadow_latency_ms: 84,
  })

  assert.equal(routed.decision_provider, 'TypeSafe')
  assert.equal(routed.decision_model, 'jev-latest')
  assert.equal(routed.decision_shadow_intent, 'new_goal')
  assert.equal(routed.decision_active_intent, 'status_query')
  assert.equal(routed.decision_confidence_percent, 91)
  assert.equal(routed.decision_queue_conflict_percent, 17)
  assert.equal(routed.decision_latency_ms, 84)
  assert.equal(routed.decision_input_units, 120)
  assert.equal(routed.decision_output_units, 20)
  assert.equal(routed.decision_cost_micro_usd, 5)

  const next = liveAgentDebugEvent('request.received', {
    sender: 'tester',
    text: 'build something',
  }, routed, {
    provider_model: 'deepseek-chat',
  })

  assert.equal(next.provider_model, 'deepseek-chat')
  assert.equal(next.decision_model, 'jev-latest')
  assert.equal(next.decision_shadow_intent, 'new_goal')
  assert.equal(next.decision_active_intent, 'status_query')

  const activity = liveAgentEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow: shadow,
    decision_shadow_latency_ms: 84,
  })
  assert.equal(activity?.activity?.kind, 'system')
  assert.match(activity?.activity?.text ?? '', /Jev shadow: new_goal/)
  assert.match(activity?.activity?.text ?? '', /active status_query/)
  assert.match(activity?.activity?.text ?? '', /120 in/)
})

test('in-game task board snapshot is a projection of canonical durable state', () => {
  const state = {
    objective: '爬科技树',
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_1',
      status: 'blocked',
      blocker: 'provider_recovery_exhausted',
      pause_reason: '',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [
        { id: 'step_1', description: '找石头', status: 'completed' },
        { id: 'step_2', description: '挖石头', status: 'completed' },
        { id: 'step_3', description: '触发蒸汽动力', status: 'blocked' },
        { id: 'step_4', description: '建立蒸汽电力', status: 'pending' },
        { id: 'step_5', description: '开始实验室研究', status: 'pending' },
      ],
    },
  }
  const snapshot = taskBoardUiSnapshot(state)
  assert.deepEqual(snapshot, {
    goal_id: 'goal_1',
    objective: '爬科技树',
    status: 'blocked',
    blocker: 'provider_recovery_exhausted',
    blocker_summary: 'AIRI could not get a usable model response after retrying.',
    pause_reason: '',
    pause_summary: '',
    completed_count: 2,
    total_steps: 5,
    active_index: 2,
    steps: state.task_board.steps,
    activity: [],
    wanted_items: [],
    conversation_id: '',
    conversation: [],
    agent: { phase: 'idle', detail: '' },
    debug: {
      request_id: '',
      turn: 0,
      provider_model: '',
      provider_round: 0,
      provider_latency_ms: 0,
      provider_diagnostic_code: '',
      provider_finish_reason: '',
      reasoning_effort: '',
      reasoning_policy_reason: '',
      content_chars: 0,
      reasoning_content_chars: 0,
      input_units: 0,
      cached_input_units: 0,
      output_units: 0,
      total_units: 0,
      latest_round_provider_round: 0,
      latest_round_input_units: 0,
      latest_round_cached_input_units: 0,
      latest_round_output_units: 0,
      latest_round_total_units: 0,
      decision_provider: '',
      decision_model: '',
      decision_shadow_intent: '',
      decision_active_intent: '',
      decision_post_step_route: '',
      decision_post_step_applied_route: '',
      decision_post_step_confidence_percent: 0,
      decision_post_step_latency_ms: 0,
      decision_post_step_fallback: '',
      decision_confidence_percent: 0,
      decision_queue_conflict_percent: 0,
      decision_latency_ms: 0,
      decision_input_units: 0,
      decision_output_units: 0,
      decision_cost_micro_usd: 0,
      decision_calls_total: 0,
      decision_input_units_total: 0,
      decision_output_units_total: 0,
      decision_cost_micro_usd_total: 0,
      decision_shadow_matches_total: 0,
      decision_shadow_mismatches_total: 0,
      decision_post_step_calls_total: 0,
      decision_planner_skips_total: 0,
      decision_planner_wakes_total: 0,
      decision_planner_continue_low_wakes_total: 0,
      decision_planner_replan_high_wakes_total: 0,
      decision_planner_fallback_wakes_total: 0,
      decision_error: '',
      step_completion_contract: '',
      step_completion_status: '',
      step_completion_evidence: '',
      runtime_condition: '',
      runtime_condition_state: '',
      last_tool: '',
      last_event: '',
      recovery_attempt: 0,
      last_error: '',
      actor_id: 0,
      actor_epoch: 0,
    },
  })
})


test('structural hierarchy transactions are not auto-paused after an idle request failure', async () => {
  const state = {
    status: 'active',
    hierarchy_split_pending: {
      kind: 'split_current_milestone',
      reason_code: 'hierarchy_split_requested',
    },
  }
  let pauses = 0
  const session = {
    currentPlanState: () => state,
    syncTaskBoardUi: async () => {},
    agent: {
      readInteractionTaskStatus: async () => ({ task_state: 'idle', queue_length: 0 }),
      pausePersistentPlan: async () => {
        pauses++
        return { status: 'paused' }
      },
    },
  }

  assert.equal(hierarchyTransitionPending(state), true)
  assert.equal(await pauseStrandedPlanAfterRequestError(session, 'synthetic planner failure'), undefined)
  assert.equal(pauses, 0)
})

test('interrupted hierarchy split recovery restores its structural trigger and semantic budgets', async () => {
  const state = {
    goal_id: 'goal_long',
    owner: 'tester',
    objective: 'Reach Automation',
    status: 'active',
    hierarchy_split_pending: {
      kind: 'split_project_goal',
      reason_code: 'hierarchy_initial_split',
      reasoning_budget: 'strategic',
      planning_horizon: 'strategic',
      observation_budget: 3,
      requested_at: 1,
    },
  }
  const memory = {
    currentPlan: () => state,
    context: () => '[PLAN_STATE] durable hierarchy split',
  }
  const seen = {}
  const agent = {
    npcId: 'airi',
    memory,
    systemPrompt: 'system',
    turnSequence: 0,
    reasoningBudgetOverride: null,
    observationBudgetOverride: null,
    observationBudgetRemaining: null,
    planningHorizonOverride: null,
    loadPersistentState: async () => {},
    cancel: () => {},
    captureEpoch: async () => ({ actor_id: 3, epoch: 8 }),
    traceEvent: async () => {},
    runGuarded: async function () {
      seen.planUpdateReason = this.planUpdateReason
      seen.reasoningTriggerSource = this.reasoningTriggerSource
      seen.reasoningBudgetOverride = this.reasoningBudgetOverride
      seen.observationBudgetOverride = this.observationBudgetOverride
      seen.observationBudgetRemaining = this.observationBudgetRemaining
      seen.planningHorizonOverride = this.planningHorizonOverride
      seen.message = this.messages.at(-1)?.content
      return { chatMessage: 'recovered hierarchy' }
    },
  }

  const result = await recoverInterruptedAgentPlan(agent, 'runtime_restart')
  assert.equal(result.recovered, true)
  assert.equal(seen.planUpdateReason, 'reanchor_plan')
  assert.equal(seen.reasoningTriggerSource, 'hierarchy_split')
  assert.equal(seen.reasoningBudgetOverride, 'strategic')
  assert.equal(seen.observationBudgetOverride, 3)
  assert.equal(seen.observationBudgetRemaining, 3)
  assert.equal(seen.planningHorizonOverride, 'strategic')
  assert.match(seen.message, /durably pending hierarchy split/i)
  assert.equal(agent.reasoningBudgetOverride, null)
  assert.equal(agent.observationBudgetOverride, null)
  assert.equal(agent.observationBudgetRemaining, null)
  assert.equal(agent.planningHorizonOverride, null)
})
