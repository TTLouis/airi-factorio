export type ProductionMaterialType = 'item' | 'fluid'
export type ProductionEvidenceSource = 'engine_read' | 'fixture' | 'measurement' | 'calculation' | 'estimate'

export interface ProductionEvidenceRef {
  id: string
  source: ProductionEvidenceSource
}

export interface ProductionMaterialAmount {
  type: ProductionMaterialType
  name: string
  amount: number
}

export interface ProductionMachineSelection {
  name: string
  crafting_speed: number
  evidence_ids?: string[]
}

export interface ProductionRecipeModel {
  recipe_name: string
  energy_seconds: number
  ingredients: ProductionMaterialAmount[]
  products: ProductionMaterialAmount[]
  machine?: ProductionMachineSelection
  evidence_ids?: string[]
  probabilistic?: boolean
  productivity_sensitive?: boolean
}

export interface ProductionTarget {
  type: ProductionMaterialType
  name: string
  rate_per_second: number
}

export interface ProductionSolveRequest {
  calculation_id: string
  target: ProductionTarget
  recipes: ProductionRecipeModel[]
  evidence?: ProductionEvidenceRef[]
}

export type ProductionSolveErrorCode
  = | 'INVALID_REQUEST'
    | 'LIMIT_EXCEEDED'
    | 'AMBIGUOUS_RECIPE'
    | 'UNSUPPORTED_PRODUCTION_MODEL'
    | 'RECIPE_CYCLE'

export interface ProductionSolveFailure {
  ok: false
  calculation_id?: string
  error: {
    code: ProductionSolveErrorCode
    message: string
    material?: { type: ProductionMaterialType, name: string }
    recipe_name?: string
  }
}

export interface ProductionIngredientRate {
  type: ProductionMaterialType
  name: string
  rate_per_second: number
}

export interface ProductionRecipeRate {
  recipe_name: string
  product: ProductionMaterialAmount
  required_output_rate_per_second: number
  crafts_per_second: number
  ingredient_rates: ProductionIngredientRate[]
  machine?: {
    name: string
    crafting_speed: number
    machine_count: number
    nominal_output_rate_per_second: number
    utilization: number
    evidence_ids: string[]
  }
  evidence_ids: string[]
}

export interface ProductionExternalInput {
  type: ProductionMaterialType
  name: string
  rate_per_second: number
}

export interface ProductionSolveWarning {
  code: 'MACHINE_SIZING_MISSING'
  recipe_name: string
  message: string
}

export interface ProductionSolveSuccess {
  ok: true
  calculation_id: string
  target: ProductionTarget
  recipe_rates: ProductionRecipeRate[]
  external_inputs: ProductionExternalInput[]
  warnings: ProductionSolveWarning[]
  evidence_ids_used: string[]
  fully_sized: boolean
  sized_machine_count: number
}

export type ProductionSolveResult = ProductionSolveSuccess | ProductionSolveFailure

const MAX_RECIPES = 128
const MAX_MATERIALS_PER_RECIPE = 16
const MAX_EVIDENCE = 256
const MAX_EVIDENCE_IDS_PER_RECORD = 16
const MAX_GRAPH_DEPTH = 64
const MAX_NAME_LENGTH = 200
const MAX_RATE = 1000000000

interface MutableRecipeRate {
  recipe: ProductionRecipeModel
  product: ProductionMaterialAmount
  required_output_rate_per_second: number
  crafts_per_second: number
  ingredient_rates: ProductionIngredientRate[]
}

function valid_name(value: string) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_LENGTH
}

function valid_positive_number(value: number, max: number = MAX_RATE) {
  return typeof value === 'number'
    && value === value
    && value > 0
    && value < math.huge
    && value <= max
}

function material_key(material: { type: ProductionMaterialType, name: string }) {
  return `${material.type}:${material.name}`
}

function same_material(a: { type: ProductionMaterialType, name: string }, b: { type: ProductionMaterialType, name: string }) {
  return a.type === b.type && a.name === b.name
}

function evidence_source_valid(value: ProductionEvidenceSource) {
  return value === 'engine_read'
    || value === 'fixture'
    || value === 'measurement'
    || value === 'calculation'
    || value === 'estimate'
}

function string_in(values: string[], wanted: string) {
  for (const value of values) {
    if (value === wanted) return true
  }
  return false
}

