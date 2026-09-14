import { create_work } from './blackboard'
import { activate_objective, admit_mission, create_mission, create_objective } from './missions'
import type { AgentId, SimulationTick, SwarmStorage, WorldLocation } from './types'

export interface CooperativeCraftMissionInput {
  title: string
  priority: number
  resourceName: string
  rawItemName: string
  rawItemCount: number
  resourceSource: WorldLocation
  handoffEntityName: string
  handoffLocation: WorldLocation
  outputItemName: string
  outputCount: number
  createdBy: 'human' | AgentId
  tick: SimulationTick
}

export type CooperativeCraftMissionResult
  = {
      ok: true
      missionId: string
      objectiveId: string
      workIds: string[]
      gatherWorkId: string
      deliveryWorkId: string
      acquireWorkId: string
      craftWorkId: string
    }
    | {
      ok: false
      code: 'invalid_title' | 'invalid_priority' | 'invalid_count' | 'invalid_name' | 'surface_mismatch'
    }

function valid_priority(value: number) {
  return typeof value === 'number' && value === value && value >= 0 && value <= 100
}

function valid_count(value: number) {
  return typeof value === 'number' && value === Math.floor(value) && value > 0 && value <= 1000
}

function valid_name(value: string) {
  return typeof value === 'string' && value !== ''
}

/**
 * Compile a cooperative production chain without asking a planner to invent
 * dependencies: gather raw resource -> stage it -> another actor picks it up ->
 * native craft. Every step remains ordinary claimable Work with evidence.
 */
export function create_cooperative_craft_mission_workflow(
  swarm: SwarmStorage,
  input: CooperativeCraftMissionInput,
): CooperativeCraftMissionResult {
  if (!valid_name(input.title)) return { ok: false, code: 'invalid_title' }
  if (!valid_priority(input.priority)) return { ok: false, code: 'invalid_priority' }
  if (!valid_count(input.rawItemCount) || !valid_count(input.outputCount)) return { ok: false, code: 'invalid_count' }
  if (!valid_name(input.resourceName) || !valid_name(input.rawItemName) || !valid_name(input.handoffEntityName) || !valid_name(input.outputItemName)) {
    return { ok: false, code: 'invalid_name' }
  }
  if (input.resourceSource.surfaceIndex !== input.handoffLocation.surfaceIndex) return { ok: false, code: 'surface_mismatch' }

  const mission = create_mission(swarm, {
    title: input.title,
    priority: input.priority,
    goal: `Produce ${input.outputCount} ${input.outputItemName} through a shared material handoff`,
    createdBy: input.createdBy,
    tick: input.tick,
  })
  const admitted = admit_mission(swarm, mission.id, mission.revision, input.tick)
  if (!admitted.ok) throw new Error(`Could not admit newly created mission ${mission.id}: ${admitted.code}`)

  const createdObjective = create_objective(swarm, {
    missionId: mission.id,
    description: `Produce ${input.outputItemName} through cooperative resource and logistics work`,
    priority: input.priority,
    acceptance: [{
      id: 'cooperative-production-output',
      kind: 'inventory_count',
      description: `At least ${input.outputCount} ${input.outputItemName} produced with engine evidence`,
      itemName: input.outputItemName,
      threshold: input.outputCount,
      location: input.handoffLocation,
    }],
  })
  if (!createdObjective.ok) throw new Error(`Could not create production objective for ${mission.id}: ${createdObjective.code}`)
  const activated = activate_objective(swarm, createdObjective.objective.id, createdObjective.objective.revision)
  if (!activated.ok) throw new Error(`Could not activate production objective ${createdObjective.objective.id}: ${activated.code}`)
  const objectiveId = activated.objective.id

  const gather = create_work(swarm, {
    missionId: mission.id,
    objectiveId,
    createdBy: 'mission-tracker',
    goal: {
      kind: 'gather_resource',
      resourceName: input.resourceName,
      itemName: input.rawItemName,
      count: input.rawItemCount,
      source: input.resourceSource,
    },
    requirements: { capabilities: ['move', 'mine'] },
    location: input.resourceSource,
    priority: input.priority,
    createdTick: input.tick,
  })

  const delivery = create_work(swarm, {
    missionId: mission.id,
    objectiveId,
    createdBy: 'mission-tracker',
    goal: {
      kind: 'deliver_items',
      itemName: input.rawItemName,
      count: input.rawItemCount,
      destination: input.handoffLocation,
      destinationEntityName: input.handoffEntityName,
    },
    requirements: { capabilities: ['move', 'transfer'] },
    location: input.handoffLocation,
    priority: input.priority,
    dependencies: [gather.id],
    createdTick: input.tick,
  })

  const acquire = create_work(swarm, {
    missionId: mission.id,
    objectiveId,
    createdBy: 'mission-tracker',
    goal: {
      kind: 'acquire_items',
      itemName: input.rawItemName,
      count: input.rawItemCount,
      source: input.handoffLocation,
      sourceEntityName: input.handoffEntityName,
    },
    requirements: { capabilities: ['move', 'transfer'] },
    location: input.handoffLocation,
    priority: input.priority,
    dependencies: [delivery.id],
    createdTick: input.tick,
  })

  const craft = create_work(swarm, {
    missionId: mission.id,
    objectiveId,
    createdBy: 'mission-tracker',
    goal: {
      kind: 'craft_items',
      itemName: input.outputItemName,
      count: input.outputCount,
    },
    requirements: { capabilities: ['craft'] },
    location: input.handoffLocation,
    priority: input.priority,
    dependencies: [acquire.id],
    createdTick: input.tick,
  })

  return {
    ok: true,
    missionId: mission.id,
    objectiveId,
    workIds: [gather.id, delivery.id, acquire.id, craft.id],
    gatherWorkId: gather.id,
    deliveryWorkId: delivery.id,
    acquireWorkId: acquire.id,
    craftWorkId: craft.id,
  }
}
