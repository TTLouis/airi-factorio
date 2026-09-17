import type { SkillDefinition } from './skills'
import { skill_semantic_signature } from './skill_semantic_evidence'

export type LearningOpportunitySource = 'completed_goal' | 'observed_factory' | 'experiment' | 'manual'
export type LearningOpportunityState = 'detected' | 'analyzing' | 'candidate_created' | 'duplicate' | 'awaiting_verification' | 'verified' | 'rejected' | 'failed'
export type LearningPolicy = 'manual' | 'assisted' | 'autonomous_bounded'
export type LearningCost = 'cheap' | 'moderate' | 'expensive'
export type LearningRisk = 'safe' | 'moderate' | 'dangerous'

export interface LearningSourceArea {
  surface_index: number
  left_top: { x: number, y: number }
  right_bottom: { x: number, y: number }
}

export interface LearningOpportunity {
  id: string
  source: LearningOpportunitySource
  state: LearningOpportunityState
  created_tick: number
  goal_id?: string
  analysis_id?: string
  verification_run_id?: string
  source_area?: LearningSourceArea
  evidence_refs: string[]
  novelty_key: string
  estimated_cost: LearningCost
  risk: LearningRisk
  reason: string
  skill_id?: string
  duplicate_skill_id?: string
}

export interface LearningVerificationQueueItem {
  opportunity_id: string
  skill_id: string
  state: 'queued' | 'blocked'
  created_tick: number
  estimated_cost: LearningCost
  risk: LearningRisk
  reason: string
}

declare const storage: {
  airi_learning_opportunities?: Record<string, LearningOpportunity>
  airi_learning_opportunity_order?: string[]
  airi_learning_next_id?: number
  airi_learning_verification_queue?: LearningVerificationQueueItem[]
  airi_learning_policy?: LearningPolicy
}

export const MAX_LEARNING_OPPORTUNITIES = 32
export const MAX_LEARNING_VERIFICATION_QUEUE = 16
const MAX_EVIDENCE_REFS = 32
const MAX_TEXT = 800

function clean_text(value: unknown, max = MAX_TEXT) {
  let result = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (result.includes('  ')) result = result.split('  ').join(' ')
  return result.length <= max ? result : result.slice(0, max)
}

function unique_strings(values: string[], limit = MAX_EVIDENCE_REFS) {
  const result: string[] = []
  for (const value of values) {
    const next = clean_text(value, 300)
    if (next.length === 0 || result.includes(next)) continue
    result.push(next)
    if (result.length >= limit) break
  }
  return result
}

function records_readonly(): Record<string, LearningOpportunity> {
  return storage.airi_learning_opportunities ?? {}
}

function order_readonly() {
  return storage.airi_learning_opportunity_order ?? []
}

function ensure_records() {
  if (storage.airi_learning_opportunities === undefined) storage.airi_learning_opportunities = {}
  if (storage.airi_learning_opportunity_order === undefined) storage.airi_learning_opportunity_order = []
  return storage.airi_learning_opportunities
}

function ensure_queue() {
  if (storage.airi_learning_verification_queue === undefined) storage.airi_learning_verification_queue = []
  return storage.airi_learning_verification_queue
}

export function get_learning_policy(): LearningPolicy {
  return storage.airi_learning_policy ?? 'assisted'
}

export function set_learning_policy(value: unknown): LearningPolicy {
  if (value !== 'manual' && value !== 'assisted' && value !== 'autonomous_bounded') throw new Error('learning policy must be manual, assisted, or autonomous_bounded')
  storage.airi_learning_policy = value
  return value
}

function next_opportunity_id() {
  const next = storage.airi_learning_next_id ?? 1
  storage.airi_learning_next_id = next + 1
  return `learning-${next}`
}