function evidence_exists(evidence: ProductionEvidenceRef[], id: string) {
  for (const item of evidence) {
    if (item.id === id) return true
  }
  return false
}

function validate_evidence_ids(ids: string[] | undefined, evidence: ProductionEvidenceRef[]) {
  if (!ids) return true
  if (ids.length > MAX_EVIDENCE_IDS_PER_RECORD) return false
  for (const id of ids) {
    if (!valid_name(id) || !evidence_exists(evidence, id)) return false
  }
  return true
}

function invalid(message: string, calculation_id?: string): ProductionSolveFailure {
  return {
    ok: false,
    calculation_id,
    error: { code: 'INVALID_REQUEST', message },
  }
}

function limit_error(message: string, calculation_id?: string): ProductionSolveFailure {
  return {
    ok: false,
    calculation_id,
    error: { code: 'LIMIT_EXCEEDED', message },
  }
}

function validate_request(request: ProductionSolveRequest): ProductionSolveFailure | undefined {
  if (!request || typeof request !== 'object') return invalid('request is required')
  if (!valid_name(request.calculation_id)) return invalid('calculation_id must be a non-empty bounded string')
  if (!request.target || (request.target.type !== 'item' && request.target.type !== 'fluid')) {
    return invalid('target type must be item or fluid', request.calculation_id)
  }
  if (!valid_name(request.target.name) || !valid_positive_number(request.target.rate_per_second)) {
    return invalid('target name and rate_per_second must be valid and positive', request.calculation_id)
  }
  if (!Array.isArray(request.recipes)) return invalid('recipes must be an array', request.calculation_id)
  if (request.recipes.length > MAX_RECIPES) return limit_error(`recipes exceeds ${MAX_RECIPES}`, request.calculation_id)

  const evidence = request.evidence ?? []
  if (!Array.isArray(evidence)) return invalid('evidence must be an array', request.calculation_id)
  if (evidence.length > MAX_EVIDENCE) return limit_error(`evidence exceeds ${MAX_EVIDENCE}`, request.calculation_id)
  const seen_evidence: string[] = []
  for (const item of evidence) {
    if (!item || !valid_name(item.id) || !evidence_source_valid(item.source)) {
      return invalid('evidence entries must have a bounded id and supported source', request.calculation_id)
    }
    if (string_in(seen_evidence, item.id)) return invalid(`duplicate evidence id: ${item.id}`, request.calculation_id)
    seen_evidence.push(item.id)
  }

  const seen_recipes: string[] = []
  for (const recipe of request.recipes) {
    if (!recipe || !valid_name(recipe.recipe_name)) return invalid('recipe_name must be a non-empty bounded string', request.calculation_id)
    if (string_in(seen_recipes, recipe.recipe_name)) return invalid(`duplicate recipe_name: ${recipe.recipe_name}`, request.calculation_id)
    seen_recipes.push(recipe.recipe_name)
    if (!valid_positive_number(recipe.energy_seconds)) return invalid(`invalid energy_seconds for ${recipe.recipe_name}`, request.calculation_id)
    if (!Array.isArray(recipe.ingredients) || !Array.isArray(recipe.products)) {
      return invalid(`ingredients/products must be arrays for ${recipe.recipe_name}`, request.calculation_id)
    }
    if (recipe.ingredients.length > MAX_MATERIALS_PER_RECIPE || recipe.products.length > MAX_MATERIALS_PER_RECIPE) {
      return limit_error(`recipe material list exceeds ${MAX_MATERIALS_PER_RECIPE}: ${recipe.recipe_name}`, request.calculation_id)
    }
    if (recipe.products.length === 0) return invalid(`recipe has no products: ${recipe.recipe_name}`, request.calculation_id)
    for (const material of recipe.ingredients) {
      if (!material || (material.type !== 'item' && material.type !== 'fluid') || !valid_name(material.name) || !valid_positive_number(material.amount)) {
        return invalid(`invalid ingredient in ${recipe.recipe_name}`, request.calculation_id)
      }
    }
    for (const material of recipe.products) {
      if (!material || (material.type !== 'item' && material.type !== 'fluid') || !valid_name(material.name) || !valid_positive_number(material.amount)) {
        return invalid(`invalid product in ${recipe.recipe_name}`, request.calculation_id)
      }
    }
    if (!validate_evidence_ids(recipe.evidence_ids, evidence)) {
      return invalid(`invalid evidence reference in ${recipe.recipe_name}`, request.calculation_id)
    }
    if (recipe.machine) {
      if (!valid_name(recipe.machine.name) || !valid_positive_number(recipe.machine.crafting_speed)) {
        return invalid(`invalid machine selection in ${recipe.recipe_name}`, request.calculation_id)
      }
      if (!validate_evidence_ids(recipe.machine.evidence_ids, evidence)) {
        return invalid(`invalid machine evidence reference in ${recipe.recipe_name}`, request.calculation_id)
      }
    }
  }
  return undefined
}

