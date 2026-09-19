import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { SwarmProjectJevRuntime } from './swarm-project-jev-runtime.mjs'

function coordinationFixture() {
  return {
    schema: 'swarm_coordination_snapshot_v1',
    tick: 500,
    limit: 12,
    counts: {
      missions: 1,
      incompleteMissions: 1,
      objectives: 1,
      incompleteObjectives: 1,
      projects: 1,
      incompleteProjects: 1,
      work: 1,
      requests: 0,
      claims: 0,
      results: 0,
      agents: 2,
      actors: 2,
      openWork: 1,
      executingWork: 0,
      blockedWork: 0,
      openRequests: 0,
      activeClaims: 0,
      activeWarnings: 0,
    },
    missions: [{ id: 'mission-1', status: 'active', title: 'Bootstrap' }],
    objectives: [{ id: 'objective-1', status: 'active', description: 'Power' }],
    projects: [{ id: 'project-1', status: 'executing', title: 'Steam power' }],
    work: [{ id: 'work-1', status: 'open', title: 'Build boilers' }],
    requests: [],
    warnings: [],
    claims: [],
    results: [],
    agents: [{ id: 'agent-1', state: 'available' }, { id: 'agent-2', state: 'available' }],
    actors: [{ id: 'actor-1', state: 'online' }, { id: 'actor-2', state: 'online' }],
  }
}

async function tempStateFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'swarm-project-jev-runtime-'))
  return {
    dir,
    filename: path.join(dir, 'strategic-project.json'),
  }
}

test('runtime loads one durable global project board and feeds it to project Jev shadow', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const rcon = {
    async command() {
      return JSON.stringify(coordinationFixture())
    },
  }
  let calls = 0
  const runtime = new SwarmProjectJevRuntime({
    rcon,
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    decisionProvider: async (state) => {
      calls += 1
      assert.equal(state.strategic_project_board.goal_id, 'goal-rocket')
      assert.equal(state.strategic_project_board.title, 'Launch a rocket')
      return {
        answers: {
          routing: { choice: 'wake_planner', confidence: 0.7 },
          granularity: { choice: 'split', confidence: 0.8 },
          development: { choice: 'vertical', confidence: 0.9 },
        },
      }
    },
  })

  const initialized = await runtime.initialize()
  assert.equal(initialized.loaded, false)

  const telemetry = await runtime.trigger('mission_updated')
  assert.equal(calls, 1)
  assert.equal(telemetry.scope, 'swarm_global')
  assert.equal(telemetry.authority, 'shadow')
  assert.deepEqual(telemetry.effects, [])
  assert.equal(telemetry.decision.decision.granularity, 'split')
})

test('explicit planner-side board updates persist and survive runtime reconstruction', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const makeRcon = () => ({
    async command() {
      return JSON.stringify(coordinationFixture())
    },
  })

  const first = new SwarmProjectJevRuntime({
    rcon: makeRcon(),
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })
  await first.initialize()
  await first.applyPlannerProposal({
    currentMilestone: { title: 'Automate red science' },
    nextMilestones: [{ title: 'Automate green science' }],
    developmentDirection: 'vertical',
  })
  await first.flush()

  const second = new SwarmProjectJevRuntime({
    rcon: makeRcon(),
    stateFile: filename,
  })
  const loaded = await second.initialize()

  assert.equal(loaded.loaded, true)
  assert.equal(second.currentBoard().goal_id, 'goal-rocket')
  assert.equal(second.currentBoard().current_milestone.title, 'Automate red science')
  assert.equal(second.currentBoard().development_direction, 'vertical')
})

test('Jev telemetry alone cannot mutate the durable strategic project board', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    decisionProvider: async () => ({
      answers: {
        routing: { choice: 'wake_planner', confidence: 1 },
        granularity: { choice: 'split', confidence: 1 },
        development: { choice: 'horizontal', confidence: 1 },
        reasoning_budget: { choice: 'strategic', confidence: 1 },
        planning_horizon: { choice: 'strategic' },
        observation_budget: { score: 8 },
      },
    }),
  })

  await runtime.initialize()
  const before = runtime.currentBoard()
  const telemetry = await runtime.trigger('strategic_review')
  const after = runtime.currentBoard()

  assert.equal(telemetry.decision.decision.granularity, 'split')
  assert.equal(telemetry.decision.decision.development, 'horizontal')
  assert.deepEqual(after, before)
})

