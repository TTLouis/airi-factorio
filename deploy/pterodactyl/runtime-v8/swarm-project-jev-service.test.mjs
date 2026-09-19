import test from 'node:test'
import assert from 'node:assert/strict'

import { SwarmProjectJevShadowService } from './swarm-project-jev-service.mjs'

test('concurrent project-level triggers coalesce into one global Jev observation', async () => {
  let observeCalls = 0
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const controller = {
    async observe(options) {
      observeCalls += 1
      assert.equal(options.strategicBoard.goal_id, 'goal-1')
      await blocked
      return {
        authority: 'shadow',
        effects: [],
        scope: 'swarm_global',
        source_tick: 100,
        decision: {
          authority: 'shadow',
          effects: [],
          decision: { routing: 'continue_runtime' },
        },
      }
    },
  }

  const service = new SwarmProjectJevShadowService({
    controller,
    strategicBoard: () => ({ goal_id: 'goal-1' }),
  })

  const first = service.trigger('mission_updated')
  const second = service.trigger('work_completed')
  const third = service.trigger('ui_refresh')

  assert.equal(service.busy(), true)
  assert.strictEqual(first, second)
  assert.strictEqual(second, third)
  assert.equal(observeCalls, 1)

  release()
  const result = await first
  assert.equal(result.trigger_sequence, 1)
  assert.equal(result.trigger_reason, 'mission_updated')
  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.equal(service.busy(), false)
})

test('a later trigger starts a new global cycle after the previous one finishes', async () => {
  let observeCalls = 0
  const controller = {
    async observe() {
      observeCalls += 1
      return {
        authority: 'shadow',
        effects: [],
        scope: 'swarm_global',
        source_tick: 100 + observeCalls,
      }
    },
  }
  const service = new SwarmProjectJevShadowService({ controller })

  const first = await service.trigger('first')
  const second = await service.trigger('second')

  assert.equal(observeCalls, 2)
  assert.equal(first.trigger_sequence, 1)
  assert.equal(second.trigger_sequence, 2)
  assert.equal(first.source_tick, 101)
  assert.equal(second.source_tick, 102)
})

test('global service resolves strategic and recovery state at trigger time', async () => {
  let revision = 1
  let recoveryPending = false
  const seen = []
  const controller = {
    async observe(options) {
      seen.push(structuredClone(options))
      return {
        authority: 'shadow',
        effects: [],
        scope: 'swarm_global',
        source_tick: revision,
      }
    },
  }
  const service = new SwarmProjectJevShadowService({
    controller,
    strategicBoard: () => ({ goal_id: 'goal-1', revision }),
    recovery: () => ({ deterministic_recovery_pending: recoveryPending }),
  })

  await service.trigger('first')
  revision = 2
  recoveryPending = true
  await service.trigger('second')

  assert.equal(seen[0].strategicBoard.revision, 1)
  assert.equal(seen[0].recovery.deterministic_recovery_pending, false)
  assert.equal(seen[1].strategicBoard.revision, 2)
  assert.equal(seen[1].recovery.deterministic_recovery_pending, true)
})

test('service never adds execution authority to controller telemetry', async () => {
  const controller = {
    async observe() {
      return {
        authority: 'shadow',
        effects: [],
        scope: 'swarm_global',
        decision: {
          authority: 'shadow',
          effects: [],
          decision: {
            granularity: 'split',
            development: 'vertical',
            routing: 'wake_planner',
          },
        },
      }
    },
  }
  const service = new SwarmProjectJevShadowService({ controller })
  const result = await service.trigger('milestone_boundary')

  assert.equal(result.authority, 'shadow')
  assert.deepEqual(result.effects, [])
  assert.equal(result.decision.decision.granularity, 'split')
})

test('last telemetry is defensive-copied', async () => {
  const service = new SwarmProjectJevShadowService({
    controller: {
      async observe() {
        return {
          authority: 'shadow',
          effects: [],
          scope: 'swarm_global',
          source_counts: { missions: 1 },
        }
      },
    },
  })

  await service.trigger('snapshot')
  const first = service.last()
  first.source_counts.missions = 999
  assert.equal(service.last().source_counts.missions, 1)
})
