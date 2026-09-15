import test from 'node:test'
import assert from 'node:assert/strict'

import { parseOperation, renderOperation } from '../staging/structured-policy.mjs'
import { verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'

test('gather_resource is a bounded approved operation with deterministic defaults', () => {
  const operation = parseOperation({
    name: 'gather_resource',
    args: { resource_name: 'iron-ore', count: 20 },
  })

  assert.deepEqual(operation, {
    name: 'gather_resource',
    args: { resource_name: 'iron-ore', count: 20, search_radius: 256 },
  })
  assert.equal(
    renderOperation(operation),
    "remote.call('autorio_operations','gather_resource','iron-ore',20,256)",
  )
})

test('gather_resource rejects unbounded search radii', () => {
  assert.throws(() => parseOperation({
    name: 'gather_resource',
    args: { resource_name: 'iron-ore', count: 20, search_radius: 4097 },
  }))
})

test('completed gather_resource receipt proves its two internal tasks as one composite operation', () => {
  const state = {
    last_operations: [
      'gather_resource {"resource_name":"iron-ore","count":20,"search_radius":256}',
    ],
  }
  const evidence = {
    kind: 'operation_receipt',
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 7,
      task_count: 2,
      task_types: ['walking_to_entity', 'mining'],
    }),
  }

  assert.deepEqual(verifyDeterministicReceipt(state, evidence), {
    verified: true,
    batchId: 7,
    taskTypes: ['walking_to_entity', 'mining'],
    operationNames: ['gather_resource'],
  })
})
