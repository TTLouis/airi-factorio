import test from 'node:test'
import assert from 'node:assert/strict'

import { parseOperation, toolCommand } from './structured-policy.mjs'

test('unknown tool diagnostics include the rejected tool name', () => {
  assert.throws(() => toolCommand('getMapTiles', {}), /Unapproved tool: getMapTiles/)
})

test('unknown operation diagnostics include the rejected operation name', () => {
  assert.throws(() => parseOperation({ name: 'teleport_to_water', args: {} }), /Unapproved operation: teleport_to_water/)
})
