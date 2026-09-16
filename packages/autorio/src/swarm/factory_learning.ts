import type { FactoryAreaLearningRequest } from '../factory_area_learning'
import {
  analyze_factory_area,
  get_factory_area_analysis,
  list_analyzed_blocks,
  skill_candidate_definition_from_block,
} from '../factory_area_learning'
import {
  create_skill_candidate,
  get_skill_definition,
} from '../skills'
import type { SkillDefinition } from '../skills'
import { new_actor_registry } from './actor_registry'
import { post_observation } from './blackboard'
import { new_standalone_actor_pool } from './standalone_actor_pool'
import { get_swarm_storage } from './storage'
import type { ActorId, AgentId, ObservationId, SwarmStorage } from './types'

interface SwarmFactoryAnalysisProvenance {
  analysisId: string
  actorId: ActorId
  agentId: AgentId
  bodyRevision: number
  observationId: ObservationId
  observedTick: number
}

declare const storage: {
  airi_swarm_factory_analysis_provenance?: Record<string, SwarmFactoryAnalysisProvenance>
  airi_swarm_factory_analysis_order?: string[]
}

const MAX_PROVENANCE = 16
const INSPECTION_CAPABILITIES = ['inspect'] as const

type ActorRegistry = ReturnType<typeof new_actor_registry>

function provenance_state() {
  if (storage.airi_swarm_factory_analysis_provenance === undefined) storage.airi_swarm_factory_analysis_provenance = {}
  return storage.airi_swarm_factory_analysis_provenance
}

function provenance_order() {
  if (storage.airi_swarm_factory_analysis_order === undefined) storage.airi_swarm_factory_analysis_order = []
  return storage.airi_swarm_factory_analysis_order
}

function remember_provenance(value: SwarmFactoryAnalysisProvenance) {
  provenance_state()[value.analysisId] = value
  const order = provenance_order()
  order.push(value.analysisId)
  while (order.length > MAX_PROVENANCE) {
    const removed = order.shift()
    if (removed !== undefined) delete provenance_state()[removed]
  }
}

function find_agent_id(swarm: SwarmStorage, actorId: ActorId) {
  for (const agentId in swarm.agents) {
    if (swarm.agents[agentId].actorId === actorId) return agentId
  }
  return undefined
}

function temporary_registry_for(swarm: SwarmStorage, actorId: ActorId) {
  const registry = new_actor_registry(swarm)
  const pool = new_standalone_actor_pool(swarm, registry)
  const registered = pool.register_actor(actorId, [...INSPECTION_CAPABILITIES], game.tick)
  if (!registered.ok) return { ok: false as const, code: registered.code }
  const actor = registry.resolve_actor(actorId, game.tick)
  if (actor === undefined || !actor.is_valid) return { ok: false as const, code: 'no_body' as const }
  const runtime = registry.runtime_snapshot(actorId, game.tick)
  if (runtime === undefined) return { ok: false as const, code: 'unknown_actor' as const }
  const agentId = find_agent_id(swarm, actorId)
  if (agentId === undefined) return { ok: false as const, code: 'agent_not_found' as const }
  return { ok: true as const, registry, actor, runtime, agentId }
}

function contains(values: string[], expected: string) {
  for (const value of values) if (value === expected) return true
  return false
}

export function augment_factory_skill_candidate(
  definition: SkillDefinition,
  provenance: SwarmFactoryAnalysisProvenance,
  existing?: SkillDefinition,
) {
  if (existing?.status === 'verified') return { ok: false as const, code: 'existing_verified_skill' as const }
  const next: SkillDefinition = {
    ...definition,
    revision: existing !== undefined && existing.revision >= definition.revision ? existing.revision + 1 : definition.revision,
    source: {
      ...definition.source,
      evidence_refs: [...definition.source.evidence_refs],
    },
    confidence: {
      ...definition.confidence,
      basis: [...definition.confidence.basis],
    },
    examples: [...definition.examples],
  }
  const observationRef = `swarm-observation:${provenance.observationId}`
  if (!contains(next.source.evidence_refs, observationRef) && next.source.evidence_refs.length < 64) next.source.evidence_refs.push(observationRef)
  next.confidence.basis.push(`Observed by swarm agent ${provenance.agentId} through logical actor ${provenance.actorId} body revision ${provenance.bodyRevision}.`)
  next.examples.push({
    summary: `Swarm observation ${provenance.observationId} by ${provenance.agentId}.`,
    notes: `Logical actor ${provenance.actorId}, body revision ${provenance.bodyRevision}, tick ${provenance.observedTick}.`,
  })
  return { ok: true as const, definition: next }
}

