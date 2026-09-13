import type { LuaForce } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersResearchTechnology } from './types'
import { TaskStates } from './types'

const MAX_RESEARCH_QUEUE = 10
const MAX_TECHNOLOGY_RECORDS = 20

type ResearchCode = 'started' | 'already_queued' | 'already_researched'
  | 'invalid_name' | 'no_actor' | 'unknown_technology' | 'technology_disabled'
  | 'research_disabled' | 'missing_prerequisites' | 'trigger_research'
  | 'force_busy' | 'engine_rejected' | 'actor_changed'

interface ResearchResult {
  accepted: boolean
  code: ResearchCode
  technology: string
  tick: number
  force_index?: number
  actor_id?: number
  actor_kind?: string
}

declare const storage: {
  airi_last_research_result?: ResearchResult
}

function valid_name(name: string) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    return false
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 32 || code === 127) {
      return false
    }
  }
  return true
}

function already_queued(force: LuaForce, name: string) {
  return force.current_research?.name === name
    || (force.research_queue ?? []).some(tech => tech.name === name)
}

/** Admission is checked again when the serialized NPC task actually executes. */
export function research_error(actor: ControlledActor | undefined, name: string): ResearchCode | undefined {
  if (!valid_name(name)) {
    return 'invalid_name'
  }
  if (!actor || !actor.is_valid || !actor.character || !actor.force.valid) {
    return 'no_actor'
  }
  const force = actor.force
  const tech = force.technologies[name]
  if (!tech) {
    return 'unknown_technology'
  }
  if (tech.researched) {
    return undefined // Idempotent no-op; never adds or unlocks anything.
  }
  if (!force.research_enabled) {
    return 'research_disabled'
  }
  if (!tech.enabled) {
    return 'technology_disabled'
  }
  if (tech.prototype.research_trigger) {
    return 'trigger_research' // Gameplay triggers must not be bypassed by a script.
  }
  if (already_queued(force, name)) {
    return undefined
  }
  for (const [, prerequisite] of pairs(tech.prerequisites)) {
    if (!prerequisite.researched) {
      return 'missing_prerequisites'
    }
  }
  // Conservative shared-force policy: never replace or append to someone
  // else's active queue. This works regardless of the engine's queue setting.
  if (force.current_research || (force.research_queue ?? []).length > 0) {
    return 'force_busy'
  }
  return undefined
}

function record_result(actor: ControlledActor | undefined, name: string, accepted: boolean, code: ResearchCode): ResearchResult {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: ResearchResult = {
    accepted,
    code,
    technology: valid_name(name) ? name : '<invalid>',
    tick: game.tick,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
  }
  storage.airi_last_research_result = result
  return result
}

export function execute_research_request(actor: ControlledActor, task: PlayerParametersResearchTechnology): ResearchResult {
  const identity = actor.status_snapshot()
  if (task.owner_actor_id === undefined || task.owner_force_index === undefined
    || identity.actor_id !== task.owner_actor_id || identity.kind !== task.owner_actor_kind
    || actor.force.index !== task.owner_force_index) {
    return record_result(actor, task.technology_name, false, 'actor_changed')
  }
  const error = research_error(actor, task.technology_name)
  if (error) {
    return record_result(actor, task.technology_name, false, error)
  }
  const force = actor.force
  const tech = force.technologies[task.technology_name]
  if (tech.researched) {
    return record_result(actor, task.technology_name, true, 'already_researched')
  }
  if (already_queued(force, tech.name)) {
    return record_result(actor, task.technology_name, true, 'already_queued')
  }
  const accepted = force.add_research(tech)
  return record_result(actor, task.technology_name, accepted, accepted ? 'started' : 'engine_rejected')
}

export function new_research_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function submit(name: string): [boolean, string] {
    const actor = get_actor()
    const error = research_error(actor, name)
    if (error || !actor) {
      const result = record_result(actor, name, false, error ?? 'no_actor')
      log(`[AUTORIO] [ERROR] Research request rejected: ${result.technology}: ${result.code}`)
      return [false, result.code]
    }
    const identity = actor.status_snapshot()
    if (identity.actor_id === undefined) {
      record_result(actor, name, false, 'no_actor')
      return [false, 'no_actor']
    }
    manager.add_task({
      type: TaskStates.RESEARCHING,
      technology_name: name,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    })
    return [true, 'Research request queued; verify technology completion separately']
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_research_technology
    if (!task || manager.player_state.task_state !== TaskStates.RESEARCHING) {
      return
    }
    const result = execute_research_request(actor, task)
    if (!result.accepted) {
      // Dependent work must not proceed on a rejected prerequisite. Do not
      // emit the normal success notification after clearing this batch.
      manager.cancel_all_tasks()
      log(`[AUTORIO] [ERROR] Research request rejected: ${result.technology}: ${result.code}; queued operations cancelled`)
      return
    }
    log(`[AUTORIO] Research request accepted: ${result.technology}: ${result.code}; verify completion separately`)
    // Research is force-wide background work. Keeping the NPC blocked here
    // would prevent subsequent operations from supplying science to its labs.
    manager.reset_task_state()
    manager.next_task()
  }

  function status() {
    const actor = get_actor()
    if (!actor || !actor.is_valid) {
      return { error: 'no_actor' }
    }
    const force = actor.force
    const queue = force.research_queue ?? []
    const current = force.current_research
    const result = storage.airi_last_research_result
    return {
      force: force.name,
      force_index: force.index,
      research_enabled: force.research_enabled,
      current: current ? { name: current.name, level: current.level } : undefined,
      progress: current ? force.research_progress : undefined,
      queue: queue.slice(0, MAX_RESEARCH_QUEUE).map(tech => ({ name: tech.name, level: tech.level })),
      queue_length: queue.length,
      queue_truncated: queue.length > MAX_RESEARCH_QUEUE,
      // This records submission, NOT the current success of a research goal.
      last_request_result: result?.force_index === force.index ? result : undefined,
    }
  }

  function technology(name: string) {
    const actor = get_actor()
    if (!actor || !actor.is_valid) {
      return { found: false, error: 'no_actor' }
    }
    if (!valid_name(name)) {
      return { found: false, error: 'invalid_name' }
    }
    const tech = actor.force.technologies[name]
    if (!tech) {
      return { found: false, error: 'unknown_technology' }
    }
    const prerequisites: Array<{ name: string, researched: boolean }> = []
    let prerequisite_count = 0
    for (const [prerequisite_name, prerequisite] of pairs(tech.prerequisites)) {
      prerequisite_count += 1
      if (prerequisites.length < MAX_TECHNOLOGY_RECORDS) {
        prerequisites.push({ name: prerequisite_name, researched: prerequisite.researched })
      }
    }
    const trigger = tech.prototype.research_trigger
    const ingredients = trigger ? [] : tech.research_unit_ingredients
    return {
      found: true,
      name: tech.name,
      level: tech.level,
      researched: tech.researched,
      enabled: tech.enabled,
      request_error: research_error(actor, name),
      trigger_type: trigger?.type,
      research_unit_count: trigger ? undefined : tech.research_unit_count,
      research_unit_energy: trigger ? undefined : tech.research_unit_energy,
      ingredients: ingredients.slice(0, MAX_TECHNOLOGY_RECORDS).map(item => ({ name: item.name, amount: item.amount })),
      ingredients_truncated: ingredients.length > MAX_TECHNOLOGY_RECORDS,
      prerequisites,
      prerequisites_truncated: prerequisite_count > MAX_TECHNOLOGY_RECORDS,
    }
  }

  return { submit, tick, status, technology }
}
