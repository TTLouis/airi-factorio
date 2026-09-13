import { z } from 'zod'

const factorioName = z.string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Factorio names cannot contain control characters')

const positiveCount = z.number().int().min(1).max(100000)
const searchRadius = z.number().int().min(1).max(1024)

export const structuredOperationSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('walk_to_entity'),
    args: z.object({
      entity_name: factorioName,
      search_radius: searchRadius,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('mine_entity'),
    args: z.object({
      entity_name: factorioName,
      count: positiveCount.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('place_entity'),
    args: z.object({
      entity_name: factorioName,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('move_items'),
    args: z.object({
      item_name: factorioName,
      entity_name: factorioName,
      max_count: positiveCount,
      to_entity: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('craft_item'),
    args: z.object({
      item_name: factorioName,
      count: positiveCount.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('attack_nearest_enemy'),
    args: z.object({
      search_radius: searchRadius.default(50),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('research_technology'),
    args: z.object({
      technology_name: factorioName,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('wait'),
    args: z.object({
      ticks: z.number().int().min(1).max(360000),
    }).strict(),
  }).strict(),
])

export const structuredOperationsSchema = z.array(structuredOperationSchema).max(16)

export type StructuredOperation = z.infer<typeof structuredOperationSchema>

export function parseStructuredOperations(value: unknown): StructuredOperation[] {
  return structuredOperationsSchema.parse(value)
}

function luaString(value: string): string {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}'`
}

export function renderStructuredOperation(operation: StructuredOperation): string {
  switch (operation.name) {
    case 'walk_to_entity':
      return `remote.call('autorio_operations', 'walk_to_entity', ${luaString(operation.args.entity_name)}, ${operation.args.search_radius})`
    case 'mine_entity':
      return `remote.call('autorio_operations', 'mine_entity', ${luaString(operation.args.entity_name)}, ${operation.args.count})`
    case 'place_entity':
      return `remote.call('autorio_operations', 'place_entity', ${luaString(operation.args.entity_name)})`
    case 'move_items':
      return `remote.call('autorio_operations', 'move_items', ${luaString(operation.args.item_name)}, ${luaString(operation.args.entity_name)}, ${operation.args.max_count}, ${operation.args.to_entity})`
    case 'craft_item':
      return `remote.call('autorio_operations', 'craft_item', ${luaString(operation.args.item_name)}, ${operation.args.count})`
    case 'attack_nearest_enemy':
      return `remote.call('autorio_operations', 'attack_nearest_enemy', ${operation.args.search_radius})`
    case 'research_technology':
      return `remote.call('autorio_operations', 'research_technology', ${luaString(operation.args.technology_name)})`
    case 'wait':
      return `remote.call('autorio_operations', 'wait', ${operation.args.ticks})`
  }
}

export function renderStructuredOperations(value: unknown): string[] {
  return parseStructuredOperations(value).map(renderStructuredOperation)
}
