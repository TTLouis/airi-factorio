import * as base from '../staging/structured-policy.mjs'

export * from '../staging/structured-policy.mjs'

function check(ok, message) {
  if (!ok) throw new base.PolicyError(message)
}

function exactKeys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  check(Object.keys(value).every(key => allowed.includes(key)), 'Unexpected argument')
}

function positiveRate(value) {
  check(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000, 'rate_per_second must be a positive number up to 1000000000')
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
    target: {
      type: args.target.type,
      name: base.factorioName(args.target.name),
      rate_per_second: positiveRate(args.target.rate_per_second),
    },
  }

  if (args.included_recipe_names !== undefined) {
    parsed.included_recipe_names = stringArray(args.included_recipe_names, 'included_recipe_names')
  }
  if (args.machine_selections !== undefined) {
    check(Array.isArray(args.machine_selections) && args.machine_selections.length <= 64, 'machine_selections must be an array with at most 64 entries')
    parsed.machine_selections = args.machine_selections.map(selection => {
      exactKeys(selection, ['recipe_name', 'machine_name'])
      return {
        recipe_name: base.factorioName(selection.recipe_name),
        machine_name: base.factorioName(selection.machine_name),
      }
    })
  }
  return parsed
}

function luaStringArray(values) {
  return `{${values.map(base.luaString).join(',')}}`
}

function renderSolveProduction(args) {
  const parsed = parseSolveProduction(args)
  const fields = [
    `calculation_id=${base.luaString(parsed.calculation_id)}`,
    `target={type=${base.luaString(parsed.target.type)},name=${base.luaString(parsed.target.name)},rate_per_second=${parsed.target.rate_per_second}}`,
  ]
  if (parsed.included_recipe_names !== undefined) fields.push(`included_recipe_names=${luaStringArray(parsed.included_recipe_names)}`)
  if (parsed.machine_selections !== undefined) {
    const selections = parsed.machine_selections.map(selection => `{recipe_name=${base.luaString(selection.recipe_name)},machine_name=${base.luaString(selection.machine_name)}}`)
    fields.push(`machine_selections={${selections.join(',')}}`)
  }
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","solve",{${fields.join(',')}})))`
}

const solveProductionDefinition = {
  type: 'function',
  function: {
    name: 'solveProduction',
    description: 'Deterministically solve a bounded production target from live Factorio recipes. Does not validate inserter, belt-lane, or stacked-belt capacity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['calculation_id', 'target'],
      properties: {
        calculation_id: { type: 'string', minLength: 1, maxLength: 200 },
        target: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'name', 'rate_per_second'],
          properties: {
            type: { type: 'string', enum: ['item', 'fluid'] },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            rate_per_second: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 },
          },
        },
        included_recipe_names: {
          type: 'array',
          maxItems: 64,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        machine_selections: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['recipe_name', 'machine_name'],
            properties: {
              recipe_name: { type: 'string', minLength: 1, maxLength: 200 },
              machine_name: { type: 'string', minLength: 1, maxLength: 200 },
            },
          },
        },
      },
    },
  },
}

export const toolDefinitions = [...base.toolDefinitions, solveProductionDefinition]

export function toolCommand(name, args) {
  if (name === 'solveProduction') return renderSolveProduction(args)
  return base.toolCommand(name, args)
}
