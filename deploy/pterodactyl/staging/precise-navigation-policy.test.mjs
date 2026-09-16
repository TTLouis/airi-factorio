import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOperation, renderOperation } from './structured-policy.mjs'

test('staging policy accepts exact entity and coordinate navigation', () => {
  assert.deepEqual(parseOperation({
    name: 'walk_to_entity_exact',
    args: { unit_number: 77, reach_distance: 1.25 },
  }), {
    name: 'walk_to_entity_exact',
    args: { unit_number: 77, reach_distance: 1.25 },
  })

  assert.equal(
    renderOperation({ name: 'walk_to_position', args: { x: 24, y: 47 } }),
    "remote.call('autorio_operations','walk_to_position',24,47,0.75)",
  )
})

test('staging policy now matches the already exposed precise mining and orientation primitives', () => {
  assert.equal(
    renderOperation({ name: 'mine_entity_exact', args: { unit_number: 91 } }),
    "remote.call('autorio_operations','mine_entity_exact',91)",
  )
  assert.equal(
    renderOperation({ name: 'mine_resource_at', args: { resource_name: 'coal', x: 10.5, y: -3.5, count: 2 } }),
    "remote.call('autorio_operations','mine_resource_at','coal',10.5,-3.5,2)",
  )
  assert.equal(
    renderOperation({ name: 'rotate_entity', args: { unit_number: 92 } }),
    "remote.call('autorio_operations','rotate_entity',92,false)",
  )
})

test('precise navigation rejects unsafe identities and coordinates', () => {
  assert.throws(() => parseOperation({ name: 'walk_to_entity_exact', args: { unit_number: 0 } }))
  assert.throws(() => parseOperation({ name: 'walk_to_position', args: { x: 1000001, y: 0 } }))
  assert.throws(() => parseOperation({ name: 'walk_to_position', args: { x: 0, y: 0, reach_distance: 0.1 } }))
})
