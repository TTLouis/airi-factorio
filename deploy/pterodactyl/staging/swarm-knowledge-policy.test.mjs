import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'
const toolNames = new Set(toolDefinitions.map(tool => tool.function.name))
for (const name of ['getRecipeDetails','getPrototypeDetails','findLongRangeEntities','findNearestEnemy','getEntityGeometry','getLogisticsTopology']) {
  test(`swarm exposes deterministic read-only tool ${name}`, () => assert.equal(toolNames.has(name), true))
}
test('knowledge tools route only to read-only Autorio interfaces', () => {
  assert.match(toolCommand('getRecipeDetails',{item_or_recipe:'advanced-oil-processing'}),/autorio_knowledge.*recipe_details/)
  assert.match(toolCommand('getPrototypeDetails',{name:'inserter'}),/autorio_prototypes.*details/)
  assert.match(toolCommand('findLongRangeEntities',{name:'iron-ore',max_radius:2048,limit:4}),/autorio_discovery.*find_entities/)
  assert.match(toolCommand('findNearestEnemy',{max_distance:512}),/autorio_discovery.*find_nearest_enemy/)
  assert.match(toolCommand('getEntityGeometry',{unit_number:42}),/autorio_knowledge.*entity_geometry/)
  assert.match(toolCommand('getLogisticsTopology',{unit_number:42,radius:8}),/autorio_knowledge.*logistics_topology/)
})
test('knowledge tools preserve bounded argument validation', () => {
  assert.throws(()=>toolCommand('findLongRangeEntities',{name:'iron-ore',max_radius:8192}),/max_radius/)
  assert.throws(()=>toolCommand('getLogisticsTopology',{unit_number:42,radius:99}),/radius/)
  assert.throws(()=>toolCommand('getEntityGeometry',{unit_number:0}),/unit_number/)
})
