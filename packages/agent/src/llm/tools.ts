import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'
import { factorioNameSchema, renderLuaString } from './operations'

const logger = createLogg('tools').useGlobalConfig()

interface ToolFunction {
  name: string
  description: string
  schema: z.Schema
  fn: (args: any) => Promise<any>
}

const nearbyEntitiesSchema = z.object({
  radius: z.number().int().min(1).max(64).default(20),
  name: factorioNameSchema.optional(),
  type: factorioNameSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()

const longRangeEntitiesSchema = z.object({
  name: factorioNameSchema,
  max_radius: z.number().int().min(64).max(4096).default(1024),
  limit: z.number().int().min(1).max(16).default(8),
}).strict()

const nearestEnemySchema = z.object({
  max_distance: z.number().int().min(1).max(4096).default(1024),
}).strict()

const entityStatusSchema = z.object({
  name: factorioNameSchema,
  radius: z.number().int().min(1).max(32).default(8),
}).strict()

const entityGeometrySchema = z.object({
  unit_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict()

const playerStatusSchema = z.object({
  player_name: factorioNameSchema,
}).strict()

const recipeDetailsSchema = z.object({
  item_or_recipe: factorioNameSchema,
}).strict()

async function readRemoteStatus(interfaceName: 'autorio_actor' | 'autorio_operations' | 'autorio_navigation' | 'autorio_crafting' | 'autorio_research' | 'autorio_combat' | 'autorio_follow' | 'autorio_defense' | 'autorio_equipment') {
  const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("${interfaceName}", "status")))`
  const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
  return response.data.output
}

const technologySchema = z.object({ name: factorioNameSchema }).strict()

export const tools: ToolFunction[] = [
  {
    name: 'getActorStatus',
    description: 'Get AIRI\'s controlled actor mode, identity, position, validity, and connected-human count',
    schema: z.object({}),
    fn: async () => {
      const output = await readRemoteStatus('autorio_actor')
      logger.withFields({ output }).debug('Actor status')
      return output
    },
  },
  {
    name: 'getTaskStatus',
    description: 'Get AIRI\'s current Autorio task state, bounded queue/progress state, and controlled actor snapshot',
    schema: z.object({}),
    fn: async () => {
      const output = await readRemoteStatus('autorio_operations')
      logger.withFields({ output }).debug('Task status')
      return output
    },
  },
  {
    name: 'getInventoryItems',
    description: 'Get the items in AIRI\'s controlled actor main inventory. Equipment slots are separate; use getEquipmentStatus for guns, ammo, armor, selected gun slot, health, and cursor stack.',
    schema: z.object({}),
    fn: async () => {
      const response = await v2FactorioConsoleCommandRawPost({ body: { input: '/c remote.call("autorio_tools", "get_inventory_items")' } })
      logger.withFields({ response: response.data.output }).debug('Inventory items')
      return response.data.output
    },
  },
  {
    name: 'getEquipmentStatus',
    description: 'Inspect AIRI health and equipment state: selected gun slot, equipped guns, matching ammo slots, armor, and cursor stack. Use this before combat instead of inferring equipment from the main inventory.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_equipment'),
  },
  {
    name: 'getRecipe',
    description: 'Get the recipe for a given item for AIRI\'s controlled actor',
    schema: z.object({
      item: factorioNameSchema.describe('The item to get the recipe for'),
    }).strict(),
    fn: async ({ parameters }) => {
      const item = factorioNameSchema.parse(parameters.item)
      logger.withFields({ item }).debug('Try to get recipe for item')

      const response = await v2FactorioConsoleCommandRawPost({
        body: {
          input: `/c remote.call("autorio_tools", "get_recipe", ${renderLuaString(item)})`,
        },
      })
      logger.withFields({ response: response.data.output }).debug('Recipe')
      return response.data.output
    },
  },
  {
    name: 'getRecipeDetails',
    description: 'Get bounded deterministic recipe knowledge for an item/fluid or recipe name, including categories, craft time, ingredients/products, hand-crafting category compatibility, and compatible crafting-machine prototypes.',
    schema: recipeDetailsSchema,
    fn: async ({ parameters }) => {
      const parsed = recipeDetailsSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "recipe_details", ${renderLuaString(parsed.item_or_recipe)})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Detailed recipe knowledge')
      return response.data.output
    },
  },
  {
    name: 'getPlayerStatus',
    description: 'Inspect one exact human player by name: connection/character availability, surface, position, and distance from AIRI when comparable.',
    schema: playerStatusSchema,
    fn: async ({ parameters }) => {
      const parsed = playerStatusSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_player_status", ${renderLuaString(parsed.player_name)})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Player status')
      return response.data.output
    },
  },
  {
    name: 'getNearbyEntities',
    description: 'Inspect a bounded area around AIRI and return compact nearby entity summaries. Use optional exact prototype name/type filters to reduce noise.',
    schema: nearbyEntitiesSchema,
    fn: async ({ parameters }) => {
      const parsed = nearbyEntitiesSchema.parse(parameters ?? {})
      const name = parsed.name ? renderLuaString(parsed.name) : 'nil'
      const entityType = parsed.type ? renderLuaString(parsed.type) : 'nil'
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_nearby_entities", ${parsed.radius}, ${name}, ${entityType}, ${parsed.limit})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Nearby entities')
      return response.data.output
    },
  },
  {
    name: 'findLongRangeEntities',
    description: 'Search outward in bounded rings for an exact Factorio prototype name, up to 4096 tiles, returning only a small number of matching distant targets. Use this for resource/world discovery, not broad local inspection.',
    schema: longRangeEntitiesSchema,
    fn: async ({ parameters }) => {
      const parsed = longRangeEntitiesSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_entities", ${renderLuaString(parsed.name)}, ${parsed.max_radius}, ${parsed.limit})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Long-range entities')
      return response.data.output
    },
  },
  {
    name: 'findNearestEnemy',
    description: 'Use Factorio native nearest-enemy search to discover the closest hostile entity without knowing its prototype name, up to 4096 tiles. Use this when hunting/clearing enemies after the local 64-tile area is empty.',
    schema: nearestEnemySchema,
    fn: async ({ parameters }) => {
      const parsed = nearestEnemySchema.parse(parameters ?? {})
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_nearest_enemy", ${parsed.max_distance})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Nearest hostile')
      return response.data.output
    },
  },
  {
    name: 'getEntityStatus',
    description: 'Inspect the nearest local entity with an exact prototype name and return bounded inventory summaries. Use this to verify placed chests and nearby machines without dumping the map.',
    schema: entityStatusSchema,
    fn: async ({ parameters }) => {
      const parsed = entityStatusSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_entity_status", ${renderLuaString(parsed.name)}, ${parsed.radius})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Entity status')
      return response.data.output
    },
  },
  {
    name: 'getEntityGeometry',
    description: 'Inspect one exact same-surface entity by Factorio unit_number and return bounded runtime I/O geometry: inserter pickup/drop positions and targets, mining-drill output position/target, and fluidbox production roles and absolute pipe connection positions/targets.',
    schema: entityGeometrySchema,
    fn: async ({ parameters }) => {
      const parsed = entityGeometrySchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "entity_geometry", ${parsed.unit_number})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Exact entity geometry')
      return response.data.output
    },
  },
  {
    name: 'getNavigationStatus',
    description: 'Read AIRI navigation state, bound target, active path request/attempt count, and last bounded navigation result. Use it to distinguish reached from no-target, unreachable, path timeout, stuck, or ownership failures.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_navigation'),
  },
  {
    name: 'getFollowStatus',
    description: 'Read AIRI persistent player-follow state, target player, configured distance, current distance, and whether follow movement is active, waiting for player availability, or blocked by surface mismatch.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_follow'),
  },
  {
    name: 'getDefenseStatus',
    description: 'Read AIRI persistent follow auto-defense policy, defensive radius, and any current nearby hostile target. Auto-defense may shoot while following but does not chase.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_defense'),
  },
  {
    name: 'getCraftingStatus',
    description: 'Read AIRI native hand-crafting state and last bounded crafting result. Use it to distinguish verified output completion from a busy native queue, missing ingredients/output, cancellation, timeout, or ownership failure.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_crafting'),
  },
  {
    name: 'getResearchStatus',
    description: 'Read current force research, progress, a bounded queue, and the last research-request result. A request being accepted is not technology completion.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_research'),
  },
  {
    name: 'getTechnology',
    description: 'Inspect one exact technology: researched state, level, prerequisites, science requirements, and whether it is actually researched.',
    schema: technologySchema,
    fn: async ({ parameters }) => {
      const { name } = technologySchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "technology", ${renderLuaString(name)})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      return response.data.output
    },
  },
  {
    name: 'getCombatStatus',
    description: 'Read AIRI combat state, the currently bound target when valid, and the last bounded combat result. Use it to distinguish a destroyed target from no-target, no-ammo, stuck, timeout, or ownership failures.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_combat'),
  },
]
