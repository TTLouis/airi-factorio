import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'
import { factorioNameSchema, renderLuaString } from './operations'

const logger = createLogg('transport-capacity-tool').useGlobalConfig()
const boundedRate = z.number().positive().max(1_000_000_000)

const beltCapacitySchema = z.object({
  kind: z.literal('belt'),
  prototype_name: factorioNameSchema,
  scope: z.enum(['lane', 'belt']).optional(),
  required_rate_per_second: boundedRate.optional(),
}).strict()

const inserterCapacitySchema = z.object({
  kind: z.literal('inserter'),
  prototype_name: factorioNameSchema,
  item_name: factorioNameSchema.optional(),
}).strict()

const inserterInstanceCapacitySchema = z.object({
  kind: z.literal('inserter_instance'),
  unit_number: z.number().int().positive(),
}).strict()

export const transportCapacitySchema = z.discriminatedUnion('kind', [
  beltCapacitySchema,
  inserterCapacitySchema,
  inserterInstanceCapacitySchema,
])

export function renderTransportCapacityRequest(raw: unknown) {
  const request = transportCapacitySchema.parse(raw)
  if (request.kind === 'inserter_instance') {
    return `{kind='inserter_instance',unit_number=${request.unit_number}}`
  }

  const fields = [
    `kind=${renderLuaString(request.kind)}`,
    `prototype_name=${renderLuaString(request.prototype_name)}`,
  ]
  if (request.kind === 'belt') {
    if (request.scope !== undefined) fields.push(`scope=${renderLuaString(request.scope)}`)
    if (request.required_rate_per_second !== undefined) fields.push(`required_rate_per_second=${request.required_rate_per_second}`)
  }
  else if (request.item_name !== undefined) {
    fields.push(`item_name=${renderLuaString(request.item_name)}`)
  }
  return `{${fields.join(',')}}`
}

export const getTransportCapacityTool = {
  name: 'getTransportCapacity',
  description: 'Read deterministic live transport-capacity facts. For belts, validates one lane or a whole belt against live prototype speed and force belt-stack research. Stacked capacity is only a belt transport ceiling and does not prove upstream stack creation. For inserter prototypes, returns hand/research/movement facts. For an observed placed inserter, use kind inserter_instance with its exact unit_number to read current target pickup count, override, lane permissions, and actual pickup/drop targets. Inserter transfer_rate remains unvalidated: never infer a fixed items-per-second rate from these facts.',
  schema: transportCapacitySchema,
  fn: async ({ parameters }: { parameters: unknown }) => {
    const request = transportCapacitySchema.parse(parameters)
    const rendered = renderTransportCapacityRequest(request)
    const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning", "capacity", ${rendered})))`
    const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
    logger.withFields({ output: response.data.output, kind: request.kind }).debug('Transport capacity')
    return response.data.output
  },
}
