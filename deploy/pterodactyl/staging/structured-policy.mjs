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

export function luaString(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'Invalid Lua string')
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

function exactKeys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  const keys = Object.keys(value)
  check(keys.every(key => allowed.includes(key)), 'Unexpected argument')
}

export function parseOperation(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Operation must be an object')
  exactKeys(value, ['name', 'args'])
  const { name, args } = value
  check(typeof name === 'string', 'Operation name must be a string')
  exactKeys(args, operationKeys[name] ?? [])

  switch (name) {
    case 'walk_to_entity':
      return { name, args: { entity_name: factorioName(args.entity_name), search_radius: integer(args.search_radius, 'search_radius', 1, 256) } }
    case 'mine_entity':
      return { name, args: { entity_name: factorioName(args.entity_name), count: integer(args.count ?? 1, 'count', 1, 1000) } }
    case 'place_entity':
      return { name, args: { entity_name: factorioName(args.entity_name) } }
    case 'move_items':
      check(typeof args.to_entity === 'boolean', 'to_entity must be boolean')
      return { name, args: { item_name: factorioName(args.item_name), entity_name: factorioName(args.entity_name), max_count: integer(args.max_count, 'max_count', 1, 100000), to_entity: args.to_entity } }
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

const operationKeys = {
  walk_to_entity: ['entity_name', 'search_radius'],
  mine_entity: ['entity_name', 'count'],
  place_entity: ['entity_name'],
  move_items: ['item_name', 'entity_name', 'max_count', 'to_entity'],
  craft_item: ['item_name', 'count'],
  attack_nearest_enemy: ['search_radius'],
  research_technology: ['technology_name'],
  wait: ['ticks'],
}

export function renderOperation(value) {
  const operation = parseOperation(value)
  switch (operation.name) {
    case 'walk_to_entity': return `remote.call('autorio_operations','walk_to_entity',${luaString(operation.args.entity_name)},${operation.args.search_radius})`
    case 'mine_entity': return `remote.call('autorio_operations','mine_entity',${luaString(operation.args.entity_name)},${operation.args.count})`
    case 'place_entity': return `remote.call('autorio_operations','place_entity',${luaString(operation.args.entity_name)})`
    case 'move_items': return `remote.call('autorio_operations','move_items',${luaString(operation.args.item_name)},${luaString(operation.args.entity_name)},${operation.args.max_count},${operation.args.to_entity})`
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

const noArgs = () => ({})

export const toolDefinitions = [
  ['getActorStatus', 'Read AIRI actor mode, identity, validity, position and connected-human count.', noArgs],
  ['getTaskStatus', 'Read current Autorio task and bounded queue state.', noArgs],
  ['getInventoryItems', 'Read AIRI standalone actor inventory.', noArgs],
  ['getRecipe', 'Read one exact recipe for AIRI force.', () => ({ item: 'string' })],
  ['getNearbyEntities', 'Inspect a bounded local area around AIRI.', () => ({ radius: 'integer?', name: 'string?', type: 'string?', limit: 'integer?' })],
  ['getEntityStatus', 'Inspect one nearest exact-name local entity.', () => ({ name: 'string', radius: 'integer?' })],
  ['getNavigationStatus', 'Read bounded navigation target and last result.', noArgs],
  ['getCraftingStatus', 'Read bounded native crafting ownership and last result.', noArgs],
  ['getResearchStatus', 'Read force research and last request result.', noArgs],
  ['getTechnology', 'Read one exact technology.', () => ({ name: 'string' })],
  ['getCombatStatus', 'Read bounded combat target and last result.', noArgs],
].map(([name, description]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: true } },
}))

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
    case 'getNearbyEntities': {
      noExtra(args, ['radius', 'name', 'type', 'limit'])
      const radius = integer(args.radius ?? 20, 'radius', 1, 64)
      const limit = integer(args.limit ?? 50, 'limit', 1, 100)
      const entityName = args.name === undefined ? 'nil' : luaString(factorioName(args.name))
      const entityType = args.type === undefined ? 'nil' : luaString(factorioName(args.type))
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_nearby_entities",${radius},${entityName},${entityType},${limit})))`
    }
    case 'getEntityStatus': {
      noExtra(args, ['name', 'radius'])
      const radius = integer(args.radius ?? 8, 'radius', 1, 32)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",${luaString(factorioName(args.name))},${radius})))`
    }
    case 'getNavigationStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_navigation","status")))'
    case 'getCraftingStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting","status")))'
    case 'getResearchStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","status")))'
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
