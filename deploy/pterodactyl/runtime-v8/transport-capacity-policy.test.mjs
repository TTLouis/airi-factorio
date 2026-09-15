import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('Pterodactyl exposes getTransportCapacity with strict bounded fields', () => {
  const tool = toolDefinitions.find(tool => tool.function.name === 'getTransportCapacity')
  assert.ok(tool)
  assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(tool.function.parameters.required, ['kind'])
  assert.equal(tool.function.parameters.properties.required_rate_per_second.maximum, 1000000000)
  assert.equal(tool.function.parameters.properties.unit_number.minimum, 1)
})

test('Pterodactyl renders lane, prototype-inserter, and placed-inserter capacity requests', () => {
  assert.equal(toolCommand('getTransportCapacity', {
    kind: 'belt', prototype_name: 'transport-belt', scope: 'lane', required_rate_per_second: 7.5,
  }), "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\",\"capacity\",{kind='belt',prototype_name='transport-belt',scope='lane',required_rate_per_second=7.5})))")
  assert.equal(toolCommand('getTransportCapacity', {
    kind: 'inserter', prototype_name: 'bulk-inserter', item_name: 'iron-plate',
  }), "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\",\"capacity\",{kind='inserter',prototype_name='bulk-inserter',item_name='iron-plate'})))")
  assert.equal(toolCommand('getTransportCapacity', {
    kind: 'inserter_instance', unit_number: 42,
  }), "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\",\"capacity\",{kind='inserter_instance',unit_number=42})))")
})

test('Pterodactyl rejects cross-kind fields, injection, extras, and invalid rates', () => {
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'belt', prototype_name: 'transport-belt', item_name: 'iron-plate' }))
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'inserter', prototype_name: 'bulk-inserter', required_rate_per_second: 10 }))
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'inserter_instance', unit_number: 0 }))
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'inserter_instance', unit_number: 42, prototype_name: 'fast-inserter' }))
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'belt', prototype_name: 'transport-belt\n/c game.clear()' }))
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'belt', prototype_name: 'transport-belt', required_rate_per_second: 0 }))
  assert.throws(() => toolCommand('getTransportCapacity', { kind: 'belt', prototype_name: 'transport-belt', extra: true }))
})
