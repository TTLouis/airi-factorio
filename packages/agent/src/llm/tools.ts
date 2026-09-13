import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'

const logger = createLogg('tools').useGlobalConfig()

interface ToolFunction {
  name: string
  description: string
  schema: z.Schema
  fn: (args: any) => Promise<any>
}

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
    description: 'Get AIRI\'s current Autorio task state, queue state, and controlled actor snapshot',
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
      item: z.string().describe('The item to get the recipe for'),
    }),
    fn: async ({ parameters }) => {
      logger.withFields(parameters).debug('Try to get recipe for item')

      const response = await v2FactorioConsoleCommandRawPost({ body: { input: `/c remote.call("autorio_tools", "get_recipe", "${parameters.item}")` } })
      logger.withFields({ response: response.data.output }).debug('Recipe')
      return response.data.output
    },
  },
]
