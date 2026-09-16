import { skill_candidate_definition_from_block } from '../factory_area_learning'
import {
  assess_skill_reusability,
  classify_verification_cost_risk,
  create_learning_opportunity,
  get_learning_policy,
  list_learning_opportunities,
  list_learning_verification_queue,
  merge_duplicate_skill,
  queue_learning_verification,
  set_learning_policy,
  skill_novelty_key,
  update_learning_opportunity,
  type LearningOpportunitySource,
  type LearningObserverProvenance,
} from '../learning_opportunities'
import {
  create_skill_candidate,
  list_skill_definitions,
  put_skill_definition,
  type SkillDefinition,
} from '../skills'
import { new_swarm_factory_learning_service } from './factory_learning'
import type { ActorId } from './types'

interface SwarmLearningContext {
  goal_id?: string
  evidence_refs?: string[]
  reason?: string
}

function append_unique(values: string[], additions: string[], limit = 64) {
  const result = values.slice(0, limit)
  for (const value of additions) {
    if (!result.includes(value)) result.push(value)
    if (result.length >= limit) break
  }
  return result
}

function duplicate_for_key(noveltyKey: string) {
  for (const skill of list_skill_definitions()) {
    if (skill_novelty_key(skill) === noveltyKey) return skill
  }
  return undefined
}

function unique_candidate_id(candidate: SkillDefinition, noveltyKey: string) {
  const existing = list_skill_definitions()
  let id = candidate.id
  for (const skill of existing) {
    if (skill.id !== id) continue
    if (skill_novelty_key(skill) === noveltyKey) return id
    for (let suffix = 2; suffix <= 32; suffix++) {
      const next = `${candidate.id}-${suffix}`
      if (!existing.some(value => value.id === next)) return next
    }
    throw new Error(`too many semantic variants for candidate id ${candidate.id}`)
  }
  return id
}

function add_observer_provenance(candidate: SkillDefinition, observer: LearningObserverProvenance, context: SwarmLearningContext) {
  const observationRef = observer.observation_id !== undefined ? `swarm-observation:${observer.observation_id}` : undefined
  const evidence = observationRef !== undefined ? [observationRef, ...(context.evidence_refs ?? [])] : (context.evidence_refs ?? [])
  const next: SkillDefinition = {
    ...candidate,
    source: {
      ...candidate.source,
      goal_id: context.goal_id ?? candidate.source.goal_id,
      evidence_refs: append_unique(candidate.source.evidence_refs, evidence),
    },
    confidence: {
      ...candidate.confidence,
      basis: append_unique(candidate.confidence.basis, [
        `Observed by swarm agent ${observer.agent_id} through logical actor ${observer.actor_id} body revision ${observer.body_revision}.`,
      ]),
    },
    examples: [...candidate.examples],
  }
  next.examples.push({
    summary: context.reason ?? `Reusable structure observed by swarm agent ${observer.agent_id}.`,
    notes: `Logical actor ${observer.actor_id}, body revision ${observer.body_revision}${observer.observation_id !== undefined ? `, observation ${observer.observation_id}` : ''}.`,
  })
  if (next.examples.length > 64) next.examples = next.examples.slice(next.examples.length - 64)
  return next
}

