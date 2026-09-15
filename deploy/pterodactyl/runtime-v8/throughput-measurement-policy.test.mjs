import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('Pterodactyl exposes bounded live throughput measurement', () => {
  const tool = toolDefinitions.find(tool => tool.function.name === 'measureTransportThroughput')
  assert.ok(tool)
  assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(tool.function.parameters.required, ['kind', 'unit_number'])
  assert.equal(tool.function.parameters.properties.window_ticks.minimum, 60)
  assert.equal(tool.function.parameters.properties.window_ticks.maximum, 3600)
  assert.deepEqual(tool.function.parameters.properties.kind.enum, ['inserter_instance', 'belt_lane'])
})

test('throughput measurement renders inserter and belt-lane requests strictly', () => {
  assert.equal(toolCommand('measureTransportThroughput', {
    kind: 'inserter_instance', unit_number: 42, item_name: 'iron-plate', window_ticks: 300,
    required_rate_per_second: 8, utilization_limit: 0.8,
  }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","throughput_measurement_start",{kind=\'inserter_instance\',unit_number=42,item_name=\'iron-plate\',window_ticks=300,required_rate_per_second=8,utilization_limit=0.8})))')

  assert.equal(toolCommand('measureTransportThroughput', {
    kind: 'belt_lane', unit_number: 55, lane_index: 2, required_stack_size: 3,
  }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","throughput_measurement_start",{kind=\'belt_lane\',unit_number=55,lane_index=2,required_stack_size=3})))')
})

test('throughput measurement rejects mixed-kind and unbounded inputs', () => {
  assert.throws(() => toolCommand('measureTransportThroughput', { kind: 'inserter_instance', unit_number: 42, lane_index: 1 }))
  assert.throws(() => toolCommand('measureTransportThroughput', { kind: 'belt_lane', unit_number: 55 }))
  assert.throws(() => toolCommand('measureTransportThroughput', { kind: 'belt_lane', unit_number: 55, lane_index: 3 }))
  assert.throws(() => toolCommand('measureTransportThroughput', { kind: 'belt_lane', unit_number: 55, lane_index: 1, window_ticks: 59 }))
  assert.throws(() => toolCommand('measureTransportThroughput', { kind: 'belt_lane', unit_number: 55, lane_index: 1, utilization_limit: 0 }))
  assert.throws(() => toolCommand('measureTransportThroughput', { kind: 'belt_lane', unit_number: 55, lane_index: 1, extra: true }))
})
