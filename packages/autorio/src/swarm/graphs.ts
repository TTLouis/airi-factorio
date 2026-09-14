import type { SwarmStorage } from './types'

export type DependencyGraphKind = 'work' | 'objective'

export interface DependencyGraphIssue {
  graph: DependencyGraphKind
  code: 'missing_dependency' | 'self_dependency' | 'duplicate_dependency' | 'cycle' | 'cross_mission_dependency'
  recordId: string
  dependencyId?: string
  cycle?: string[]
}

interface GraphNode {
  id: string
  dependencies: string[]
  missionId?: string
}

function sorted_ids(nodes: Record<string, GraphNode>) {
  const ids: string[] = []
  for (const id in nodes) ids.push(id)
  ids.sort()
  return ids
}

function inspect_graph(kind: DependencyGraphKind, nodes: Record<string, GraphNode>, enforceSameMission: boolean) {
  const issues: DependencyGraphIssue[] = []
  const ids = sorted_ids(nodes)

  for (const id of ids) {
    const node = nodes[id]
    const seen: Record<string, boolean> = {}
    const dependencies = [...node.dependencies]
    dependencies.sort()
    for (const dependencyId of dependencies) {
      if (seen[dependencyId]) {
        issues.push({ graph: kind, code: 'duplicate_dependency', recordId: id, dependencyId })
        continue
      }
      seen[dependencyId] = true
      if (dependencyId === id) {
        issues.push({ graph: kind, code: 'self_dependency', recordId: id, dependencyId })
        continue
      }
      const dependency = nodes[dependencyId]
      if (!dependency) {
        issues.push({ graph: kind, code: 'missing_dependency', recordId: id, dependencyId })
        continue
      }
      if (enforceSameMission && node.missionId !== dependency.missionId) {
        issues.push({ graph: kind, code: 'cross_mission_dependency', recordId: id, dependencyId })
      }
    }
  }

  const state: Record<string, number> = {}
  const stack: string[] = []
  const reportedCycles: Record<string, boolean> = {}

  function visit(id: string) {
    state[id] = 1
    stack.push(id)
    const node = nodes[id]
    const dependencies = [...node.dependencies]
    dependencies.sort()
    for (const dependencyId of dependencies) {
      if (!nodes[dependencyId] || dependencyId === id) continue
      if (!state[dependencyId]) {
        visit(dependencyId)
        continue
      }
      if (state[dependencyId] !== 1) continue

      let start = 0
      for (let i = 0; i < stack.length; i++) {
        if (stack[i] === dependencyId) {
          start = i
          break
        }
      }
      const cycle: string[] = []
      for (let i = start; i < stack.length; i++) cycle.push(stack[i])
      cycle.push(dependencyId)
      const key = cycle.join('>')
      if (!reportedCycles[key]) {
        reportedCycles[key] = true
        issues.push({ graph: kind, code: 'cycle', recordId: id, dependencyId, cycle })
      }
    }
    stack.pop()
    state[id] = 2
  }

  for (const id of ids) if (!state[id]) visit(id)
  return issues
}

export function validate_work_dependency_graph(swarm: SwarmStorage) {
  const nodes: Record<string, GraphNode> = {}
  for (const id in swarm.board.work) {
    const work = swarm.board.work[id]
    nodes[id] = { id, dependencies: work.dependencies, missionId: work.missionId }
  }
  return inspect_graph('work', nodes, false)
}

export function validate_objective_dependency_graph(swarm: SwarmStorage) {
  const nodes: Record<string, GraphNode> = {}
  for (const id in swarm.objectives) {
    const objective = swarm.objectives[id]
    nodes[id] = { id, dependencies: objective.dependencies, missionId: objective.missionId }
  }
  return inspect_graph('objective', nodes, true)
}
