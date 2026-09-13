import { z } from 'zod'

export const factorioNameSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Factorio names cannot contain control characters')

const positiveCount = z.number().int().min(1).max(100000)
const searchRadius = z.number().int().min(1).max(1024)

export const structuredOperationSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('walk_to_entity'),
    args: z.object({
      entity_name: factorioNameSchema,
      search_radius: searchRadius,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('mine_entity'),
    args: z.object({
      entity_name: factorioNameSchema,
      count: positiveCount.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('place_entity'),
    args: z.object({
      entity_name: factorioNameSchema,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('move_items'),
    args: z.object({
      item_name: factorioNameSchema,
      entity_name: factorioNameSchema,
      max_count: positiveCount,
      to_entity: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('craft_item'),
    args: z.object({
      item_name: factorioNameSchema,
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
      technology_name: factorioNameSchema,
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

export function renderLuaString(value: string): string {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}'`
}

export function renderStructuredOperation(operation: StructuredOperation): string {
  switch (operation.name) {
    case 'walk_to_entity':
      return `remote.call('autorio_operations', 'walk_to_entity', ${renderLuaString(operation.args.entity_name)}, ${operation.args.search_radius})`
    case 'mine_entity':
      return `remote.call('autorio_operations', 'mine_entity', ${renderLuaString(operation.args.entity_name)}, ${operation.args.count})`
    case 'place_entity':
      return `remote.call('autorio_operations', 'place_entity', ${renderLuaString(operation.args.entity_name)})`
    case 'move_items':
      return `remote.call('autorio_operations', 'move_items', ${renderLuaString(operation.args.item_name)}, ${renderLuaString(operation.args.entity_name)}, ${operation.args.max_count}, ${operation.args.to_entity})`
    case 'craft_item':
      return `remote.call('autorio_operations', 'craft_item', ${renderLuaString(operation.args.item_name)}, ${operation.args.count})`
    case 'attack_nearest_enemy':
      return `remote.call('autorio_operations', 'attack_nearest_enemy', ${operation.args.search_radius})`
    case 'research_technology':
      return `remote.call('autorio_operations', 'research_technology', ${renderLuaString(operation.args.technology_name)})`
    case 'wait':
      return `remote.call('autorio_operations', 'wait', ${operation.args.ticks})`
  }

  throw new Error('Unsupported structured operation')
}

export function renderStructuredOperations(value: unknown): string[] {
  return parseStructuredOperations(value).map(renderStructuredOperation)
}
