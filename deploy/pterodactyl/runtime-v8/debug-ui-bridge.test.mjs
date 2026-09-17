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
    provider: {
      model: 'deepseek-flash',
      finish_reason: 'length',
      diagnostic_code: 'provider_output_truncated_empty_content',
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
  assert.equal(debug.content_chars, 0)
  assert.equal(debug.reasoning_content_chars, 8241)
  assert.equal(debug.input_units, 13982)
  assert.equal(debug.cached_input_units, 13568)
  assert.equal(debug.output_units, 2000)
  assert.equal(debug.total_units, 15982)
  assert.match(debug.last_error, /provider_output_truncated_empty_content/)
  assert.match(debug.last_error, /finish=length/)

  debug = liveAgentDebugEvent('tool.result', { name: 'getActorStatus' }, debug)
  assert.equal(debug.last_tool, 'getActorStatus')
  assert.equal(debug.last_event, 'tool.result')
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
      content_chars: 0,
      reasoning_content_chars: 8123,
      input_units: 100,
      cached_input_units: 80,
      output_units: 20,
      total_units: 120,
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
  assert.equal(snapshot.debug.content_chars, 0)
  assert.equal(snapshot.debug.reasoning_content_chars, 8123)
  assert.equal(snapshot.debug.recovery_attempt, 3)
  assert.equal(snapshot.debug.last_event, 'request.failed')
})
