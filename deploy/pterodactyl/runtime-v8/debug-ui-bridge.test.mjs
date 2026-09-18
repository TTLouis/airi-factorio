import assert from 'node:assert/strict'
import test from 'node:test'

import { liveAgentDebugEvent, taskBoardUiSnapshot } from './supervisor.mjs'

test('live debug bridge retains request, provider, tool, recovery, and actor diagnostics', () => {
  let debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'build power' }, undefined, {
    request_id: 'req-1',
    turn: 1,
    provider_model: 'deepseek-flash',
    actor_id: 18,
    actor_epoch: 3,
  })
  assert.equal(debug.request_id, 'req-1')
  assert.equal(debug.turn, 1)
  assert.equal(debug.provider_model, 'deepseek-flash')
  assert.equal(debug.actor_id, 18)
  assert.equal(debug.actor_epoch, 3)

  debug = liveAgentDebugEvent('provider.request', { round: 4, recovery_attempt: 2 }, debug)
  assert.equal(debug.provider_round, 4)
  assert.equal(debug.recovery_attempt, 2)

  debug = liveAgentDebugEvent('provider.response', {
    round: 4,
    recovery_attempt: 2,
    latency_ms: 10954,
    usage: {
      input_units: 4982,
      cached_input_units: 4568,
      output_units: 700,
      total_units: 5682,
    },
    provider: {
      model: 'deepseek-flash',
      finish_reason: 'length',
      diagnostic_code: 'provider_output_truncated_empty_content',
      reasoning_effort: 'none',
      reasoning_policy_reason: 'strict_recovery',
      content_chars: 0,
      reasoning_content_chars: 8241,
    },
  }, debug, {
    usage: {
      input_units: 13982,
      cached_input_units: 13568,
      output_units: 2000,
      total_units: 15982,
    },
  })
  assert.equal(debug.provider_latency_ms, 10954)
  assert.equal(debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(debug.provider_finish_reason, 'length')
  assert.equal(debug.reasoning_effort, 'none')
  assert.equal(debug.reasoning_policy_reason, 'strict_recovery')
  assert.equal(debug.content_chars, 0)
  assert.equal(debug.reasoning_content_chars, 8241)
  assert.equal(debug.input_units, 13982)
  assert.equal(debug.cached_input_units, 13568)
  assert.equal(debug.output_units, 2000)
  assert.equal(debug.total_units, 15982)
  assert.equal(debug.latest_round_provider_round, 4)
  assert.equal(debug.latest_round_input_units, 4982)
  assert.equal(debug.latest_round_cached_input_units, 4568)
  assert.equal(debug.latest_round_output_units, 700)
  assert.equal(debug.latest_round_total_units, 5682)
  assert.match(debug.last_error, /provider_output_truncated_empty_content/)
  assert.match(debug.last_error, /finish=length/)

  // Starting the next provider round must keep the latest completed round's
  // reasoning policy visible until a newer provider.response replaces it.
  debug = liveAgentDebugEvent('provider.request', { round: 5, recovery_attempt: 0 }, debug)
  assert.equal(debug.reasoning_effort, 'none')
  assert.equal(debug.reasoning_policy_reason, 'strict_recovery')

  // Tool-driven UI refreshes also preserve the same completed-round policy.
  debug = liveAgentDebugEvent('tool.result', { name: 'getActorStatus' }, debug)
  assert.equal(debug.reasoning_effort, 'none')
  assert.equal(debug.reasoning_policy_reason, 'strict_recovery')
  assert.equal(debug.last_tool, 'getActorStatus')
  assert.equal(debug.last_event, 'tool.result')
})

test('Jev economics accumulate across interactions and planner attribution stays explicit', () => {
  let debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow_latency_ms: 80,
    decision_shadow: {
      provider: 'TypeSafe',
      model: 'jev-latest',
      intent: 'status_query',
      intent_confidence: 0.93,
      queue_conflict_probability: 0.02,
      usage: { input_tokens: 120, output_tokens: 10, cost: 0.00000504 },
    },
  })

  debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'amend_current',
    decision_shadow_latency_ms: 95,
    decision_shadow: {
      provider: 'TypeSafe',
      model: 'jev-latest',
      intent: 'new_goal',
      intent_confidence: 0.71,
      queue_conflict_probability: 0.44,
      usage: { input_tokens: 180, output_tokens: 12, cost: 0.00000756 },
    },
  }, debug)

  assert.equal(debug.decision_calls_total, 2)
  assert.equal(debug.decision_input_units_total, 300)
  assert.equal(debug.decision_output_units_total, 22)
  assert.equal(debug.decision_cost_micro_usd_total, 13)
  assert.equal(debug.decision_shadow_matches_total, 1)
  assert.equal(debug.decision_shadow_mismatches_total, 1)
  assert.equal(debug.decision_planner_skips_total, 0)
  assert.equal(debug.decision_planner_wakes_total, 0)

  debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'new task' }, debug, {
    request_id: 'req-jev-next',
  })
  assert.equal(debug.decision_calls_total, 2)
  assert.equal(debug.decision_input_units_total, 300)
  assert.equal(debug.decision_cost_micro_usd_total, 13)

  debug = liveAgentDebugEvent('planner.skipped', { source: 'decision_provider' }, debug)
  debug = liveAgentDebugEvent('planner.wake', { source: 'decision_provider' }, debug)
  assert.equal(debug.decision_planner_skips_total, 1)
  assert.equal(debug.decision_planner_wakes_total, 1)
})