export function new_swarm_factory_learning_service() {
  function analyze(actorId: ActorId, request: FactoryAreaLearningRequest = {}) {
    // Factorio save/load and deterministic test reset paths may replace the
    // persistent swarm root while the remote interface remains alive. Always
    // resolve the authoritative current root instead of retaining a stale table.
    const swarm = get_swarm_storage()
    if (swarm.actors[actorId] === undefined) return { ok: false as const, code: 'unknown_actor' as const }
    const resolved = temporary_registry_for(swarm, actorId)
    if (!resolved.ok) return resolved
    const result = analyze_factory_area(resolved.actor, request)
    if (!result.ok) return result

    const width = result.area.right_bottom.x - result.area.left_top.x
    const height = result.area.right_bottom.y - result.area.left_top.y
    const observation = post_observation(swarm, {
      observer: resolved.agentId,
      subject: `factory area analysis ${result.analysis_id}`,
      location: {
        surfaceIndex: result.surface_index,
        position: {
          x: (result.area.left_top.x + result.area.right_bottom.x) / 2,
          y: (result.area.left_top.y + result.area.right_bottom.y) / 2,
        },
        radius: math.max(width, height) / 2,
      },
      evidenceClass: 'measured',
      data: {
        analysis_id: result.analysis_id,
        actor_id: actorId,
        body_revision: resolved.runtime.bodyRevision,
        entity_count: result.entity_count,
        relation_count: result.relation_count,
        block_count: result.blocks.length,
      },
      observedTick: game.tick,
    })
    const provenance: SwarmFactoryAnalysisProvenance = {
      analysisId: result.analysis_id,
      actorId,
      agentId: resolved.agentId,
      bodyRevision: resolved.runtime.bodyRevision,
      observationId: observation.id,
      observedTick: game.tick,
    }
    remember_provenance(provenance)
    return {
      ...result,
      observer: {
        agent_id: resolved.agentId,
        actor_id: actorId,
        body_revision: resolved.runtime.bodyRevision,
        observation_id: observation.id,
      },
    }
  }

  function status(analysisId: string) {
    const analysis = get_factory_area_analysis(analysisId)
    if (analysis === undefined) return { found: false as const, analysis_id: analysisId }
    return {
      found: true as const,
      analysis,
      provenance: provenance_state()[analysisId],
    }
  }

  function blocks(analysisId?: string) {
    return list_analyzed_blocks(analysisId)
  }

  function create_candidate_from_block(analysisId: string, blockId: string) {
    const provenance = provenance_state()[analysisId]
    if (provenance === undefined) return { ok: false as const, code: 'missing_swarm_provenance' as const }
    let definition: SkillDefinition
    try {
      definition = skill_candidate_definition_from_block(analysisId, blockId)
    }
    catch (error) {
      return { ok: false as const, code: 'invalid_factory_block' as const, error: error instanceof Error ? error.message : 'invalid factory block' }
    }
    const augmented = augment_factory_skill_candidate(definition, provenance, get_skill_definition(definition.id))
    if (!augmented.ok) return augmented
    const skill = create_skill_candidate(augmented.definition)
    return {
      ok: true as const,
      skill_id: skill.id,
      revision: skill.revision,
      observer: provenance,
    }
  }

  return {
    analyze,
    status,
    blocks,
    create_candidate_from_block,
  }
}

export function create_swarm_factory_learning_remote_interface() {
  const service = new_swarm_factory_learning_service()
  remote.add_interface('autorio_swarm_learning', {
    analyze_area: (actor_id: ActorId, request: FactoryAreaLearningRequest = {}) => service.analyze(actor_id, request),
    status: (analysis_id: string) => service.status(analysis_id),
    list_blocks: (analysis_id?: string) => service.blocks(analysis_id),
    create_candidate_from_block: (analysis_id: string, block_id: string) => service.create_candidate_from_block(analysis_id, block_id),
  })
}