export function process_swarm_learning_candidate(
  candidate: SkillDefinition,
  source: LearningOpportunitySource,
  observer: LearningObserverProvenance,
  context: SwarmLearningContext = {},
) {
  candidate = add_observer_provenance(candidate, observer, context)
  candidate.source.kind = source
  const noveltyKey = skill_novelty_key(candidate)
  const qualification = assess_skill_reusability(candidate)
  const classification = classify_verification_cost_risk(candidate)
  const opportunity = create_learning_opportunity({
    source,
    goal_id: context.goal_id,
    analysis_id: candidate.source.evidence_refs.find(value => value.startsWith('factory-analysis:'))?.slice('factory-analysis:'.length),
    source_area: candidate.source.area,
    observer,
    evidence_refs: candidate.source.evidence_refs,
    novelty_key: noveltyKey,
    estimated_cost: classification.estimated_cost,
    risk: classification.risk,
    reason: context.reason ?? qualification.reason,
  })

  if (!qualification.reusable) {
    return {
      opportunity: update_learning_opportunity(opportunity.id, { state: 'rejected', reason: qualification.reason }),
      skill: undefined,
      novelty: 'rejected' as const,
    }
  }

  if (get_learning_policy() === 'manual' && source !== 'manual') {
    return {
      opportunity: update_learning_opportunity(opportunity.id, {
        state: 'rejected',
        reason: 'Learning policy is manual; the opportunity was recorded but automatic candidate creation is disabled.',
      }),
      skill: undefined,
      novelty: 'new' as const,
    }
  }

  const duplicate = duplicate_for_key(noveltyKey)
  if (duplicate !== undefined) {
    const merged = put_skill_definition(merge_duplicate_skill(duplicate, candidate))
    return {
      opportunity: update_learning_opportunity(opportunity.id, {
        state: 'duplicate',
        skill_id: merged.id,
        duplicate_skill_id: merged.id,
        reason: 'Equivalent reusable topology is already shared by the swarm; attached this actor provenance instead of duplicating the skill.',
      }),
      skill: merged,
      novelty: 'known' as const,
    }
  }

  candidate.id = unique_candidate_id(candidate, noveltyKey)
  const stored = create_skill_candidate(candidate)
  update_learning_opportunity(opportunity.id, {
    state: 'candidate_created',
    skill_id: stored.id,
    reason: qualification.reason,
  })
  queue_learning_verification(
    opportunity.id,
    stored.id,
    classification.estimated_cost,
    classification.risk,
    get_learning_policy() === 'autonomous_bounded'
      ? 'A deterministic rebuild/output verifier is still required before promotion; verification is queued, not assumed.'
      : 'Assisted learning queues deterministic rebuild/output verification for a later verifier or explicit approval path.',
  )
  return { opportunity: list_learning_opportunities(1)[0], skill: stored, novelty: 'new' as const }
}

export function process_swarm_factory_block_learning(
  actorId: ActorId,
  analysisId: string,
  blockId: string,
  source: LearningOpportunitySource = 'observed_factory',
  context: SwarmLearningContext = {},
) {
  const status = new_swarm_factory_learning_service().status(analysisId)
  if (!status.found || status.provenance === undefined) return { ok: false as const, code: 'missing_swarm_provenance' as const }
  if (status.provenance.actorId !== actorId) return { ok: false as const, code: 'actor_provenance_mismatch' as const }
  let candidate: SkillDefinition
  try {
    candidate = skill_candidate_definition_from_block(analysisId, blockId)
  }
  catch (error) {
    return { ok: false as const, code: 'invalid_factory_block' as const, error: error instanceof Error ? error.message : 'invalid factory block' }
  }
  const observer: LearningObserverProvenance = {
    agent_id: status.provenance.agentId,
    actor_id: status.provenance.actorId,
    body_revision: status.provenance.bodyRevision,
    observation_id: status.provenance.observationId,
  }
  const result = process_swarm_learning_candidate(candidate, source, observer, context)
  return { ok: true as const, ...result }
}

export function create_swarm_learning_pipeline_remote_interface() {
  remote.add_interface('autorio_swarm_learning_pipeline', {
    status: () => ({
      policy: get_learning_policy(),
      opportunities: list_learning_opportunities(),
      verification_queue: list_learning_verification_queue(),
    }),
    set_policy: (policy: unknown) => {
      try { return [true, set_learning_policy(policy)] }
      catch (error) { return [false, error instanceof Error ? error.message : 'invalid learning policy'] }
    },
    learn_block: (actor_id: ActorId, analysis_id: string, block_id: string) =>
      process_swarm_factory_block_learning(actor_id, analysis_id, block_id, 'manual', {
        evidence_refs: ['manual:swarm-learn-block'],
        reason: 'Player explicitly requested this swarm actor observation be considered as reusable knowledge.',
      }),
  })
}
