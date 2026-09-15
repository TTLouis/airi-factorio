import test from 'node:test'
import assert from 'node:assert/strict'

import { parseOperation, renderOperation } from '../staging/structured-policy.mjs'
import { verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('execute_construction_plan is a bounded operation tied to one validation id and placement count', () => {
  const operation = parseOperation({
    name: 'execute_construction_plan',
    args: { validation_id: 17, placement_count: 3 },
  })

  assert.deepEqual(operation, {
    name: 'execute_construction_plan',
    args: { validation_id: 17, placement_count: 3 },
  })
  assert.equal(
    renderOperation(operation),
    "remote.call('autorio_operations','execute_construction_plan',17,3)",
  )
  assert.throws(() => parseOperation({
    name: 'execute_construction_plan',
    args: { validation_id: 17, placement_count: 17 },
  }))
})

test('validateConstructionPlan emits one bounded live-world validation command', () => {
  const definition = toolDefinitions.find(tool => tool?.function?.name === 'validateConstructionPlan')
  assert.ok(definition)
  assert.equal(definition.function.parameters.properties.placements.maxItems, 16)

  assert.equal(
    toolCommand('validateConstructionPlan', {
      plan_id: 'starter-line',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0, direction: 0 },
        { entity_name: 'stone-furnace', x: 2, y: 0 },
      ],
    }),
    '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","validate_construction_plan",{plan_id=\'starter-line\',placements={{entity_name=\'stone-furnace\',x=-2,y=0,direction=0},{entity_name=\'stone-furnace\',x=2,y=0}}})))',
  )
})

test('completed execute_construction_plan receipt proves exactly the validated number of placement tasks', () => {
  const state = {
    last_operations: [
      'execute_construction_plan {"validation_id":17,"placement_count":3}',
    ],
  }
  const evidence = {
    kind: 'operation_receipt',
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 31,
      task_count: 3,
      task_types: ['placing', 'placing', 'placing'],
    }),
  }

  assert.deepEqual(verifyDeterministicReceipt(state, evidence), {
    verified: true,
    batchId: 31,
    taskTypes: ['placing', 'placing', 'placing'],
    operationNames: ['execute_construction_plan'],
  })

  const mismatched = {
    ...evidence,
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 32,
      task_count: 2,
      task_types: ['placing', 'placing'],
    }),
  }
  assert.deepEqual(verifyDeterministicReceipt(state, mismatched), {
    verified: false,
    reason: 'receipt_operation_mismatch',
  })
})
