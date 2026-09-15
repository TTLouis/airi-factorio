export class PolicyError extends Error {}

function check(ok, message) {
  if (!ok) throw new PolicyError(message)
}

export function factorioName(value) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value), 'Invalid Factorio name')
  return value
}

function integer(value, label, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer from ${min} to ${max}`)
  return value
}

function finiteNumber(value, label, min, max) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${label} must be a number from ${min} to ${max}`)
  return value
}

export function luaString(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'Invalid Lua string')
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

function exactKeys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  const keys = Object.keys(value)
  check(keys.every(key => allowed.includes(key)), 'Unexpected argument')
}

const operationKeys = {
  walk_to_entity: ['entity_name', 'search_radius'],
  walk_to_player: ['player_name'],
  follow_player: ['player_name', 'follow_distance'],
  stop_follow_player: [],
  mine_entity: ['entity_name', 'count'],
  place_entity: ['entity_name'],
  move_items: ['item_name', 'entity_name', 'max_count', 'to_entity'],
  move_items_with_player: ['item_name', 'player_name', 'max_count', 'to_player'],
  craft_item: ['item_name', 'count'],
  attack_nearest_enemy: ['search_radius'],
  research_technology: ['technology_name'],
  wait: ['ticks'],
}

export function parseOperation(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Operation must be an object')
  exactKeys(value, ['name', 'args'])
  const { name, args } = value
  check(typeof name === 'string', 'Operation name must be a string')
  check(Object.hasOwn(operationKeys, name), 'Unapproved operation')
  exactKeys(args, operationKeys[name])

  switch (name) {
    case 'walk_to_entity':
      return { name, args: { entity_name: factorioName(args.entity_name), search_radius: integer(args.search_radius, 'search_radius', 1, 4096) } }
    case 'walk_to_player':
      return { name, args: { player_name: factorioName(args.player_name) } }
    case 'follow_player':
      return { name, args: { player_name: factorioName(args.player_name), follow_distance: finiteNumber(args.follow_distance ?? 4, 'follow_distance', 1, 64) } }
    case 'stop_follow_player':
      return { name, args: {} }
    case 'mine_entity':
      return { name, args: { entity_name: factorioName(args.entity_name), count: integer(args.count ?? 1, 'count', 1, 1000) } }
    case 'place_entity':
      return { name, args: { entity_name: factorioName(args.entity_name) } }
    case 'move_items':
      check(typeof args.to_entity === 'boolean', 'to_entity must be boolean')
      return { name, args: { item_name: factorioName(args.item_name), entity_name: factorioName(args.entity_name), max_count: integer(args.max_count, 'max_count', 1, 100000), to_entity: args.to_entity } }
    case 'move_items_with_player':
      check(typeof args.to_player === 'boolean', 'to_player must be boolean')
      return { name, args: { item_name: factorioName(args.item_name), player_name: factorioName(args.player_name), max_count: integer(args.max_count, 'max_count', 1, 100000), to_player: args.to_player } }
    case 'craft_item':
      return { name, args: { item_name: factorioName(args.item_name), count: integer(args.count ?? 1, 'count', 1, 1000) } }
    case 'attack_nearest_enemy':
      return { name, args: { search_radius: integer(args.search_radius ?? 50, 'search_radius', 1, 256) } }
    case 'research_technology':
      return { name, args: { technology_name: factorioName(args.technology_name) } }
    case 'wait':
      return { name, args: { ticks: integer(args.ticks, 'ticks', 1, 360000) } }
    default:
      throw new PolicyError('Unapproved operation')
  }
}

