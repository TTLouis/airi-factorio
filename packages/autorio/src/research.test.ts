import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_research_controller } from './research'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).pairs = (value: object) => Object.entries(value)
})

function world() {
  const tech = {
    name: 'automation', enabled: true, researched: false, level: 1,
    prerequisites: {} as Record<string, any>, prototype: {} as Record<string, any>,
    research_unit_count: 10, research_unit_energy: 600,
    research_unit_ingredients: [{ name: 'automation-science-pack', amount: 1 }],
  }
  const force = {
    name: 'player', index: 1, valid: true, research_enabled: true,
    technologies: { automation: tech } as Record<string, typeof tech>,
    current_research: undefined as typeof tech | undefined,
    research_queue: [] as typeof tech[], research_progress: 0,
    add_research: vi.fn((value: typeof tech) => {
      force.current_research = value
      force.research_queue = [value]
      return true
    }),
  }
  const identity = { kind: 'standalone_character', actor_id: 42 }
  const actor = {
    is_valid: true, character: {}, force,
    status_snapshot: () => identity,
  } as unknown as ControlledActor
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_research_controller(get_actor, manager)
  return { actor, force, tech, identity, manager, controller, get_actor }
}

describe('serialized asynchronous research requests', () => {
  it('defers force mutation until the request reaches the head of the NPC queue', () => {
    const { actor, force, manager, controller } = world()
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    expect(controller.submit('automation')[0]).toBe(true)
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot().queue_length).toBe(1)
    manager.reset_task_state()
    manager.next_task()
    controller.tick(actor)
    expect(force.add_research).toHaveBeenCalledTimes(1)
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('allows queued physical work while native research is still incomplete', () => {
    const { actor, tech, manager, controller } = world()
    controller.submit('automation')
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    controller.tick(actor)
    expect(tech.researched).toBe(false)
    expect(manager.player_state.task_state).toBe(TaskStates.WAITING)
    expect(controller.status()).toMatchObject({
      current: { name: 'automation' },
      last_request_result: { accepted: true, code: 'started' },
    })
    expect(controller.technology('automation')).toMatchObject({ researched: false })
  })

  it('cancels a pending request without starting native research', () => {
    const { actor, force, manager, controller } = world()
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.submit('automation')
    manager.cancel_all_tasks()
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(force.current_research).toBeUndefined()
  })

  it('does not cancel shared force research after submission', () => {
    const { actor, force, manager, controller } = world()
    controller.submit('automation')
    controller.tick(actor)
    manager.cancel_all_tasks()
    expect(force.current_research?.name).toBe('automation')
  })

  it('records engine rejection and cancels dependent work without success notification', () => {
    const { actor, force, manager, controller } = world()
    force.add_research.mockReturnValue(false)
    controller.submit('automation')
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_request_result: { accepted: false, code: 'engine_rejected' } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
    expect((globalThis as any).game.print).not.toHaveBeenCalled()
    expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'))
  })

  it('rechecks disabled research at execution rather than trusting admission', () => {
    const { actor, tech, force, controller } = world()
    controller.submit('automation')
    tech.enabled = false
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'technology_disabled', accepted: false } })
  })

  it.each(['actor', 'kind', 'force'] as const)('rejects a changed %s instead of executing for another owner', (change) => {
    const { actor, force, identity, controller } = world()
    controller.submit('automation')
    if (change === 'actor') identity.actor_id = 99
    if (change === 'kind') identity.kind = 'connected_player'
    if (change === 'force') force.index = 2
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'actor_changed', accepted: false } })
  })

  it('does not duplicate active or already-researched technology', () => {
    const { actor, tech, force, controller } = world()
    force.current_research = tech
    force.research_queue = [tech]
    controller.submit('automation')
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'already_queued' } })
    tech.researched = true
    force.current_research = undefined
    force.research_queue = []
    controller.submit('automation')
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'already_researched' } })
  })

  it('preserves a conflicting force research queue', () => {
    const { force, tech, controller } = world()
    const other = { ...tech, name: 'logistics' }
    force.current_research = other
    force.research_queue = [other]
    expect(controller.submit('automation')).toEqual([false, 'force_busy'])
    expect(force.research_queue).toEqual([other])
    expect(force.add_research).not.toHaveBeenCalled()
  })

  it('rechecks conflicting research that starts while the NPC request is waiting', () => {
    const { actor, force, tech, controller } = world()
    controller.submit('automation')
    force.current_research = { ...tech, name: 'logistics' }
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(force.current_research.name).toBe('logistics')
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'force_busy' } })
  })

  it('rejects missing prerequisites, gameplay-trigger research, and disabled force research', () => {
    const { force, tech, controller } = world()
    tech.prerequisites = { electronics: { researched: false } }
    expect(controller.submit('automation')).toEqual([false, 'missing_prerequisites'])
    tech.prerequisites = {}
    tech.prototype.research_trigger = { type: 'craft-item' }
    expect(controller.submit('automation')).toEqual([false, 'trigger_research'])
    tech.prototype = {}
    force.research_enabled = false
    expect(controller.submit('automation')).toEqual([false, 'research_disabled'])
    expect(force.add_research).not.toHaveBeenCalled()
  })

  it('rejects unknown, malformed, and unowned requests', () => {
    const { controller, get_actor } = world()
    expect(controller.submit('unknown')).toEqual([false, 'unknown_technology'])
    expect(controller.submit('automation\n[ERROR] injected')).toEqual([false, 'invalid_name'])
    expect(controller.submit('x'.repeat(201))).toEqual([false, 'invalid_name'])
    get_actor.mockReturnValue(undefined)
    expect(controller.submit('automation')).toEqual([false, 'no_actor'])
    expect(controller.status()).toEqual({ error: 'no_actor' })
  })

  it('bounds observations and does not mutate research while reading', () => {
    const { force, tech, controller } = world()
    force.research_queue = Array.from({ length: 15 }, (_, i) => ({ ...tech, name: `tech-${i}` }))
    tech.prerequisites = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`prereq-${i}`, { researched: false }]))
    tech.research_unit_ingredients = Array.from({ length: 25 }, (_, i) => ({ name: `pack-${i}`, amount: 1 }))
    const status = controller.status()
    expect(status).toMatchObject({ queue_length: 15, queue_truncated: true })
    expect('queue' in status && status.queue).toHaveLength(10)
    const info = controller.technology('automation')
    expect(info).toMatchObject({ prerequisites_truncated: true, ingredients_truncated: true })
    expect('prerequisites' in info && info.prerequisites).toHaveLength(20)
    expect('ingredients' in info && info.ingredients).toHaveLength(20)
    expect(force.add_research).not.toHaveBeenCalled()
  })
})