export function create_learning_opportunity(value: Omit<LearningOpportunity, 'id' | 'created_tick' | 'state'> & { state?: LearningOpportunityState }) {
  const records = ensure_records()
  const order = storage.airi_learning_opportunity_order as string[]
  const id = next_opportunity_id()
  const opportunity: LearningOpportunity = {
    id,
    source: value.source,
    state: value.state ?? 'detected',
    created_tick: game.tick,
    evidence_refs: unique_strings(value.evidence_refs),
    novelty_key: clean_text(value.novelty_key, 24000),
    estimated_cost: value.estimated_cost,
    risk: value.risk,
    reason: clean_text(value.reason),
  }
  if (value.goal_id !== undefined) opportunity.goal_id = clean_text(value.goal_id, 120)
  if (value.analysis_id !== undefined) opportunity.analysis_id = clean_text(value.analysis_id, 120)
  if (value.verification_run_id !== undefined) opportunity.verification_run_id = clean_text(value.verification_run_id, 120)
  if (value.source_area !== undefined) opportunity.source_area = value.source_area
  if (value.skill_id !== undefined) opportunity.skill_id = clean_text(value.skill_id, 120)
  if (value.duplicate_skill_id !== undefined) opportunity.duplicate_skill_id = clean_text(value.duplicate_skill_id, 120)
  records[id] = opportunity
  order.push(id)
  while (order.length > MAX_LEARNING_OPPORTUNITIES) {
    const removed = order.shift()
    if (removed !== undefined) delete records[removed]
  }
  return opportunity
}

export function update_learning_opportunity(id: string, patch: Partial<LearningOpportunity>) {
  const records = ensure_records()
  const current = records[id]
  if (current === undefined) throw new Error(`unknown learning opportunity: ${id}`)
  const next: LearningOpportunity = { ...current, ...patch, id: current.id, created_tick: current.created_tick }
  if (patch.reason !== undefined) next.reason = clean_text(patch.reason)
  if (patch.evidence_refs !== undefined) next.evidence_refs = unique_strings(patch.evidence_refs)
  records[id] = next
  return next
}

export function list_learning_opportunities(limit = MAX_LEARNING_OPPORTUNITIES) {
  const records = records_readonly()
  const order = order_readonly()
  const result: LearningOpportunity[] = []
  for (let index = order.length - 1; index >= 0 && result.length < limit; index--) {
    const opportunity = records[order[index]]
    if (opportunity !== undefined) result.push(opportunity)
  }
  return result
}

export function list_learning_verification_queue() {
  return (storage.airi_learning_verification_queue ?? []).slice()
}

export function queue_learning_verification(opportunity_id: string, skill_id: string, estimated_cost: LearningCost, risk: LearningRisk, reason: string) {
  const queue = ensure_queue()
  for (const existing of queue) {
    if (existing.skill_id === skill_id && existing.state === 'queued') {
      update_learning_opportunity(opportunity_id, { state: 'awaiting_verification', skill_id })
      return existing
    }
  }
  const item: LearningVerificationQueueItem = {
    opportunity_id,
    skill_id,
    state: 'queued',
    created_tick: game.tick,
    estimated_cost,
    risk,
    reason: clean_text(reason),
  }
  queue.push(item)
  while (queue.length > MAX_LEARNING_VERIFICATION_QUEUE) queue.shift()
  update_learning_opportunity(opportunity_id, { state: 'awaiting_verification', skill_id })
  return item
}

function flow_signature(values: SkillDefinition['inputs']) {
  const result = values.map(value => `${value.item}|${value.amount ?? ''}|${value.role ?? ''}`)
  result.sort()
  return result
}

function node_signature(node: SkillDefinition['topology']['nodes'][number]) {
  return `${node.entity_name ?? ''}|${node.recipe ?? ''}|${node.role}`
}

export function skill_novelty_key(skill: SkillDefinition) {
  const node_by_id: Record<string, string> = {}
  const nodes: string[] = []
  for (const node of skill.topology.nodes) {
    const signature = node_signature(node)
    node_by_id[node.id] = signature
    nodes.push(signature)
  }
  nodes.sort()
  const relations = skill.topology.relations.map(relation => {
    const from = relation.from !== undefined ? node_by_id[relation.from] ?? relation.from : ''
    const to = relation.to !== undefined ? node_by_id[relation.to] ?? relation.to : ''
    const via = relation.via !== undefined ? node_by_id[relation.via] ?? relation.via : ''
    return `${relation.kind}|${from}|${to}|${via}|${relation.description ?? ''}`
  })
  relations.sort()
  const recipes = skill.source.recipe_ids.slice()
  recipes.sort()
  const parameters = skill.parameters.map(value => `${value.name}|${value.required ? 'required' : 'optional'}|${value.description}|${value.default_value ?? ''}`)
  parameters.sort()
  return [
    'learning-novelty-v2',
    `kind=${skill.kind}`,
    `inputs=${flow_signature(skill.inputs).join(',')}`,
    `outputs=${flow_signature(skill.outputs).join(',')}`,
    `recipes=${recipes.join(',')}`,
    `nodes=${nodes.join(',')}`,
    `relations=${relations.join(',')}`,
    `semantic=${skill_semantic_signature(skill)}`,
    `parameters=${parameters.join(',')}`,
  ].join(';')
}