export function renderOperation(value) {
  const operation = parseOperation(value)
  switch (operation.name) {
    case 'walk_to_entity': return `remote.call('autorio_operations','walk_to_entity',${luaString(operation.args.entity_name)},${operation.args.search_radius})`
    case 'walk_to_player': return `remote.call('autorio_operations','walk_to_player',${luaString(operation.args.player_name)})`
    case 'follow_player': return `remote.call('autorio_operations','follow_player',${luaString(operation.args.player_name)},${operation.args.follow_distance})`
    case 'stop_follow_player': return `remote.call('autorio_operations','stop_follow_player')`
    case 'mine_entity': return `remote.call('autorio_operations','mine_entity',${luaString(operation.args.entity_name)},${operation.args.count})`
    case 'place_entity': return `remote.call('autorio_operations','place_entity',${luaString(operation.args.entity_name)})`
    case 'move_items': return `remote.call('autorio_operations','move_items',${luaString(operation.args.item_name)},${luaString(operation.args.entity_name)},${operation.args.max_count},${operation.args.to_entity})`
    case 'move_items_with_player': return `remote.call('autorio_operations','move_items_with_player',${luaString(operation.args.item_name)},${luaString(operation.args.player_name)},${operation.args.max_count},${operation.args.to_player})`
    case 'craft_item': return `remote.call('autorio_operations','craft_item',${luaString(operation.args.item_name)},${operation.args.count})`
    case 'attack_nearest_enemy': return `remote.call('autorio_operations','attack_nearest_enemy',${operation.args.search_radius})`
    case 'research_technology': return `remote.call('autorio_operations','research_technology',${luaString(operation.args.technology_name)})`
    case 'wait': return `remote.call('autorio_operations','wait',${operation.args.ticks})`
    default: throw new PolicyError('Unapproved operation')
  }
}

export function parsePlan(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Provider response must be an object')
  exactKeys(value, ['chatMessage', 'plan', 'currentStep', 'operations'])
  check(typeof value.chatMessage === 'string' && value.chatMessage.length <= 2000, 'Invalid chatMessage')
  check(Array.isArray(value.plan) && value.plan.length <= 30 && value.plan.every(item => typeof item === 'string' && item.length <= 500), 'Invalid plan')
  integer(value.currentStep, 'currentStep', 0, 30)
  check(Array.isArray(value.operations) && value.operations.length <= 16, 'Invalid operations')
  return {
    chatMessage: value.chatMessage,
    plan: [...value.plan],
    currentStep: value.currentStep,
    operations: value.operations.map(parseOperation),
  }
}

const emptyObjectSchema = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })
const nameStringSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 200 })

function functionTool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } }
}

