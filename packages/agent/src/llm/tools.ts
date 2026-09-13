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

async function readRemoteStatus(interfaceName: 'autorio_actor' | 'autorio_operations') {
  const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("${interfaceName}", "status")))`
  const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
  return response.data.output
}

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
    description: 'Get the items in AIRI\'s controlled actor inventory',
    schema: z.object({}),
    fn: async () => {
      const response = await v2FactorioConsoleCommandRawPost({ body: { input: '/c remote.call("autorio_tools", "get_inventory_items")' } })
      logger.withFields({ response: response.data.output }).debug('Inventory items')
      return response.data.output
    },
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
]
