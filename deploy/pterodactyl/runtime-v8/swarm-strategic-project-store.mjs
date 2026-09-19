import {
  activateNextStrategicMilestone,
  completeCurrentStrategicMilestone,
  sanitizeStrategicProjectBoard,
  updateStrategicProjectBoard,
} from './strategic-project-board.mjs'

const STORE_SCHEMA = 1

function clean(value, max = 160) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export class SwarmStrategicProjectStore {
  constructor({
    goalId = '',
    objective = '',
    status = 'active',
    now = () => Date.now(),
  } = {}) {
    this.now = now
    this.goalId = clean(goalId, 100)
    this.objective = clean(objective, 500)
    this.status = status
    this.board = undefined
  }

  ensure() {
    this.board = sanitizeStrategicProjectBoard(this.board, {
      goalId: this.goalId,
      objective: this.objective,
      status: this.status,
      now: this.now(),
    })
    return structuredClone(this.board)
  }

  current() {
    return this.board ? structuredClone(this.board) : this.ensure()
  }

  bindGoal({
    goalId,
    objective,
    status = 'active',
  } = {}) {
    const nextGoalId = clean(goalId, 100)
    const nextObjective = clean(objective, 500)
    if (this.board && this.board.goal_id && nextGoalId && this.board.goal_id !== nextGoalId) {
      throw new Error('Strategic project store cannot silently replace active goal identity')
    }
    if (nextGoalId) this.goalId = nextGoalId
    if (nextObjective) this.objective = nextObjective
    this.status = status
    return this.ensure()
  }

  update(patch = {}) {
    const current = this.ensure()
    this.board = updateStrategicProjectBoard(current, patch, {
      goalId: this.goalId,
      objective: this.objective,
      status: this.status,
      now: this.now(),
    })
    return structuredClone(this.board)
  }

  completeCurrentMilestone({ verified = false } = {}) {
    const transition = completeCurrentStrategicMilestone(this.ensure(), {
      verified,
      goalId: this.goalId,
      objective: this.objective,
      status: this.status,
      now: this.now(),
    })
    this.board = transition.board
    return {
      ...transition,
      board: structuredClone(transition.board),
    }
  }

  activateNextMilestone() {
    const transition = activateNextStrategicMilestone(this.ensure(), {
      goalId: this.goalId,
      objective: this.objective,
      status: this.status,
      now: this.now(),
    })
    this.board = transition.board
    return {
      ...transition,
      board: structuredClone(transition.board),
    }
  }

  snapshot() {
    return {
      schema: STORE_SCHEMA,
      kind: 'swarm_strategic_project_store',
      board: this.current(),
    }
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('Invalid strategic project store snapshot')
    }
    if (snapshot.schema !== STORE_SCHEMA || snapshot.kind !== 'swarm_strategic_project_store') {
      throw new Error('Unsupported strategic project store snapshot')
    }
    if (!snapshot.board || typeof snapshot.board !== 'object' || Array.isArray(snapshot.board)) {
      throw new Error('Invalid strategic project store board')
    }

    const restored = sanitizeStrategicProjectBoard(snapshot.board, {
      goalId: clean(snapshot.board.goal_id, 100),
      objective: clean(snapshot.board.title, 500),
      status: snapshot.board.status,
      now: this.now(),
    })
    this.goalId = restored.goal_id
    this.objective = restored.title
    this.status = restored.status
    this.board = restored
    return structuredClone(this.board)
  }
}