export const toolDefinitions = [
  functionTool('getActorStatus', 'Read AIRI actor mode, identity, validity, position and connected-human count.', emptyObjectSchema),
  functionTool('getTaskStatus', 'Read current Autorio task and bounded queue state.', emptyObjectSchema),
  functionTool('getInventoryItems', 'Read AIRI standalone actor inventory.', emptyObjectSchema),
  functionTool('getRecipe', 'Read one exact recipe for AIRI force.', {
    type: 'object', properties: { item: nameStringSchema }, required: ['item'], additionalProperties: false,
  }),
  functionTool('getPlayerStatus', 'Read one exact human player by name, including availability, surface, position, and distance from AIRI when comparable.', {
    type: 'object', properties: { player_name: nameStringSchema }, required: ['player_name'], additionalProperties: false,
  }),
  functionTool('getNearbyEntities', 'Inspect a bounded local area around AIRI.', {
    type: 'object',
    properties: {
      radius: { type: 'integer', minimum: 1, maximum: 64, default: 20 },
      name: nameStringSchema,
      type: nameStringSchema,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
    additionalProperties: false,
  }),
  functionTool('findLongRangeEntities', 'Search outward for an exact Factorio prototype name, up to 4096 tiles, returning a bounded number of distant targets.', {
    type: 'object',
    properties: {
      name: nameStringSchema,
      max_radius: { type: 'integer', minimum: 64, maximum: 4096, default: 1024 },
      limit: { type: 'integer', minimum: 1, maximum: 16, default: 8 },
    },
    required: ['name'],
    additionalProperties: false,
  }),
  functionTool('getEntityStatus', 'Inspect one nearest exact-name local entity.', {
    type: 'object',
    properties: { name: nameStringSchema, radius: { type: 'integer', minimum: 1, maximum: 32, default: 8 } },
    required: ['name'],
    additionalProperties: false,
  }),
  functionTool('getNavigationStatus', 'Read bounded navigation target and last result.', emptyObjectSchema),
  functionTool('getFollowStatus', 'Read persistent player-follow state, target player, configured distance, and current distance.', emptyObjectSchema),
  functionTool('getCraftingStatus', 'Read bounded native crafting ownership and last result.', emptyObjectSchema),
  functionTool('getResearchStatus', 'Read force research and latest request/follow-through state.', emptyObjectSchema),
  functionTool('getResearchRequest', 'Read one exact correlated research request and follow-through record by request ID.', {
    type: 'object',
    properties: { request_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    required: ['request_id'],
    additionalProperties: false,
  }),
  functionTool('getTechnology', 'Read one exact technology.', {
    type: 'object', properties: { name: nameStringSchema }, required: ['name'], additionalProperties: false,
  }),
  functionTool('getCombatStatus', 'Read bounded combat target and last result.', emptyObjectSchema),
]

function argsObject(args) {
  check(args && typeof args === 'object' && !Array.isArray(args), 'Invalid tool arguments')
  return args
}

function noExtra(args, allowed) {
  check(Object.keys(args).every(key => allowed.includes(key)), 'Unexpected tool argument')
}

export function toolCommand(name, rawArgs = {}) {
  const args = argsObject(rawArgs)
  switch (name) {
    case 'getActorStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))'
    case 'getTaskStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))'
    case 'getInventoryItems':
      noExtra(args, [])
      return '/silent-command remote.call("autorio_tools","get_inventory_items")'
    case 'getRecipe':
      noExtra(args, ['item'])
      return `/silent-command remote.call("autorio_tools","get_recipe",${luaString(factorioName(args.item))})`
    case 'getPlayerStatus':
      noExtra(args, ['player_name'])
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_player_status",${luaString(factorioName(args.player_name))})))`
    case 'getNearbyEntities': {
      noExtra(args, ['radius', 'name', 'type', 'limit'])
      const radius = integer(args.radius ?? 20, 'radius', 1, 64)
      const limit = integer(args.limit ?? 50, 'limit', 1, 100)
      const entityName = args.name === undefined ? 'nil' : luaString(factorioName(args.name))
      const entityType = args.type === undefined ? 'nil' : luaString(factorioName(args.type))
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_nearby_entities",${radius},${entityName},${entityType},${limit})))`
    }
    case 'findLongRangeEntities': {
      noExtra(args, ['name', 'max_radius', 'limit'])
      const entityName = factorioName(args.name)
      const maxRadius = integer(args.max_radius ?? 1024, 'max_radius', 64, 4096)
      const limit = integer(args.limit ?? 8, 'limit', 1, 16)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_entities",${luaString(entityName)},${maxRadius},${limit})))`
    }
    case 'getEntityStatus': {
      noExtra(args, ['name', 'radius'])
      const radius = integer(args.radius ?? 8, 'radius', 1, 32)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",${luaString(factorioName(args.name))},${radius})))`
    }
    case 'getNavigationStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_navigation","status")))'
    case 'getFollowStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_follow","status")))'
    case 'getCraftingStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting","status")))'
    case 'getResearchStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","status")))'
    case 'getResearchRequest': {
      noExtra(args, ['request_id'])
      const requestId = integer(args.request_id, 'request_id', 1, Number.MAX_SAFE_INTEGER)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","request_result",${requestId})))`
    }
    case 'getTechnology':
      noExtra(args, ['name'])
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","technology",${luaString(factorioName(args.name))})))`
    case 'getCombatStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_combat","status")))'
    default:
      throw new PolicyError('Unapproved tool')
  }
}
