import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('Pterodactyl exposes getProductionScope as a facts-only bounded observation', () => {
  const tool = toolDefinitions.find(tool => tool.function.name === 'getProductionScope')
  assert.ok(tool)
  assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(tool.function.parameters.required, ['calculation_id', 'target'])
  assert.equal(tool.function.parameters.properties.max_depth.maximum, 6)
  assert.equal(tool.function.parameters.properties.max_materials.maximum, 32)
  assert.equal(tool.function.parameters.properties.target.properties.rate_per_second, undefined)
  assert.match(tool.function.description, /model must choose the intended production scope/i)
})

test('Pterodactyl renders getProductionScope without accepting a target rate', () => {
  assert.equal(toolCommand('getProductionScope', {
    calculation_id: 'green-scope',
    target: { type: 'item', name: 'electronic-circuit' },
    max_depth: 3,
    max_materials: 16,
  }), "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\",\"scope_context\",{calculation_id='green-scope',target={type='item',name='electronic-circuit'},max_depth=3,max_materials=16})))")
  assert.throws(() => toolCommand('getProductionScope', {
    calculation_id: 'bad',
    target: { type: 'item', name: 'electronic-circuit', rate_per_second: 5 },
  }))
})

test('Pterodactyl exposes solveProduction with a strict bounded schema', () => {
  const tool = toolDefinitions.find(tool => tool.function.name === 'solveProduction')
  assert.ok(tool)
  assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(tool.function.parameters.required, ['calculation_id', 'target'])
  assert.equal(tool.function.parameters.properties.included_recipe_names.maxItems, 64)
  assert.equal(tool.function.parameters.properties.machine_selections.maxItems, 64)
  assert.equal(tool.function.parameters.properties.target.properties.rate_per_second.maximum, 1000000000)
})

test('Pterodactyl renders solveProduction only after strict validation', () => {
  assert.equal(toolCommand('solveProduction', {
    calculation_id: "green-circuit's-line",
    target: { type: 'item', name: 'electronic-circuit', rate_per_second: 5 },
    included_recipe_names: ['electronic-circuit', 'copper-cable'],
    machine_selections: [
      { recipe_name: 'electronic-circuit', machine_name: 'assembling-machine-2' },
      { recipe_name: 'copper-cable', machine_name: 'assembling-machine-2' },
    ],
  }), "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\",\"solve\",{calculation_id='green-circuit\\'s-line',target={type='item',name='electronic-circuit',rate_per_second=5},included_recipe_names={'electronic-circuit','copper-cable'},machine_selections={{recipe_name='electronic-circuit',machine_name='assembling-machine-2'},{recipe_name='copper-cable',machine_name='assembling-machine-2'}}})))")
})

test('Pterodactyl solveProduction rejects injection, extras, and capacity overflows', () => {
  const valid = { calculation_id: 'x', target: { type: 'item', name: 'iron-plate', rate_per_second: 1 } }
  assert.throws(() => toolCommand('solveProduction', { ...valid, extra: true }))
  assert.throws(() => toolCommand('solveProduction', { ...valid, target: { ...valid.target, name: 'iron-plate\n/c game.clear()' } }))
  assert.throws(() => toolCommand('solveProduction', { ...valid, target: { ...valid.target, rate_per_second: 0 } }))
  assert.throws(() => toolCommand('solveProduction', { ...valid, target: { ...valid.target, rate_per_second: 1000000001 } }))
  assert.throws(() => toolCommand('solveProduction', { ...valid, included_recipe_names: Array.from({ length: 65 }, (_, i) => `recipe-${i}`) }))
  assert.throws(() => toolCommand('solveProduction', { ...valid, machine_selections: Array.from({ length: 65 }, (_, i) => ({ recipe_name: `recipe-${i}`, machine_name: 'assembling-machine-1' })) }))
  assert.throws(() => toolCommand('solveProduction', { ...valid, machine_selections: [{ recipe_name: 'iron-plate', machine_name: 'assembling-machine-1', lua: 'game.clear()' }] }))
})

test('existing policy tools still delegate through the base allowlist', () => {
  assert.equal(toolCommand('getActorStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))')
  assert.throws(() => toolCommand('shell', {}))
})