test('milestone completion through runtime still requires explicit verified authority', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })

  await runtime.applyPlannerProposal({
    currentMilestone: { title: 'Bootstrap power' },
    nextMilestones: [{ title: 'Automate science' }],
    developmentDirection: 'vertical',
  })

  const rejected = await runtime.completeCurrentMilestone({ verified: true })
  assert.equal(rejected.changed, false)
  assert.equal(rejected.reason, 'outcome_snapshot_not_verdict_authority')
  assert.equal(runtime.currentBoard().current_milestone.title, 'Bootstrap power')

  const accepted = await runtime.completeCurrentMilestone({
    authority: 'verdict_only',
    effects: [],
    strategic_milestone: {
      state: 'completed',
      authoritative: true,
      reason: 'strategic_milestone_verified',
    },
  })
  assert.equal(accepted.changed, true)
  assert.equal(accepted.authorization.authorized, true)
  assert.equal(runtime.currentBoard().transition_state, 'awaiting_next_milestone')
})

test('initialize is coalesced so concurrent callers load durable state once', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })

  let loads = 0
  const originalLoad = runtime.persistence.load.bind(runtime.persistence)
  runtime.persistence.load = async () => {
    loads += 1
    return originalLoad()
  }

  const [a, b, c] = await Promise.all([
    runtime.initialize(),
    runtime.initialize(),
    runtime.initialize(),
  ])

  assert.equal(loads, 1)
  assert.equal(a.board.goal_id, 'goal-rocket')
  assert.equal(b.board.goal_id, 'goal-rocket')
  assert.equal(c.board.goal_id, 'goal-rocket')
})


test('provider-supplied board patches and effects remain inert telemetry', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
    decisionProvider: async () => ({
      board_patch: {
        current_milestone: { title: 'Malicious milestone rewrite' },
      },
      effects: [{
        kind: 'update_board',
        current_milestone: { title: 'Must not execute' },
      }],
      answers: {
        routing: { choice: 'wake_planner', confidence: 1 },
        granularity: { choice: 'split', confidence: 1 },
        development: { choice: 'recover', confidence: 1 },
      },
    }),
  })

  await runtime.initialize()
  const before = runtime.currentBoard()
  const telemetry = await runtime.trigger('authority_audit')
  const after = runtime.currentBoard()

  assert.equal(telemetry.decision.decision.granularity, 'split')
  assert.equal(telemetry.decision.decision.development, 'recover')
  assert.deepEqual(after, before)
  assert.deepEqual(telemetry.effects, [])
})


test('runtime exposes no raw board patch method that can bypass planner admission', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })

  assert.equal(typeof runtime.updateBoard, 'undefined')

  await runtime.applyPlannerProposal({
    currentMilestone: { title: 'Bootstrap power' },
    nextMilestones: [{ title: 'Automate science' }],
    developmentDirection: 'vertical',
  })
  const before = runtime.currentBoard()

  const rejected = await runtime.applyPlannerProposal({
    currentMilestone: { title: 'Skip directly to oil' },
    nextMilestones: [],
    developmentDirection: 'horizontal',
  })

  assert.equal(rejected.accepted, false)
  assert.equal(rejected.changed, false)
  assert.equal(rejected.reason, 'active_milestone_replacement_requires_runtime_transition')
  assert.deepEqual(runtime.currentBoard(), before)
})


test('runtime rejects receipt-only milestone progress even when caller asks to close it', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })

  await runtime.applyPlannerProposal({
    currentMilestone: { title: 'Bootstrap power' },
    nextMilestones: [{ title: 'Automate science' }],
    developmentDirection: 'vertical',
  })

  const result = await runtime.completeCurrentMilestone({
    authority: 'verdict_only',
    effects: [],
    strategic_milestone: {
      state: 'progress',
      authoritative: false,
      reason: 'strategic_milestone_receipt_only',
    },
  })

  assert.equal(result.changed, false)
  assert.equal(result.reason, 'strategic_milestone_not_authoritatively_complete')
  assert.equal(runtime.currentBoard().current_milestone.title, 'Bootstrap power')
})


test('runtime persists an explicit next strategic goal only after prior completion', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const makeRcon = () => ({
    async command() {
      return JSON.stringify(coordinationFixture())
    },
  })

  const first = new SwarmProjectJevRuntime({
    rcon: makeRcon(),
    stateFile: filename,
    goalId: 'goal-red-science',
    objective: 'Automate red science',
  })
  await first.initialize()

  await assert.rejects(
    () => first.startNextGoal({
      goalId: 'goal-green-science',
      objective: 'Automate green science',
    }),
    /requires completed prior goal/,
  )

  await assert.rejects(
    () => first.bindGoal({
      goalId: 'goal-red-science',
      objective: 'Automate red science',
      status: 'completed',
    }),
    /cannot set strategic lifecycle status through bindGoal/,
  )

  await assert.rejects(
    () => first.startNextGoal({
      goalId: 'goal-green-science',
      objective: 'Automate green science',
    }),
    /requires completed prior goal/,
  )

  await first.flush()

  const reconstructed = new SwarmProjectJevRuntime({
    rcon: makeRcon(),
    stateFile: filename,
  })
  const loaded = await reconstructed.initialize()

  assert.equal(loaded.loaded, true)
  assert.equal(reconstructed.currentBoard().goal_id, 'goal-red-science')
  assert.equal(reconstructed.currentBoard().status, 'active')
})