test('request cumulative usage stays separate from the latest completed provider round', () => {
  let debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'multi-round request' }, undefined, {
    request_id: 'req-multi',
    usage: {
      input_units: 0,
      cached_input_units: 0,
      output_units: 0,
      total_units: 0,
    },
  })

  debug = liveAgentDebugEvent('provider.response', {
    round: 0,
    usage: {
      input_units: 100,
      cached_input_units: 80,
      output_units: 10,
      total_units: 110,
    },
    provider: { model: 'test-model', finish_reason: 'tool_calls' },
  }, debug, {
    usage: {
      input_units: 100,
      cached_input_units: 80,
      output_units: 10,
      total_units: 110,
    },
  })
  assert.equal(debug.input_units, 100)
  assert.equal(debug.cached_input_units, 80)
  assert.equal(debug.output_units, 10)
  assert.equal(debug.total_units, 110)
  assert.equal(debug.latest_round_provider_round, 0)
  assert.equal(debug.latest_round_input_units, 100)
  assert.equal(debug.latest_round_cached_input_units, 80)
  assert.equal(debug.latest_round_output_units, 10)
  assert.equal(debug.latest_round_total_units, 110)

  // Starting another provider call keeps the previous completed round visible;
  // it does not fabricate usage for the in-flight round.
  debug = liveAgentDebugEvent('provider.request', { round: 1 }, debug, {
    usage: {
      input_units: 100,
      cached_input_units: 80,
      output_units: 10,
      total_units: 110,
    },
  })
  assert.equal(debug.provider_round, 1)
  assert.equal(debug.latest_round_provider_round, 0)
  assert.equal(debug.latest_round_total_units, 110)

  debug = liveAgentDebugEvent('provider.response', {
    round: 1,
    usage: {
      input_units: 120,
      cached_input_units: 90,
      output_units: 20,
      total_units: 140,
    },
    provider: { model: 'test-model', finish_reason: 'stop' },
  }, debug, {
    usage: {
      input_units: 220,
      cached_input_units: 170,
      output_units: 30,
      total_units: 250,
    },
  })

  // Cached input is already included in input. Neither the per-round nor
  // cumulative total adds cached tokens a second time.
  assert.equal(debug.input_units, 220)
  assert.equal(debug.cached_input_units, 170)
  assert.ok(debug.cached_input_units <= debug.input_units)
  assert.equal(debug.output_units, 30)
  assert.equal(debug.total_units, 250)
  assert.equal(debug.total_units, debug.input_units + debug.output_units)
  assert.equal(debug.latest_round_provider_round, 1)
  assert.equal(debug.latest_round_input_units, 120)
  assert.equal(debug.latest_round_cached_input_units, 90)
  assert.ok(debug.latest_round_cached_input_units <= debug.latest_round_input_units)
  assert.equal(debug.latest_round_output_units, 20)
  assert.equal(debug.latest_round_total_units, 140)
  assert.equal(debug.latest_round_total_units, debug.latest_round_input_units + debug.latest_round_output_units)
})

test('starting a new request resets cumulative and latest-round debug usage', () => {
  const previous = {
    request_id: 'old-request',
    input_units: 220,
    cached_input_units: 170,
    output_units: 30,
    total_units: 250,
    latest_round_provider_round: 1,
    latest_round_input_units: 120,
    latest_round_cached_input_units: 90,
    latest_round_output_units: 20,
    latest_round_total_units: 140,
    reasoning_effort: 'max',
    reasoning_policy_reason: 'repeated_failure',
  }

  const debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'new request' }, previous, {
    request_id: 'new-request',
    usage: {
      input_units: 0,
      cached_input_units: 0,
      output_units: 0,
      total_units: 0,
    },
  })

  assert.equal(debug.request_id, 'new-request')
  assert.equal(debug.input_units, 0)
  assert.equal(debug.cached_input_units, 0)
  assert.equal(debug.output_units, 0)
  assert.equal(debug.total_units, 0)
  assert.equal(debug.latest_round_provider_round, 0)
  assert.equal(debug.latest_round_input_units, 0)
  assert.equal(debug.latest_round_cached_input_units, 0)
  assert.equal(debug.latest_round_output_units, 0)
  assert.equal(debug.latest_round_total_units, 0)
  assert.equal(debug.reasoning_effort, '')
  assert.equal(debug.reasoning_policy_reason, '')
})

