import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  parseOperation,
  renderOperation,
  toolDefinitions,
} from './structured-policy.mjs'

const deployedPromptSource = new URL('../../../packages/agent/src/llm/prompt.md', import.meta.url)

function toolDefinition(name) {
  return toolDefinitions.find(tool => tool.function?.name === name)
}

test('deployment prompt advertised supply_entity is admitted by runtime-v8 policy', () => {
  const prompt = readFileSync(deployedPromptSource, 'utf8')
  assert.match(prompt, /^- supply_entity$/m)
  assert.match(prompt, /prefer `supply_entity` over several separate `move_items_exact` operations/)

  const operation = {
    name: 'supply_entity',
    args: {
      unit_number: 744,
      items: [
        { item_name: 'coal', count: 10 },
        { item_name: 'iron-ore', count: 20 },
      ],
    },
  }

  assert.deepEqual(parseOperation(operation), operation)
  const rendered = renderOperation(operation)
  assert.match(rendered, /remote\.call\('autorio_operations','supply_entity',744/)
  assert.match(rendered, /\{item_name='coal',count=10\}/)
})

test('semantic placement tool advertises candidate-id execution that runtime-v8 admits', () => {
  const tool = toolDefinition('getPlacementCandidates')
  assert.ok(tool)
  assert.match(tool.function.description, /place_candidate/)

  const operation = {
    name: 'place_candidate',
    args: {
      candidate_set_id: 'placement-12',
      candidate_id: 'candidate-4',
    },
  }

  assert.deepEqual(parseOperation(operation), operation)
  assert.equal(
    renderOperation(operation),
    "remote.call('autorio_operations','place_candidate','placement-12','candidate-4')",
  )
})
