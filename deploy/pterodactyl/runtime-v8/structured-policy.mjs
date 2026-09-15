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
function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= max, `${label} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ''}`)
  return value
}
function optionalInteger(value, label, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer from ${min} to ${max}`)
  return value
}
function finiteCoordinate(value, label) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= -1_000_000 && value <= 1_000_000, `${label} must be a finite map coordinate`)
  return value
}
function stringArray(value, label) {
  check(Array.isArray(value) && value.length <= 64, `${label} must be an array with at most 64 entries`)
  return value.map(base.factorioName)
}
function optionalBoolean(value, label) {
  check(typeof value === 'boolean', `${label} must be boolean`)
  return value
}
function position(value) {
  exactKeys(value, ['x', 'y'])
  return { x: finiteCoordinate(value.x, 'position.x'), y: finiteCoordinate(value.y, 'position.y') }
}
function side(value, label) {
  check(['north', 'south', 'east', 'west', 'any'].includes(value), `${label} must be north, south, east, west, or any`)
  return value
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

function parseSpatialObservation(args) {
  exactKeys(args, ['anchor_unit_number', 'position', 'half_size', 'requested_entity_name'])
  const parsed = {}
  if (args.anchor_unit_number !== undefined) parsed.anchor_unit_number = positiveInteger(args.anchor_unit_number, 'anchor_unit_number')
  if (args.position !== undefined) parsed.position = position(args.position)
  check(!(parsed.anchor_unit_number !== undefined && parsed.position !== undefined), 'provide anchor_unit_number or position, not both')
  if (args.half_size !== undefined) parsed.half_size = optionalInteger(args.half_size, 'half_size', 4, 16)
  if (args.requested_entity_name !== undefined) parsed.requested_entity_name = base.factorioName(args.requested_entity_name)
  return parsed
}

function parsePlacement(args) {
  exactKeys(args, ['entity_name', 'anchor_unit_number', 'position', 'side', 'direction', 'search_radius', 'max_candidates', 'reserve_input', 'reserve_output', 'reserve_power', 'extension_direction'])
  const parsed = { entity_name: base.factorioName(args.entity_name) }
  if (args.anchor_unit_number !== undefined) parsed.anchor_unit_number = positiveInteger(args.anchor_unit_number, 'anchor_unit_number')
  if (args.position !== undefined) parsed.position = position(args.position)
  check(!(parsed.anchor_unit_number !== undefined && parsed.position !== undefined), 'provide anchor_unit_number or position, not both')
  if (args.side !== undefined) parsed.side = side(args.side, 'side')
  if (args.direction !== undefined) parsed.direction = optionalInteger(args.direction, 'direction', 0, 15)
  if (args.search_radius !== undefined) parsed.search_radius = optionalInteger(args.search_radius, 'search_radius', 1, 12)
  if (args.max_candidates !== undefined) parsed.max_candidates = optionalInteger(args.max_candidates, 'max_candidates', 1, 8)
  if (args.reserve_input !== undefined) parsed.reserve_input = optionalBoolean(args.reserve_input, 'reserve_input')
  if (args.reserve_output !== undefined) parsed.reserve_output = optionalBoolean(args.reserve_output, 'reserve_output')
  if (args.reserve_power !== undefined) parsed.reserve_power = optionalBoolean(args.reserve_power, 'reserve_power')
  if (args.extension_direction !== undefined) parsed.extension_direction = side(args.extension_direction, 'extension_direction')
  return parsed
}

function luaTable(parsed) {
  const fields = []
  if (parsed.entity_name !== undefined) fields.push(`entity_name=${base.luaString(parsed.entity_name)}`)
  if (parsed.anchor_unit_number !== undefined) fields.push(`anchor_unit_number=${parsed.anchor_unit_number}`)
  if (parsed.position !== undefined) fields.push(`position={x=${parsed.position.x},y=${parsed.position.y}}`)
  if (parsed.half_size !== undefined) fields.push(`half_size=${parsed.half_size}`)
  if (parsed.requested_entity_name !== undefined) fields.push(`requested_entity_name=${base.luaString(parsed.requested_entity_name)}`)
  if (parsed.side !== undefined) fields.push(`side=${base.luaString(parsed.side)}`)
  if (parsed.direction !== undefined) fields.push(`direction=${parsed.direction}`)
  if (parsed.search_radius !== undefined) fields.push(`search_radius=${parsed.search_radius}`)
  if (parsed.max_candidates !== undefined) fields.push(`max_candidates=${parsed.max_candidates}`)
  if (parsed.reserve_input !== undefined) fields.push(`reserve_input=${parsed.reserve_input}`)
  if (parsed.reserve_output !== undefined) fields.push(`reserve_output=${parsed.reserve_output}`)
  if (parsed.reserve_power !== undefined) fields.push(`reserve_power=${parsed.reserve_power}`)
  if (parsed.extension_direction !== undefined) fields.push(`extension_direction=${base.luaString(parsed.extension_direction)}`)
  return `{${fields.join(',')}}`
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

const positionSchema = {
  type: 'object', additionalProperties: false, required: ['x', 'y'],
  properties: { x: { type: 'number', minimum: -1000000, maximum: 1000000 }, y: { type: 'number', minimum: -1000000, maximum: 1000000 } },
}

const localSpatialObservationDefinition = {
  type: 'function',
  function: {
    name: 'getLocalSpatialObservation',
    description: 'Read a bounded live local occupancy/spatial snapshot (max 32x32) for construction or navigation diagnosis: blocking water/out-of-map tiles, structures, cliffs, belts, inserters, machines, storage and the NPC footprint. Prefer this to repeated same-name entity probes when geometry matters.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        anchor_unit_number: { type: 'integer', minimum: 1 }, position: positionSchema,
        half_size: { type: 'integer', minimum: 4, maximum: 16, default: 12 },
        requested_entity_name: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  },
}

const placementPlannerDefinition = {
  type: 'function',
  function: {
    name: 'planPlacement',
    description: 'Deterministically select collision-free, locally reachable placement candidates from the live spatial map. Returns explicit rejection causes plus reserved input/output/power/future-extension corridor intent. Use the best returned coordinate instead of guessing tiles.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['entity_name'],
      properties: {
        entity_name: { type: 'string', minLength: 1, maxLength: 200 }, anchor_unit_number: { type: 'integer', minimum: 1 }, position: positionSchema,
        side: { type: 'string', enum: ['north', 'south', 'east', 'west', 'any'] }, direction: { type: 'integer', minimum: 0, maximum: 15 },
        search_radius: { type: 'integer', minimum: 1, maximum: 12, default: 8 }, max_candidates: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        reserve_input: { type: 'boolean' }, reserve_output: { type: 'boolean' }, reserve_power: { type: 'boolean' },
        extension_direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'any'] },
      },
    },
  },
}

export const toolDefinitions = [...base.toolDefinitions, solveProductionDefinition, transportCapacityDefinition, localSpatialObservationDefinition, placementPlannerDefinition]
export function toolCommand(name, args) {
  if (name === 'solveProduction') return renderSolveProduction(args)
  if (name === 'getTransportCapacity') return renderTransportCapacity(args)
  if (name === 'getLocalSpatialObservation') return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","spatial_observation",${luaTable(parseSpatialObservation(args))})))`
  if (name === 'planPlacement') return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","plan_placement",${luaTable(parsePlacement(args))})))`
  return base.toolCommand(name, args)
}