test('request failure snapshot wins over transient debug state and remains displayable', () => {
  let debug = liveAgentDebugEvent('request.failed', {
    message: 'Provider response recovery exhausted after 3 attempts: Invalid provider content JSON',
    failure_snapshot: {
      request_id: 'req-final',
      turn: 1,
      actor_id: 27,
      epoch: 84,
      provider: {
        round: 6,
        recovery_attempt: 3,
        latency_ms: 10639,
        provider: {
          model: 'deepseek-flash',
          finish_reason: 'length',
          diagnostic_code: 'provider_output_truncated_empty_content',
          content_chars: 0,
          reasoning_content_chars: 9172,
        },
      },
      recovery: { attempt: 3 },
      last_tool: { phase: 'result', name: 'getEntityGeometry' },
      usage: {
        input_units: 116194,
        cached_input_units: 99328,
        output_units: 10708,
        total_units: 126902,
      },
    },
  }, {
    request_id: 'stale',
    provider_round: 1,
    last_tool: 'oldTool',
  })

  assert.equal(debug.request_id, 'req-final')
  assert.equal(debug.provider_round, 6)
  assert.equal(debug.recovery_attempt, 3)
  assert.equal(debug.provider_model, 'deepseek-flash')
  assert.equal(debug.provider_latency_ms, 10639)
  assert.equal(debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(debug.provider_finish_reason, 'length')
  assert.equal(debug.content_chars, 0)
  assert.equal(debug.reasoning_content_chars, 9172)
  assert.equal(debug.last_tool, 'getEntityGeometry')
  assert.equal(debug.actor_id, 27)
  assert.equal(debug.actor_epoch, 84)
  assert.equal(debug.total_units, 126902)
  assert.match(debug.last_error, /recovery exhausted after 3 attempts/i)

  // Heartbeats/status refreshes must not erase the frozen failure diagnostics.
  debug = liveAgentDebugEvent('factorio.status', { observation_mode: 'unchanged' }, debug)
  assert.equal(debug.request_id, 'req-final')
  assert.equal(debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(debug.provider_finish_reason, 'length')
  assert.equal(debug.reasoning_content_chars, 9172)
  assert.equal(debug.last_error, 'Provider response recovery exhausted after 3 attempts: Invalid provider content JSON')
})

test('task board UI snapshot includes live debug diagnostics', () => {
  const state = {
    goal_id: 'goal-1',
    objective: 'build a burner miner line',
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal-1',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 0,
      total_steps: 1,
      active_index: 0,
      steps: [{ id: 'step-1', description: 'place miner', status: 'active' }],
    },
    last_operations: [],
  }
  const live = {
    phase: 'error',
    detail: 'Request failed',
    activity: [{ kind: 'blocker', text: 'Request failed' }],
    debug: {
      request_id: 'req-1',
      turn: 1,
      provider_model: 'deepseek-flash',
      provider_round: 6,
      provider_latency_ms: 10000,
      provider_diagnostic_code: 'provider_output_truncated_empty_content',
      provider_finish_reason: 'length',
      reasoning_effort: 'max',
      reasoning_policy_reason: 'repeated_failure',
      content_chars: 0,
      reasoning_content_chars: 8123,
      input_units: 100,
      cached_input_units: 80,
      output_units: 20,
      total_units: 120,
      latest_round_provider_round: 5,
      latest_round_input_units: 30,
      latest_round_cached_input_units: 20,
      latest_round_output_units: 5,
      latest_round_total_units: 35,
      last_tool: 'getActorStatus',
      last_event: 'request.failed',
      recovery_attempt: 3,
      last_error: 'Invalid provider content JSON',
      actor_id: 18,
      actor_epoch: 3,
    },
  }

  const snapshot = taskBoardUiSnapshot(state, live)
  assert.equal(snapshot.debug.request_id, 'req-1')
  assert.equal(snapshot.debug.provider_round, 6)
  assert.equal(snapshot.debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(snapshot.debug.provider_finish_reason, 'length')
  assert.equal(snapshot.debug.reasoning_effort, 'max')
  assert.equal(snapshot.debug.reasoning_policy_reason, 'repeated_failure')
  assert.equal(snapshot.debug.content_chars, 0)
  assert.equal(snapshot.debug.reasoning_content_chars, 8123)
  assert.equal(snapshot.debug.input_units, 100)
  assert.equal(snapshot.debug.cached_input_units, 80)
  assert.equal(snapshot.debug.latest_round_provider_round, 5)
  assert.equal(snapshot.debug.latest_round_input_units, 30)
  assert.equal(snapshot.debug.latest_round_cached_input_units, 20)
  assert.equal(snapshot.debug.latest_round_output_units, 5)
  assert.equal(snapshot.debug.latest_round_total_units, 35)
  assert.equal(snapshot.debug.recovery_attempt, 3)
  assert.equal(snapshot.debug.last_event, 'request.failed')
})
