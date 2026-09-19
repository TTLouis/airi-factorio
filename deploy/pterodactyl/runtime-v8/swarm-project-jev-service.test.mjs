import test from 'node:test'
import assert from 'node:assert/strict'

import { SwarmProjectJevShadowService } from './swarm-project-jev-service.mjs'

test('triggers arriving during an in-flight project Jev cycle schedule one latest-state follow-up', async () => {
  let observeCalls = 0
  let releaseFirst
  let markFirstStarted
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve })
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve })

  const controller = {
    async observe(options) {
      observeCalls += 1
      assert.equal(options.strategicBoard.goal_id, 'goal-1')
      if (observeCalls === 1) {
        markFirstStarted()
        await firstBlocked
      }
      return {
        authority: 'shadow',
        effects: [],
        scope: 'swarm_global',
        source_tick: 100 + observeCalls,
      }
    },
  }

  const service = new SwarmProjectJevShadowService({
    controller,
    strategicBoard: () => ({ goal_id: 'goal-1' }),
  })

  const first = service.trigger('mission_updated')
  await firstStarted

  const second = service.trigger('work_completed')
  const third = service.trigger('ui_refresh')

  assert.equal(service.busy(), true)
  assert.strictEqual(first, second)
  assert.strictEqual(second, third)
  assert.equal(observeCalls, 1)

  releaseFirst()
  const result = await first

  assert.equal(observeCalls, 2)
  assert.equal(result.trigger_sequence, 2)
  assert.deepEqual(result.trigger_reasons, ['work_completed', 'ui_refresh'])
  assert.equal(result.trigger_reason, 'work_completed,ui_refresh')
  assert.equal(result.source_tick, 102)
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


test('shadow service contains snapshot/controller failures and remains reusable', async () => {
  let shouldFail = true
  const service = new SwarmProjectJevShadowService({
    controller: {
      async observe() {
        if (shouldFail) throw new Error('global snapshot unavailable\ntransient detail')
        return {
          authority: 'shadow',
          effects: [],
          scope: 'swarm_global',
          source_tick: 400,
        }
      },
    },
  })

  const failed = await service.trigger('periodic_check')
  assert.equal(failed.status, 'observation_error')
  assert.equal(failed.authority, 'shadow')
  assert.deepEqual(failed.effects, [])
  assert.equal(failed.error, 'global snapshot unavailable transient detail')
  assert.equal(service.busy(), false)

  shouldFail = false
  const recovered = await service.trigger('retry_after_snapshot_error')
  assert.equal(recovered.source_tick, 400)
  assert.equal(recovered.authority, 'shadow')
  assert.equal(recovered.trigger_sequence, 2)
})
