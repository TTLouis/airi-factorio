import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOperation, parsePlan, renderOperation, toolCommand, toolDefinitions } from './structured-policy.mjs'

test('structured operations apply bounded defaults and render only approved Autorio calls', () => {
  assert.deepEqual(parseOperation({ name: 'mine_entity', args: { entity_name: 'iron-ore' } }), {
    name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 },
  })
  assert.deepEqual(parseOperation({ name: 'attack_nearest_enemy', args: {} }), {
    name: 'attack_nearest_enemy', args: { search_radius: 50 },
  })
  assert.equal(renderOperation({ name: 'wait', args: { ticks: 60 } }), "remote.call('autorio_operations','wait',60)")
  assert.equal(renderOperation({ name: 'place_entity', args: { entity_name: "mod's-chest" } }), "remote.call('autorio_operations','place_entity','mod\\'s-chest')")
})

test('operation policy rejects arbitrary code, extra args, and oversized bounded values', () => {
  for (const operation of [
    { name: 'game.clear', args: {} },
    { name: 'wait', args: { ticks: 60, lua: 'game.clear()' } },
    { name: 'wait', args: { ticks: 360001 } },
    { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 257 } },
    { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1001 } },
    { name: 'mine_entity', args: { entity_name: 'iron-ore\n/c game.clear()', count: 1 } },
  ]) assert.throws(() => parseOperation(operation))
})

test('provider plan requires exactly the structured response surface', () => {
  const plan = parsePlan({
    chatMessage: 'Working on it.',
    plan: ['Wait briefly'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 60 } }],
  })
  assert.equal(plan.operations[0].name, 'wait')
  assert.throws(() => parsePlan({ ...plan, operationCommands: [] }))
  assert.throws(() => parsePlan({ chatMessage: '', plan: [], currentStep: 0, operations: Array.from({ length: 17 }, () => ({ name: 'wait', args: { ticks: 1 } })) }))
})

test('tool surface matches current NPC observation contract and uses strict schemas', () => {
  assert.deepEqual(toolDefinitions.map(tool => tool.function.name), [
    'getActorStatus',
    'getTaskStatus',
    'getInventoryItems',
    'getRecipe',
    'getNearbyEntities',
    'getEntityStatus',
    'getNavigationStatus',
    'getCraftingStatus',
    'getResearchStatus',
    'getTechnology',
    'getCombatStatus',
  ])
  for (const tool of toolDefinitions) assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getRecipe').function.parameters.required, ['item'])
})

test('read-only tool renderer targets native actor-aware interfaces without player indexes', () => {
  assert.equal(toolCommand('getActorStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))')
  assert.equal(toolCommand('getCraftingStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting","status")))')
  assert.equal(toolCommand('getRecipe', { item: 'iron-gear-wheel' }), '/silent-command remote.call("autorio_tools","get_recipe",\'iron-gear-wheel\')')
  assert.equal(toolCommand('getNearbyEntities', { radius: 32, name: 'iron-ore', type: 'resource', limit: 25 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_nearby_entities",32,\'iron-ore\',\'resource\',25)))')
  assert.equal(toolCommand('getEntityStatus', { name: 'steel-chest' }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",\'steel-chest\',8)))')
})

test('tool calls reject unknown names, unsafe names, extras, and out-of-bound scans', () => {
  assert.throws(() => toolCommand('shell', {}))
  assert.throws(() => toolCommand('getRecipe', { item: 'iron-plate', force: 'enemy' }))
  assert.throws(() => toolCommand('getRecipe', { item: 'iron-plate\n/c game.clear()' }))
  assert.throws(() => toolCommand('getNearbyEntities', { radius: 65 }))
  assert.throws(() => toolCommand('getEntityStatus', { name: 'steel-chest', radius: 33 }))
})
