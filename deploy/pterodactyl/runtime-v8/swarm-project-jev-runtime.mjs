import { SwarmProjectJevShadowController } from './swarm-project-jev-shadow.mjs'
import { SwarmProjectJevShadowService } from './swarm-project-jev-service.mjs'
import { SwarmStrategicProjectPersistence } from './swarm-strategic-project-persistence.mjs'
import { SwarmStrategicProjectStore } from './swarm-strategic-project-store.mjs'
import { applyStrategicPlannerProposal } from './swarm-strategic-planner-contract.mjs'
import { authorizeStrategicMilestoneCompletion } from './swarm-strategic-transition-gate.mjs'

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
    return board
  }

  async startNextGoal(goal) {
    await this.initialize()
    const board = this.store.startNextGoal(goal)
    await this.persistence.save()
    return board
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
    if (result.changed) await this.persistence.save()
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

  async trigger(reason) {
    await this.initialize()
    return this.service.trigger(reason)
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
