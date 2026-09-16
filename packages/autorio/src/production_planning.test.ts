import { describe, expect, it } from 'vitest'
import type { ProductionRecipeModel, ProductionSolveRequest, ProductionSolveSuccess } from './production_planning'
import { solve_production } from './production_planning'

function greenCircuitFixture(rate = 10, rename = false): ProductionSolveRequest {
  const copper = rename ? 'raw-a' : 'copper-plate'
  const iron = rename ? 'raw-b' : 'iron-plate'
  const cable = rename ? 'intermediate-x' : 'copper-cable'
  const circuit = rename ? 'product-z' : 'electronic-circuit'
  return {
    calculation_id: rename ? 'renamed-fixture' : `green-${rate}`,
    target: { type: 'item', name: circuit, rate_per_second: rate },
    evidence: [
      { id: 'recipe:cable', source: 'fixture' },
      { id: 'recipe:circuit', source: 'fixture' },
      { id: 'machine:assembler', source: 'fixture' },
    ],
    recipes: [
      {
        recipe_name: rename ? 'make-x' : 'copper-cable',
        energy_seconds: 0.5,
        ingredients: [{ type: 'item', name: copper, amount: 1 }],
        products: [{ type: 'item', name: cable, amount: 2 }],
        machine: { name: 'fixture-assembler', crafting_speed: 0.75, evidence_ids: ['machine:assembler'] },
        evidence_ids: ['recipe:cable'],
      },
      {
        recipe_name: rename ? 'make-z' : 'electronic-circuit',
        energy_seconds: 0.5,
        ingredients: [
          { type: 'item', name: iron, amount: 1 },
          { type: 'item', name: cable, amount: 3 },
        ],
        products: [{ type: 'item', name: circuit, amount: 1 }],
        machine: { name: 'fixture-assembler', crafting_speed: 0.75, evidence_ids: ['machine:assembler'] },
        evidence_ids: ['recipe:circuit'],
      },
    ],
  }
}

function success(request: ProductionSolveRequest) {
  const result = solve_production(request)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result
}

function recipe(result: ProductionSolveSuccess, name: string) {
  const found = result.recipe_rates.find(item => item.recipe_name === name)
  if (!found) throw new Error(`missing recipe result ${name}`)
  return found
}

function external(result: ProductionSolveSuccess, name: string) {
  const found = result.external_inputs.find(item => item.name === name)
  if (!found) throw new Error(`missing external input ${name}`)
  return found
}