test('bindGoal cannot be abused to mark the strategic project blocked paused or completed', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(coordinationFixture())
      },
    },
    stateFile: filename,
    goalId: 'goal-rocket',
    objective: 'Launch a rocket',
  })

  for (const status of ['blocked', 'paused', 'completed']) {
    await assert.rejects(
      () => runtime.bindGoal({
        goalId: 'goal-rocket',
        objective: 'Launch a rocket',
        status,
      }),
      /cannot set strategic lifecycle status through bindGoal/,
    )
  }

  assert.equal(runtime.currentBoard().status, 'active')
})


function completedCoordinationFixture() {
  const value = coordinationFixture()
  value.tick = 900
  value.counts.incompleteMissions = 0
  value.counts.incompleteObjectives = 0
  value.counts.incompleteProjects = 0
  value.counts.openWork = 0
  value.counts.executingWork = 0
  value.counts.blockedWork = 0
  value.counts.openRequests = 0
  value.counts.activeClaims = 0
  value.counts.activeWarnings = 0
  value.missions = [{ id: 'mission-1', status: 'satisfied', title: 'Bootstrap' }]
  value.objectives = [{ id: 'objective-1', status: 'satisfied', description: 'Power' }]
  value.projects = [{ id: 'project-1', status: 'complete', title: 'Steam power' }]
  value.work = []
  value.requests = []
  value.warnings = []
  value.claims = []
  return value
}

test('whole strategic goal completion requires final milestone and canonical global quiescence', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  let snapshot = coordinationFixture()
  const runtime = new SwarmProjectJevRuntime({
    rcon: {
      async command() {
        return JSON.stringify(snapshot)
      },
    },
    stateFile: filename,
    goalId: 'goal-red-science',
    objective: 'Automate red science',
  })

  await runtime.applyPlannerProposal({
    currentMilestone: { title: 'Build final red science line' },
    nextMilestones: [],
    developmentDirection: 'vertical',
  })

  const early = await runtime.completeProject({
    jevDecision: { milestone_transition: 'project_complete_candidate' },
  })
  assert.equal(early.changed, false)
  assert.equal(early.reason, 'current_milestone_still_active')
  assert.equal(runtime.currentBoard().status, 'active')

  await runtime.completeCurrentMilestone({
    authority: 'verdict_only',
    effects: [],
    strategic_milestone: {
      state: 'completed',
      authoritative: true,
      reason: 'strategic_milestone_verified',
    },
  })

  const stillBusy = await runtime.completeProject({
    jevDecision: { milestone_transition: 'project_complete_candidate' },
  })
  assert.equal(stillBusy.changed, false)
  assert.equal(stillBusy.reason, 'swarm_missions_incomplete')
  assert.equal(runtime.currentBoard().status, 'active')

  snapshot = completedCoordinationFixture()
  const completed = await runtime.completeProject({
    jevDecision: { milestone_transition: 'project_complete_candidate' },
  })

  assert.equal(completed.changed, true)
  assert.equal(completed.reason, 'project_verified_complete')
  assert.equal(completed.authorization.authorized, true)
  assert.equal(completed.authorization.candidate, true)
  assert.equal(completed.coordination_tick, 900)
  assert.equal(runtime.currentBoard().status, 'completed')
})

test('completed strategic goal may then start and persist an explicit next goal', async (t) => {
  const { dir, filename } = await tempStateFile()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const makeRcon = () => ({
    async command() {
      return JSON.stringify(completedCoordinationFixture())
    },
  })

  const first = new SwarmProjectJevRuntime({
    rcon: makeRcon(),
    stateFile: filename,
    goalId: 'goal-red-science',
    objective: 'Automate red science',
  })

  await first.applyPlannerProposal({
    currentMilestone: { title: 'Final red science milestone' },
    nextMilestones: [],
    developmentDirection: 'vertical',
  })
  await first.completeCurrentMilestone({
    authority: 'verdict_only',
    effects: [],
    strategic_milestone: {
      state: 'completed',
      authoritative: true,
      reason: 'strategic_milestone_verified',
    },
  })
  const completed = await first.completeProject()
  assert.equal(completed.changed, true)

  const next = await first.startNextGoal({
    goalId: 'goal-green-science',
    objective: 'Automate green science',
  })
  await first.flush()

  assert.equal(next.goal_id, 'goal-green-science')
  assert.equal(next.status, 'active')

  const reconstructed = new SwarmProjectJevRuntime({
    rcon: makeRcon(),
    stateFile: filename,
  })
  const loaded = await reconstructed.initialize()
  assert.equal(loaded.loaded, true)
  assert.equal(reconstructed.currentBoard().goal_id, 'goal-green-science')
  assert.equal(reconstructed.currentBoard().title, 'Automate green science')
  assert.equal(reconstructed.currentBoard().status, 'active')
})
