import { SwarmProjectJevShadowController } from './swarm-project-jev-shadow.mjs'
import { SwarmProjectJevShadowService } from './swarm-project-jev-service.mjs'
import { SwarmStrategicProjectPersistence } from './swarm-strategic-project-persistence.mjs'
import { SwarmStrategicProjectStore } from './swarm-strategic-project-store.mjs'
import { applyStrategicPlannerProposal } from './swarm-strategic-planner-contract.mjs'
import { authorizeStrategicMilestoneCompletion } from './swarm-strategic-transition-gate.mjs'
import { readSwarmCoordinationSnapshot } from './swarm-coordination-snapshot.mjs'
import { authorizeStrategicProjectCompletion } from './swarm-strategic-project-completion-gate.mjs'
import { SwarmProjectJevMonitor } from './swarm-project-jev-monitor.mjs'
import { runSwarmJevMilestoneTransitionDecision } from './swarm-jev-shadow-controller.mjs'

export class SwarmProjectJevRuntime {
  constructor({
    rcon,
    decisionProvider,
    stateFile,
    snapshotLimit = 12,
    goalId = '',
    objective = '',
    now = () => Date.now(),
  } = {}) {
    if (typeof stateFile !== 'string' || stateFile.length === 0) {
      throw new TypeError('Project Jev runtime requires stateFile')
    }

    this.rcon = rcon
    this.decisionProvider = typeof decisionProvider === 'function' ? decisionProvider : undefined
    this.snapshotLimit = snapshotLimit
    this.store = new SwarmStrategicProjectStore({
      goalId,
      objective,
      now,
    })
    this.persistence = new SwarmStrategicProjectPersistence({
      filename: stateFile,
      store: this.store,
    })
    this.controller = new SwarmProjectJevShadowController({
      rcon,
      decisionProvider,
      snapshotLimit,
      now,
    })
    this.service = new SwarmProjectJevShadowService({
      controller: this.controller,
      strategicBoard: () => this.store.current(),
    })
    this.monitor = new SwarmProjectJevMonitor({
      rcon,
      service: this.service,
      strategicBoard: () => this.store.current(),
      snapshotLimit,
    })
    this.initialized = false
    this.initializePromise = null
  }

  initialize() {
    if (this.initialized) {
      return Promise.resolve({
        loaded: true,
        board: this.store.current(),
        already_initialized: true,
      })
    }
    if (this.initializePromise) return this.initializePromise

    const promise = this.persistence.load()
      .then((result) => {
        this.initialized = true
        return {
          ...result,
          already_initialized: false,
        }
      })
      .finally(() => {
        if (this.initializePromise === promise) this.initializePromise = null
      })

    this.initializePromise = promise
    return promise
  }

  async bindGoal(goal = {}) {
    await this.initialize()
    if (goal?.status !== undefined && goal.status !== 'active') {
      throw new Error('Project Jev runtime cannot set strategic lifecycle status through bindGoal')
    }
    const board = this.store.bindGoal({
      ...goal,
      status: 'active',
    })
    await this.persistence.save()
    this.monitor.resetBaseline()
    return board
  }

  async startNextGoal(goal) {
    await this.initialize()
    const board = this.store.startNextGoal(goal)
    await this.persistence.save()
    this.monitor.resetBaseline()
    return board
  }

  async terminateProject() {
    await this.initialize()
    const result = this.store.terminateGoal()
    if (result.changed) {
      await this.persistence.save()
      this.monitor.resetBaseline()
    }
    return result
  }

  async applyPlannerProposal(proposal) {
    await this.initialize()
    const result = applyStrategicPlannerProposal(this.store, proposal)
    if (result.changed) await this.persistence.save()
    return result
  }

  async completeCurrentMilestone(outcomeSnapshot) {
    await this.initialize()
    const authorization = authorizeStrategicMilestoneCompletion(outcomeSnapshot)
    if (!authorization.authorized) {
      return {
        changed: false,
        reason: authorization.reason,
        board: this.store.current(),
        authorization,
      }
    }

    const result = this.store.completeCurrentMilestone({ verified: true })
    if (result.changed) {
      await this.persistence.save()
      this.monitor.resetBaseline()
    }
    return {
      ...result,
      authorization,
    }
  }

  async activateNextMilestone() {
    await this.initialize()
    const result = this.store.activateNextMilestone()
    if (result.changed) await this.persistence.save()
    return result
  }

  async transitionCompletedMilestone(outcomeSnapshot, {
    providerOptions = {},
  } = {}) {
    const completed = await this.completeCurrentMilestone(outcomeSnapshot)
    if (!completed.changed) {
      return {
        changed: false,
        reason: completed.reason,
        completion: completed,
        board: this.store.current(),
      }
    }

    const coordinationSnapshot = await readSwarmCoordinationSnapshot(this.rcon, {
      limit: this.snapshotLimit,
    })
    const transitionDecision = await runSwarmJevMilestoneTransitionDecision({
      decisionProvider: this.decisionProvider,
      strategicBoard: this.store.current(),
      coordinationSnapshot,
      providerOptions,
    })

    let transition
    if (transitionDecision.decision === 'advance_next') {
      transition = this.store.activateNextMilestone()
      if (!transition.changed) {
        const board = this.store.update({
          transition_state: 'awaiting_project_replan',
        })
        transition = {
          changed: true,
          reason: transition.reason || 'next_milestone_unavailable',
          board,
        }
      }
    }
    else if (transitionDecision.decision === 'project_complete_candidate') {
      transition = {
        changed: true,
        reason: 'project_completion_requires_planner_review',
        board: this.store.update({
          transition_state: 'awaiting_project_review',
        }),
      }
    }
    else {
      transition = {
        changed: true,
        reason: 'verified_milestone_requires_project_replan',
        board: this.store.update({
          transition_state: 'awaiting_project_replan',
        }),
      }
    }

    await this.persistence.save()
    this.monitor.resetBaseline()
    return {
      changed: true,
      reason: transition.reason,
      completion: completed,
      transition,
      transitionDecision,
      board: this.store.current(),
      coordination_tick: coordinationSnapshot.tick,
    }
  }

  async completeProject({ jevDecision } = {}) {
    await this.initialize()
    const coordinationSnapshot = await readSwarmCoordinationSnapshot(this.rcon, {
      limit: this.snapshotLimit,
    })
    const authorization = authorizeStrategicProjectCompletion({
      board: this.store.current(),
      coordinationSnapshot,
      jevDecision,
    })
    if (!authorization.authorized) {
      return {
        changed: false,
        reason: authorization.reason,
        board: this.store.current(),
        authorization,
        coordination_tick: coordinationSnapshot.tick,
      }
    }

    const result = this.store.completeGoal({ verified: true })
    if (result.changed) await this.persistence.save()
    return {
      ...result,
      authorization,
      coordination_tick: coordinationSnapshot.tick,
    }
  }

  async poll() {
    await this.initialize()
    return this.monitor.poll()
  }

  async trigger(reason) {
    await this.initialize()
    return this.service.trigger(reason)
  }

  resetMonitorBaseline() {
    this.monitor.resetBaseline()
  }

  currentBoard() {
    return this.store.current()
  }

  lastTelemetry() {
    return this.service.last()
  }

  busy() {
    return this.service.busy()
  }

  async flush() {
    await this.persistence.flush()
  }
}
