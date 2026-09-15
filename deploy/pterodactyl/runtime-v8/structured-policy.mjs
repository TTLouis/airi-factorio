import * as base from '../staging/structured-policy.mjs'

export * from '../staging/structured-policy.mjs'

function check(ok, message) { if (!ok) throw new base.PolicyError(message) }
function exactKeys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  check(Object.keys(value).every(key => allowed.includes(key)), 'Unexpected argument')
}
function positiveRate(value) {
  check(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000, 'rate_per_second must be a positive number up to 1000000000')
  return value
}
function positiveInteger(value, label) {
  check(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`)
  return value
}
function stringArray(value, label) {
  check(Array.isArray(value) && value.length <= 64, `${label} must be an array with at most 64 entries`)
  return value.map(base.factorioName)
}

function parseSolveProduction(args) {
  exactKeys(args, ['calculation_id', 'target', 'included_recipe_names', 'machine_selections'])
  exactKeys(args.target, ['type', 'name', 'rate_per_second'])
  check(args.target.type === 'item' || args.target.type === 'fluid', 'target.type must be item or fluid')
  const parsed = {
    calculation_id: base.factorioName(args.calculation_id),
    target: { type: args.target.type, name: base.factorioName(args.target.name), rate_per_second: positiveRate(args.target.rate_per_second) },
  }
  if (args.included_recipe_names !== undefined) parsed.included_recipe_names = stringArray(args.included_recipe_names, 'included_recipe_names')
  if (args.machine_selections !== undefined) {
    check(Array.isArray(args.machine_selections) && args.machine_selections.length <= 64, 'machine_selections must be an array with at most 64 entries')
    parsed.machine_selections = args.machine_selections.map(selection => {
      exactKeys(selection, ['recipe_name', 'machine_name'])
      return { recipe_name: base.factorioName(selection.recipe_name), machine_name: base.factorioName(selection.machine_name) }
    })
  }
  return parsed
}

function renderSolveProduction(args) {
  const parsed = parseSolveProduction(args)
  const fields = [
    `calculation_id=${base.luaString(parsed.calculation_id)}`,
    `target={type=${base.luaString(parsed.target.type)},name=${base.luaString(parsed.target.name)},rate_per_second=${parsed.target.rate_per_second}}`,
  ]
  if (parsed.included_recipe_names !== undefined) fields.push(`included_recipe_names={${parsed.included_recipe_names.map(base.luaString).join(',')}}`)
  if (parsed.machine_selections !== undefined) {
    const selections = parsed.machine_selections.map(selection => `{recipe_name=${base.luaString(selection.recipe_name)},machine_name=${base.luaString(selection.machine_name)}}`)
    fields.push(`machine_selections={${selections.join(',')}}`)
  }
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","solve",{${fields.join(',')}})))`
}

function parseTransportCapacity(args) {
  exactKeys(args, ['kind', 'prototype_name', 'scope', 'required_rate_per_second', 'item_name', 'unit_number'])
  check(args.kind === 'belt' || args.kind === 'inserter' || args.kind === 'inserter_instance', 'kind must be belt, inserter, or inserter_instance')
  if (args.kind === 'inserter_instance') {
    check(args.prototype_name === undefined && args.scope === undefined && args.required_rate_per_second === undefined && args.item_name === undefined, 'inserter_instance only accepts unit_number')
    return { kind: args.kind, unit_number: positiveInteger(args.unit_number, 'unit_number') }
  }

  check(args.unit_number === undefined, 'unit_number is only valid for inserter_instance')
  const parsed = { kind: args.kind, prototype_name: base.factorioName(args.prototype_name) }
  if (args.kind === 'belt') {
    check(args.item_name === undefined, 'item_name is only valid for inserter capacity')
    if (args.scope !== undefined) {
      check(args.scope === 'lane' || args.scope === 'belt', 'scope must be lane or belt')
      parsed.scope = args.scope
    }
    if (args.required_rate_per_second !== undefined) parsed.required_rate_per_second = positiveRate(args.required_rate_per_second)
  }
  else {
    check(args.scope === undefined && args.required_rate_per_second === undefined, 'scope and required_rate_per_second are only valid for belt capacity')
    if (args.item_name !== undefined) parsed.item_name = base.factorioName(args.item_name)
  }
  return parsed
}

function renderTransportCapacity(args) {
  const parsed = parseTransportCapacity(args)
  if (parsed.kind === 'inserter_instance') {
    return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","capacity",{kind='inserter_instance',unit_number=${parsed.unit_number}})))`
  }
  const fields = [`kind=${base.luaString(parsed.kind)}`, `prototype_name=${base.luaString(parsed.prototype_name)}`]
  if (parsed.scope !== undefined) fields.push(`scope=${base.luaString(parsed.scope)}`)
  if (parsed.required_rate_per_second !== undefined) fields.push(`required_rate_per_second=${parsed.required_rate_per_second}`)
  if (parsed.item_name !== undefined) fields.push(`item_name=${base.luaString(parsed.item_name)}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","capacity",{${fields.join(',')}})))`
}

const solveProductionDefinition = {
  type: 'function',
  function: {
    name: 'solveProduction',
    description: 'Deterministically solve a bounded production target from live Factorio recipes. Recipe flow and machine sizing only; sustainable transport still requires explicit capacity validation.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['calculation_id', 'target'],
      properties: {
        calculation_id: { type: 'string', minLength: 1, maxLength: 200 },
        target: {
          type: 'object', additionalProperties: false, required: ['type', 'name', 'rate_per_second'],
          properties: {
            type: { type: 'string', enum: ['item', 'fluid'] }, name: { type: 'string', minLength: 1, maxLength: 200 },
            rate_per_second: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 },
          },
        },
        included_recipe_names: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 200 } },
        machine_selections: {
          type: 'array', maxItems: 64,
          items: {
            type: 'object', additionalProperties: false, required: ['recipe_name', 'machine_name'],
            properties: { recipe_name: { type: 'string', minLength: 1, maxLength: 200 }, machine_name: { type: 'string', minLength: 1, maxLength: 200 } },
          },
        },
      },
    },
  },
}

const transportCapacityDefinition = {
  type: 'function',
  function: {
    name: 'getTransportCapacity',
    description: 'Read live deterministic transport facts. Belt lane/whole-belt limits include researched stacking but stacked capacity is only a transport ceiling. Inserter prototype facts do not imply throughput. For an already observed placed inserter, kind inserter_instance plus exact unit_number returns its current pickup count, override, lane permissions and actual pickup/drop targets. Inserter transfer_rate remains unvalidated; never infer fixed items-per-second.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['belt', 'inserter', 'inserter_instance'] },
        prototype_name: { type: 'string', minLength: 1, maxLength: 200 },
        scope: { type: 'string', enum: ['lane', 'belt'] },
        required_rate_per_second: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 },
        item_name: { type: 'string', minLength: 1, maxLength: 200 },
        unit_number: { type: 'integer', minimum: 1 },
      },
    },
  },
}

export const toolDefinitions = [...base.toolDefinitions, solveProductionDefinition, transportCapacityDefinition]
export function toolCommand(name, args) {
  if (name === 'solveProduction') return renderSolveProduction(args)
  if (name === 'getTransportCapacity') return renderTransportCapacity(args)
  return base.toolCommand(name, args)
}