export function assess_skill_reusability(skill: SkillDefinition) {
  if (skill.outputs.length === 0) return { reusable: false, reason: 'No reusable output/result was identified.' }
  if (skill.topology.nodes.length < 2) return { reusable: false, reason: 'Single-entity observations are too trivial for automatic skill creation.' }
  if (skill.topology.relations.length === 0) return { reusable: false, reason: 'No reusable topology or procedure relationship was identified.' }
  const reusable_relation = skill.topology.relations.some(relation => relation.kind !== 'adjacent' && relation.kind !== 'custom')
  if (!reusable_relation) return { reusable: false, reason: 'Only weak adjacency/custom relationships were observed.' }
  if (skill.source.evidence_refs.length === 0) return { reusable: false, reason: 'No deterministic evidence reference supports the candidate.' }
  if (skill.topology.nodes.length > 32 || skill.topology.relations.length > 64) return { reusable: false, reason: 'The observed block exceeds the bounded V1 learning scope.' }
  return { reusable: true, reason: 'Multi-entity reusable topology with a clear output and deterministic evidence.' }
}

function contains_any(value: string, needles: string[]) {
  const lowered = value.toLowerCase()
  for (const needle of needles) if (lowered.includes(needle)) return true
  return false
}

export function classify_verification_cost_risk(skill: SkillDefinition): { estimated_cost: LearningCost, risk: LearningRisk } {
  const expensive = skill.topology.nodes.length > 4
    || skill.preconditions.some(condition => condition.kind === 'technology_researched')
    || skill.inputs.length > 6
  let risk: LearningRisk = 'safe'
  for (const constraint of skill.constraints) {
    if (constraint.kind !== 'safety') continue
    if (contains_any(constraint.description, ['destroy', 'demolish', 'combat', 'replace existing', '拆除', '战斗'])) risk = 'dangerous'
    else risk = 'moderate'
  }
  return { estimated_cost: expensive ? 'expensive' : 'moderate', risk }
}

function merge_numbers(left: number[], right: number[], limit = 64) {
  const result = left.slice(0, limit)
  for (const value of right) {
    if (!result.includes(value)) result.push(value)
    if (result.length >= limit) break
  }
  return result
}

export function merge_duplicate_skill(existing: SkillDefinition, incoming: SkillDefinition): SkillDefinition {
  if (skill_novelty_key(existing) !== skill_novelty_key(incoming)) {
    throw new Error('cannot merge skills with different semantic novelty keys')
  }
  const evidence_refs = unique_strings([...existing.source.evidence_refs, ...incoming.source.evidence_refs])
  const recipe_ids = unique_strings([...existing.source.recipe_ids, ...incoming.source.recipe_ids], 64)
  const basis = unique_strings([...existing.confidence.basis, 'Observed an additional equivalent reusable instance.'], 64)
  const examples = existing.examples.slice(0, 63)
  for (const example of incoming.examples) {
    if (examples.length >= 64) break
    const duplicate = examples.some(value => value.summary === example.summary && value.notes === example.notes)
    if (!duplicate) examples.push(example)
  }
  return {
    ...existing,
    revision: existing.revision + 1,
    source: {
      ...existing.source,
      entity_unit_numbers: merge_numbers(existing.source.entity_unit_numbers, incoming.source.entity_unit_numbers),
      recipe_ids,
      evidence_refs,
    },
    confidence: { ...existing.confidence, basis },
    examples,
  }
}
