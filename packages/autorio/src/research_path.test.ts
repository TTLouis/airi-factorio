import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { plan_research_path } from './research_path'

function technology(name: string, options: {
  researched?: boolean
  enabled?: boolean
  prerequisites?: Record<string, any>
  ingredients?: Array<{ name: string, amount: number }>
} = {}) {
  return {
    name,
    level: 1,
    researched: options.researched ?? false,
    enabled: options.enabled ?? true,
    prerequisites: options.prerequisites ?? {},
    prototype: { max_level: 1 },
    research_unit_count: 10,
    research_unit_energy: 30,
    research_unit_ingredients: options.ingredients ?? [{ name: 'automation-science-pack', amount: 1 }],
  }
}

function fixture({ steamResearched = false, automationEnabled = true, researchEnabled = true } = {}) {
  const steam = technology('steam-power', { researched: steamResearched, ingredients: [] })
  const automation = technology('automation', {
    enabled: automationEnabled,
    prerequisites: { 'steam-power': steam },
  })
  const actor = {
    is_valid: true,
    character: { valid: true },
    force: {
      index: 1,
      research_enabled: researchEnabled,
      technologies: {
        'steam-power': steam,
        automation,
      },
    },
  } as unknown as ControlledActor
  return { actor, steam, automation }
}

beforeEach(() => {
  ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value)
  ;(globalThis as any).prototypes.technology = {
    'steam-power': {
      research_trigger: {
        type: 'craft-item',
        item: 'iron-plate',
        count: 50,
      },
    },
    automation: {},
  }
})

describe('deterministic research path planning', () => {
  it('returns prerequisites in dependency-first order with exact trigger and science requirements', () => {
    const { actor } = fixture()
    const result: any = plan_research_path(actor, 'automation')

    expect(result).toMatchObject({
      ok: true,
      target: 'automation',
      target_researched: false,
      node_count: 2,
      pending_count: 2,
      blocked: false,
    })
    expect(result.pending_path.map((node: any) => node.name)).toEqual(['steam-power', 'automation'])
    expect(result.pending_path[0]).toMatchObject({
      name: 'steam-power',
      mode: 'trigger',
      status: 'ready',
      research_trigger: {
        type: 'craft-item',
        item: 'iron-plate',
        count: 50,
      },
      required_action: 'perform_research_trigger_then_verify',
    })
    expect(result.pending_path[1]).toMatchObject({
      name: 'automation',
      mode: 'science',
      status: 'blocked_by_prerequisites',
      unresolved_prerequisites: ['steam-power'],
      science: {
        count: 10,
        energy: 30,
        ingredients: [{ name: 'automation-science-pack', amount: 1 }],
      },
      required_action: 'research_technology_then_verify',
    })
    expect(result.next_actionable.name).toBe('steam-power')
  })

  it('omits already researched prerequisites from pending_path and exposes the next science technology', () => {
    const { actor } = fixture({ steamResearched: true })
    const result: any = plan_research_path(actor, 'automation')

    expect(result.nodes.map((node: any) => node.name)).toEqual(['steam-power', 'automation'])
    expect(result.nodes[0].status).toBe('already_researched')
    expect(result.pending_path.map((node: any) => node.name)).toEqual(['automation'])
    expect(result.next_actionable).toMatchObject({ name: 'automation', status: 'ready', mode: 'science' })
  })

  it('reports disabled research as a deterministic blocker instead of suggesting blind waits', () => {
    const { actor } = fixture({ steamResearched: true, automationEnabled: false })
    const result: any = plan_research_path(actor, 'automation')

    expect(result).toMatchObject({ ok: true, blocked: true })
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0]).toMatchObject({ name: 'automation', status: 'disabled' })
    expect(result.next_actionable).toBeUndefined()
  })

  it('fails closed instead of returning an incomplete path when max_nodes is too small', () => {
    const { actor } = fixture()
    expect(plan_research_path(actor, 'automation', 1)).toMatchObject({
      ok: false,
      target: 'automation',
      error: { code: 'PATH_TOO_LARGE' },
    })
  })
})