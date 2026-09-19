import assert from 'node:assert/strict'
import test from 'node:test'
import { receiptEvidence } from './npc-agent-loop.mjs'

test('operation receipt evidence prefers restart-safe batch_ref and preserves identity diagnostics', () => {
  const evidence = receiptEvidence(JSON.stringify({
    task_state: 'idle',
    queue_length: 0,
    last_completed_batch: {
      batch_id: 42,
      batch_generation: 7,
      batch_ref: 'batch-g7-42',
      task_count: 2,
      task_types: ['placing', 'waiting'],
      tick: 900,
    },
  }), 'completed')

  assert.equal(evidence.ref, 'batch-g7-42')
  const summary = JSON.parse(evidence.summary)
  assert.equal(summary.batch_id, 42)
  assert.equal(summary.batch_generation, 7)
  assert.equal(summary.batch_ref, 'batch-g7-42')
})

test('operation receipt evidence keeps the legacy numeric fallback without inventing a generation', () => {
  const evidence = receiptEvidence(JSON.stringify({
    task_state: 'idle',
    queue_length: 0,
    last_completed_batch: {
      batch_id: 5,
      task_count: 1,
      task_types: ['mining'],
      tick: 901,
    },
  }), 'completed')

  assert.equal(evidence.ref, 'batch_5')
  const summary = JSON.parse(evidence.summary)
  assert.equal(summary.batch_id, 5)
  assert.equal(summary.batch_generation, undefined)
  assert.equal(summary.batch_ref, undefined)
})
