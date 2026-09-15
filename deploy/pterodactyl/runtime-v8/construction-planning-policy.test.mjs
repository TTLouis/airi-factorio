import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('Pterodactyl exposes bounded local spatial observation and placement planning tools', () => {
  const spatial = toolDefinitions.find(tool => tool.function.name === 'getLocalSpatialObservation')
  const placement = toolDefinitions.find(tool => tool.function.name === 'planPlacement')
  assert.ok(spatial)
  assert.ok(placement)
  assert.equal(spatial.function.parameters.properties.half_size.maximum, 16)
  assert.equal(placement.function.parameters.properties.search_radius.maximum, 12)
  assert.equal(placement.function.parameters.properties.max_candidates.maximum, 8)
})

test('spatial observation renderer validates anchors and remains read-only', () => {
  assert.equal(toolCommand('getLocalSpatialObservation', {
    position: { x: 10.5, y: -2.5 },
    half_size: 12,
    requested_entity_name: 'assembling-machine-2',
  }), "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\",\"spatial_observation\",{position={x=10.5,y=-2.5},half_size=12,requested_entity_name='assembling-machine-2'})))")
  assert.throws(() => toolCommand('getLocalSpatialObservation', { anchor_unit_number: 4, position: { x: 0, y: 0 } }))
  assert.throws(() => toolCommand('getLocalSpatialObservation', { half_size: 17 }))
})

test('placement planner accepts high-level corridor intent and rejects injection/extras', () => {
  const command = toolCommand('planPlacement', {
    entity_name: 'assembling-machine-2',
    anchor_unit_number: 99,
    side: 'east',
    direction: 4,
    search_radius: 8,
    max_candidates: 4,
    reserve_input: true,
    reserve_output: true,
    reserve_power: true,
    extension_direction: 'east',
  })
  assert.match(command, /remote\.call\("autorio_planning","plan_placement"/)
  assert.match(command, /reserve_input=true/)
  assert.match(command, /extension_direction='east'/)
  assert.throws(() => toolCommand('planPlacement', { entity_name: 'assembling-machine-2\n/c game.clear()' }))
  assert.throws(() => toolCommand('planPlacement', { entity_name: 'assembling-machine-2', lua: 'game.clear()' }))
  assert.throws(() => toolCommand('planPlacement', { entity_name: 'assembling-machine-2', side: 'diagonal' }))
})