function producers_for(recipes: ProductionRecipeModel[], material: { type: ProductionMaterialType, name: string }) {
  const matches: ProductionRecipeModel[] = []
  for (const recipe of recipes) {
    for (const product of recipe.products) {
      if (same_material(product, material)) {
        matches.push(recipe)
        break
      }
    }
  }
  return matches
}

function find_mutable_node(nodes: MutableRecipeRate[], recipe_name: string) {
  for (const node of nodes) {
    if (node.recipe.recipe_name === recipe_name) return node
  }
  return undefined
}

function add_ingredient_rate(rates: ProductionIngredientRate[], material: ProductionMaterialAmount, rate: number) {
  for (const existing of rates) {
    if (same_material(existing, material)) {
      existing.rate_per_second += rate
      return
    }
  }
  rates.push({ type: material.type, name: material.name, rate_per_second: rate })
}

function add_external_input(inputs: ProductionExternalInput[], material: { type: ProductionMaterialType, name: string }, rate: number) {
  for (const existing of inputs) {
    if (same_material(existing, material)) {
      existing.rate_per_second += rate
      return
    }
  }
  inputs.push({ type: material.type, name: material.name, rate_per_second: rate })
}

function sort_material_rates<T extends { type: ProductionMaterialType, name: string }>(values: T[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const left = `${values[i].type}:${values[i].name}`
      const right = `${values[j].type}:${values[j].name}`
      if (right < left) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
}

function unique_evidence_ids(recipe: ProductionRecipeModel) {
  const result: string[] = []
  for (const id of recipe.evidence_ids ?? []) {
    if (!string_in(result, id)) result.push(id)
  }
  for (const id of recipe.machine?.evidence_ids ?? []) {
    if (!string_in(result, id)) result.push(id)
  }
  return result
}

export function solve_production(request: ProductionSolveRequest): ProductionSolveResult {
  const validation = validate_request(request)
  if (validation) return validation

  const recipe_rates: MutableRecipeRate[] = []
  const external_inputs: ProductionExternalInput[] = []
  let failure: ProductionSolveFailure | undefined

  function expand(material: { type: ProductionMaterialType, name: string }, required_rate: number, stack: string[]) {
    if (failure) return
    if (stack.length > MAX_GRAPH_DEPTH) {
      failure = limit_error(`production graph exceeds depth ${MAX_GRAPH_DEPTH}`, request.calculation_id)
      return
    }

    const key = material_key(material)
    if (string_in(stack, key)) {
      failure = {
        ok: false,
        calculation_id: request.calculation_id,
        error: {
          code: 'RECIPE_CYCLE',
          message: `recipe cycle detected at ${key}`,
          material: { type: material.type, name: material.name },
        },
      }
      return
    }

    const producers = producers_for(request.recipes, material)
    if (producers.length === 0) {
      add_external_input(external_inputs, material, required_rate)
      return
    }
    if (producers.length > 1) {
      failure = {
        ok: false,
        calculation_id: request.calculation_id,
        error: {
          code: 'AMBIGUOUS_RECIPE',
          message: `multiple recipes produce ${key}; select one route explicitly`,
          material: { type: material.type, name: material.name },
        },
      }
      return
    }

    const recipe = producers[0]
    if (recipe.probabilistic === true || recipe.productivity_sensitive === true || recipe.products.length !== 1) {
      failure = {
        ok: false,
        calculation_id: request.calculation_id,
        error: {
          code: 'UNSUPPORTED_PRODUCTION_MODEL',
          message: `recipe ${recipe.recipe_name} is outside the deterministic single-product solver domain`,
          material: { type: material.type, name: material.name },
          recipe_name: recipe.recipe_name,
        },
      }
      return
    }

    const product = recipe.products[0]
    if (!same_material(product, material)) {
      failure = invalid(`selected recipe does not produce requested material: ${recipe.recipe_name}`, request.calculation_id)
      return
    }
    const crafts_per_second = required_rate / product.amount
    let node = find_mutable_node(recipe_rates, recipe.recipe_name)
    if (!node) {
      node = {
        recipe,
        product,
        required_output_rate_per_second: 0,
        crafts_per_second: 0,
        ingredient_rates: [],
      }
      recipe_rates.push(node)
    }
    node.required_output_rate_per_second += required_rate
    node.crafts_per_second += crafts_per_second

    const next_stack = stack.slice()
    next_stack.push(key)
    for (const ingredient of recipe.ingredients) {
      const ingredient_rate = crafts_per_second * ingredient.amount
      add_ingredient_rate(node.ingredient_rates, ingredient, ingredient_rate)
      expand(ingredient, ingredient_rate, next_stack)
      if (failure) return
    }
  }

  expand(request.target, request.target.rate_per_second, [])
  if (failure) return failure

  const warnings: ProductionSolveWarning[] = []
  const output_rates: ProductionRecipeRate[] = []
  const evidence_ids_used: string[] = []
  let sized_machine_count = 0

  for (const mutable of recipe_rates) {
    sort_material_rates(mutable.ingredient_rates)
    const recipe_evidence = unique_evidence_ids(mutable.recipe)
    for (const id of recipe_evidence) {
      if (!string_in(evidence_ids_used, id)) evidence_ids_used.push(id)
    }

    let machine: ProductionRecipeRate['machine']
    if (mutable.recipe.machine) {
      const crafts_per_machine_per_second = mutable.recipe.machine.crafting_speed / mutable.recipe.energy_seconds
      const machine_count = math.ceil(mutable.crafts_per_second / crafts_per_machine_per_second)
      const nominal_output_rate_per_second = machine_count * crafts_per_machine_per_second * mutable.product.amount
      machine = {
        name: mutable.recipe.machine.name,
        crafting_speed: mutable.recipe.machine.crafting_speed,
        machine_count,
        nominal_output_rate_per_second,
        utilization: mutable.required_output_rate_per_second / nominal_output_rate_per_second,
        evidence_ids: mutable.recipe.machine.evidence_ids ?? [],
      }
      sized_machine_count += machine_count
    }
    else {
      warnings.push({
        code: 'MACHINE_SIZING_MISSING',
        recipe_name: mutable.recipe.recipe_name,
        message: `material flow solved, but ${mutable.recipe.recipe_name} has no selected machine/crafting speed`,
      })
    }

    output_rates.push({
      recipe_name: mutable.recipe.recipe_name,
      product: mutable.product,
      required_output_rate_per_second: mutable.required_output_rate_per_second,
      crafts_per_second: mutable.crafts_per_second,
      ingredient_rates: mutable.ingredient_rates,
      machine,
      evidence_ids: mutable.recipe.evidence_ids ?? [],
    })
  }

  sort_material_rates(external_inputs)
  for (let i = 0; i < output_rates.length; i++) {
    for (let j = i + 1; j < output_rates.length; j++) {
      if (output_rates[j].recipe_name < output_rates[i].recipe_name) {
        const swap = output_rates[i]
        output_rates[i] = output_rates[j]
        output_rates[j] = swap
      }
    }
  }
  for (let i = 0; i < warnings.length; i++) {
    for (let j = i + 1; j < warnings.length; j++) {
      if (warnings[j].recipe_name < warnings[i].recipe_name) {
        const swap = warnings[i]
        warnings[i] = warnings[j]
        warnings[j] = swap
      }
    }
  }
  for (let i = 0; i < evidence_ids_used.length; i++) {
    for (let j = i + 1; j < evidence_ids_used.length; j++) {
      if (evidence_ids_used[j] < evidence_ids_used[i]) {
        const swap = evidence_ids_used[i]
        evidence_ids_used[i] = evidence_ids_used[j]
        evidence_ids_used[j] = swap
      }
    }
  }

  return {
    ok: true,
    calculation_id: request.calculation_id,
    target: request.target,
    recipe_rates: output_rates,
    external_inputs,
    warnings,
    evidence_ids_used,
    fully_sized: warnings.length === 0,
    sized_machine_count,
  }
}