describe('deterministic production flow solver', () => {
  it('solves the 10/s green-circuit fixture from supplied recipe data', () => {
    const result = success(greenCircuitFixture(10))
    const cable = recipe(result, 'copper-cable')
    const circuit = recipe(result, 'electronic-circuit')

    expect(circuit.required_output_rate_per_second).toBeCloseTo(10)
    expect(circuit.crafts_per_second).toBeCloseTo(10)
    expect(circuit.ingredient_rates.find(item => item.name === 'copper-cable')?.rate_per_second).toBeCloseTo(30)
    expect(circuit.machine?.machine_count).toBe(7)
    expect(circuit.machine?.nominal_output_rate_per_second).toBeCloseTo(10.5)
    expect(circuit.machine?.utilization).toBeCloseTo(10 / 10.5)

    expect(cable.required_output_rate_per_second).toBeCloseTo(30)
    expect(cable.crafts_per_second).toBeCloseTo(15)
    expect(cable.machine?.machine_count).toBe(10)
    expect(cable.machine?.nominal_output_rate_per_second).toBeCloseTo(30)
    expect(cable.machine?.utilization).toBeCloseTo(1)

    expect(external(result, 'copper-plate').rate_per_second).toBeCloseTo(15)
    expect(external(result, 'iron-plate').rate_per_second).toBeCloseTo(10)
    expect(result.sized_machine_count).toBe(17)
    expect(result.fully_sized).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.evidence_ids_used).toEqual(['machine:assembler', 'recipe:cable', 'recipe:circuit'])
  })

  it('scales the same fixture to 12/s without a memorized cell layout', () => {
    const result = success(greenCircuitFixture(12))
    const cable = recipe(result, 'copper-cable')
    const circuit = recipe(result, 'electronic-circuit')

    expect(circuit.machine?.machine_count).toBe(8)
    expect(cable.required_output_rate_per_second).toBeCloseTo(36)
    expect(cable.crafts_per_second).toBeCloseTo(18)
    expect(cable.machine?.machine_count).toBe(12)
    expect(external(result, 'copper-plate').rate_per_second).toBeCloseTo(18)
    expect(external(result, 'iron-plate').rate_per_second).toBeCloseTo(12)
    expect(result.sized_machine_count).toBe(20)
  })

  it('derives the same material ratios when every fixture name is changed', () => {
    const result = success(greenCircuitFixture(10, true))
    const intermediate = recipe(result, 'make-x')
    const product = recipe(result, 'make-z')

    expect(product.required_output_rate_per_second).toBeCloseTo(10)
    expect(product.ingredient_rates.find(item => item.name === 'intermediate-x')?.rate_per_second).toBeCloseTo(30)
    expect(intermediate.required_output_rate_per_second).toBeCloseTo(30)
    expect(external(result, 'raw-a').rate_per_second).toBeCloseTo(15)
    expect(external(result, 'raw-b').rate_per_second).toBeCloseTo(10)
  })

  it('aggregates a shared intermediate demanded by two branches', () => {
    const recipes: ProductionRecipeModel[] = [
      {
        recipe_name: 'final',
        energy_seconds: 1,
        ingredients: [
          { type: 'item', name: 'branch-a', amount: 1 },
          { type: 'item', name: 'branch-b', amount: 1 },
        ],
        products: [{ type: 'item', name: 'final-product', amount: 1 }],
      },
      {
        recipe_name: 'branch-a',
        energy_seconds: 1,
        ingredients: [{ type: 'item', name: 'shared', amount: 1 }],
        products: [{ type: 'item', name: 'branch-a', amount: 1 }],
      },
      {
        recipe_name: 'branch-b',
        energy_seconds: 1,
        ingredients: [{ type: 'item', name: 'shared', amount: 1 }],
        products: [{ type: 'item', name: 'branch-b', amount: 1 }],
      },
      {
        recipe_name: 'shared',
        energy_seconds: 1,
        ingredients: [{ type: 'item', name: 'raw', amount: 1 }],
        products: [{ type: 'item', name: 'shared', amount: 1 }],
      },
    ]
    const result = success({
      calculation_id: 'shared-aggregation',
      target: { type: 'item', name: 'final-product', rate_per_second: 2 },
      recipes,
    })

    expect(recipe(result, 'shared').required_output_rate_per_second).toBeCloseTo(4)
    expect(recipe(result, 'shared').crafts_per_second).toBeCloseTo(4)
    expect(external(result, 'raw').rate_per_second).toBeCloseTo(4)
  })

  it('keeps material-flow results when machine sizing evidence is absent', () => {
    const fixture = greenCircuitFixture(10)
    for (const item of fixture.recipes) item.machine = undefined
    const result = success(fixture)

    expect(external(result, 'copper-plate').rate_per_second).toBeCloseTo(15)
    expect(external(result, 'iron-plate').rate_per_second).toBeCloseTo(10)
    expect(result.fully_sized).toBe(false)
    expect(result.sized_machine_count).toBe(0)
    expect(result.warnings.map(item => item.recipe_name)).toEqual(['copper-cable', 'electronic-circuit'])
    expect(recipe(result, 'copper-cable').machine).toBeUndefined()
  })

  it('fails closed when more than one supplied recipe can produce the demanded material', () => {
    const result = solve_production({
      calculation_id: 'ambiguous',
      target: { type: 'item', name: 'target', rate_per_second: 1 },
      recipes: [
        { recipe_name: 'route-a', energy_seconds: 1, ingredients: [], products: [{ type: 'item', name: 'target', amount: 1 }] },
        { recipe_name: 'route-b', energy_seconds: 1, ingredients: [], products: [{ type: 'item', name: 'target', amount: 2 }] },
      ],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS_RECIPE', material: { type: 'item', name: 'target' } } })
  })

  it('detects recipe cycles instead of recursing indefinitely', () => {
    const result = solve_production({
      calculation_id: 'cycle',
      target: { type: 'item', name: 'a', rate_per_second: 1 },
      recipes: [
        { recipe_name: 'make-a', energy_seconds: 1, ingredients: [{ type: 'item', name: 'b', amount: 1 }], products: [{ type: 'item', name: 'a', amount: 1 }] },
        { recipe_name: 'make-b', energy_seconds: 1, ingredients: [{ type: 'item', name: 'a', amount: 1 }], products: [{ type: 'item', name: 'b', amount: 1 }] },
      ],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'RECIPE_CYCLE' } })
  })

  it('rejects probabilistic, productivity-sensitive, and multi-product routes in the v1 solver domain', () => {
    for (const recipeModel of [
      {
        recipe_name: 'probabilistic', energy_seconds: 1, probabilistic: true,
        ingredients: [], products: [{ type: 'item' as const, name: 'target', amount: 1 }],
      },
      {
        recipe_name: 'productivity', energy_seconds: 1, productivity_sensitive: true,
        ingredients: [], products: [{ type: 'item' as const, name: 'target', amount: 1 }],
      },
      {
        recipe_name: 'byproduct', energy_seconds: 1,
        ingredients: [], products: [
          { type: 'item' as const, name: 'target', amount: 1 },
          { type: 'item' as const, name: 'other', amount: 1 },
        ],
      },
    ]) {
      const result = solve_production({
        calculation_id: `unsupported-${recipeModel.recipe_name}`,
        target: { type: 'item', name: 'target', rate_per_second: 1 },
        recipes: [recipeModel],
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_PRODUCTION_MODEL', recipe_name: recipeModel.recipe_name } })
    }
  })

  it('validates bounds, numeric inputs, and evidence references before solving', () => {
    const tooMany: ProductionRecipeModel[] = []
    for (let i = 0; i < 129; i++) {
      tooMany.push({
        recipe_name: `recipe-${i}`,
        energy_seconds: 1,
        ingredients: [],
        products: [{ type: 'item', name: `product-${i}`, amount: 1 }],
      })
    }
    expect(solve_production({
      calculation_id: 'too-many',
      target: { type: 'item', name: 'product-0', rate_per_second: 1 },
      recipes: tooMany,
    })).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } })

    expect(solve_production({
      calculation_id: 'bad-energy',
      target: { type: 'item', name: 'target', rate_per_second: 1 },
      recipes: [{ recipe_name: 'bad', energy_seconds: 0, ingredients: [], products: [{ type: 'item', name: 'target', amount: 1 }] }],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    expect(solve_production({
      calculation_id: 'bad-rate',
      target: { type: 'item', name: 'target', rate_per_second: 0 },
      recipes: [],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    expect(solve_production({
      calculation_id: 'missing-evidence',
      target: { type: 'item', name: 'target', rate_per_second: 1 },
      evidence: [],
      recipes: [{
        recipe_name: 'target',
        energy_seconds: 1,
        ingredients: [],
        products: [{ type: 'item', name: 'target', amount: 1 }],
        evidence_ids: ['not-present'],
      }],
    })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })
})
