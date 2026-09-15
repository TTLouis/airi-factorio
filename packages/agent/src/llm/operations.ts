import { z } from 'zod'

export const factorioNameSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Factorio names cannot contain control characters')

const transferCount = z.number().int().min(1).max(100000)
const unitNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const boundedTaskCount = z.number().int().min(1).max(1000)
const searchRadius = z.number().int().min(1).max(4096)
const combatSearchRadius = z.number().int().min(1).max(256)
const followDistance = z.number().min(1).max(64).default(4)
const equipmentSlot = z.number().int().min(1).max(64)
const placementCoordinate = z.number().min(-1000000).max(1000000)
const placementDirection = z.number().int().min(0).max(15)
const placementArgs = z.object({
  entity_name: factorioNameSchema,
  x: placementCoordinate.optional(),
  y: placementCoordinate.optional(),
  direction: placementDirection.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.x === undefined) !== (value.y === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'x and y must be provided together' })
  }
})

export const structuredOperationSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('walk_to_entity'),
    args: z.object({
      entity_name: factorioNameSchema,
      search_radius: searchRadius,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('walk_to_player'),
    args: z.object({
      player_name: factorioNameSchema,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('follow_player'),
    args: z.object({
      player_name: factorioNameSchema,
      follow_distance: followDistance,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('stop_follow_player'),
    args: z.object({}).strict(),
  }).strict(),
  z.object({
    name: z.literal('set_auto_defense'),
    args: z.object({
      enabled: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('equip_weapon'),
    args: z.object({
      item_name: factorioNameSchema,
      slot: equipmentSlot.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('equip_ammo'),
    args: z.object({
      item_name: factorioNameSchema,
      slot: equipmentSlot.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('equip_armor'),
    args: z.object({
      item_name: factorioNameSchema,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('select_weapon_slot'),
    args: z.object({
      slot: equipmentSlot,
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('mine_entity'),
    args: z.object({
      entity_name: factorioNameSchema,
      count: boundedTaskCount.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('place_entity'),
    args: placementArgs,
  }).strict(),
  z.object({
    name: z.literal('move_items'),
    args: z.object({
      item_name: factorioNameSchema,
      entity_name: factorioNameSchema,
      max_count: transferCount,
      to_entity: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('move_items_exact'),
    args: z.object({
      item_name: factorioNameSchema,
      unit_number: unitNumber,
      max_count: transferCount,
      to_entity: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('move_items_with_player'),
    args: z.object({
      item_name: factorioNameSchema,
      player_name: factorioNameSchema,
      max_count: transferCount,
      to_player: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('craft_item'),
    args: z.object({
      item_name: factorioNameSchema,
      count: boundedTaskCount.default(1),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('attack_nearest_enemy'),
    args: z.object({
      search_radius: combatSearchRadius.default(50),
    }).strict(),
  }).strict(),
  z.object({
    name: z.literal('clear_enemy_area'),
    args: z.object({
      search_radius: combatSearchRadius.default(96),
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

const quotedSafeName = `['"][A-Za-z0-9_.:/-]+['"]`
const positiveInteger = `[1-9][0-9]*`
const separator = `\\s*,\\s*`
const callStart = `^remote\\.call\\(\\s*['"]autorio_operations['"]${separator}`
const callEnd = `\\s*\\)$`

const legacyOperationPatterns = [
  new RegExp(`${callStart}['"]walk_to_entity['"]${separator}${quotedSafeName}${separator}${positiveInteger}${callEnd}`),
  new RegExp(`${callStart}['"]walk_to_player['"]${separator}${quotedSafeName}${callEnd}`),
  new RegExp(`${callStart}['"]follow_player['"]${separator}${quotedSafeName}${separator}${positiveInteger}${callEnd}`),
  new RegExp(`${callStart}['"]stop_follow_player['"]${callEnd}`),
  new RegExp(`${callStart}['"]set_auto_defense['"]${separator}(?:true|false)${callEnd}`),
  new RegExp(`${callStart}['"]equip_weapon['"]${separator}${quotedSafeName}${separator}${positiveInteger}${callEnd}`),
  new RegExp(`${callStart}['"]equip_ammo['"]${separator}${quotedSafeName}${separator}${positiveInteger}${callEnd}`),
  new RegExp(`${callStart}['"]equip_armor['"]${separator}${quotedSafeName}${callEnd}`),
  new RegExp(`${callStart}['"]select_weapon_slot['"]${separator}${positiveInteger}${callEnd}`),
  new RegExp(`${callStart}['"]mine_entity['"]${separator}${quotedSafeName}(?:${separator}${positiveInteger})?${callEnd}`),
  new RegExp(`${callStart}['"]place_entity['"]${separator}${quotedSafeName}${callEnd}`),
  new RegExp(`${callStart}['"]move_items['"]${separator}${quotedSafeName}${separator}${quotedSafeName}${separator}${positiveInteger}${separator}(?:true|false)${callEnd}`),
  new RegExp(`${callStart}['"]move_items_exact['"]${separator}${quotedSafeName}${separator}${positiveInteger}${separator}${positiveInteger}${separator}(?:true|false)${callEnd}`),
  new RegExp(`${callStart}['"]move_items_with_player['"]${separator}${quotedSafeName}${separator}${quotedSafeName}${separator}${positiveInteger}${separator}(?:true|false)${callEnd}`),
  new RegExp(`${callStart}['"]craft_item['"]${separator}${quotedSafeName}(?:${separator}${positiveInteger})?${callEnd}`),
  new RegExp(`${callStart}['"]attack_nearest_enemy['"](?:${separator}${positiveInteger})?${callEnd}`),
  new RegExp(`${callStart}['"]clear_enemy_area['"](?:${separator}${positiveInteger})?${callEnd}`),
  new RegExp(`${callStart}['"]research_technology['"]${separator}${quotedSafeName}${callEnd}`),
  new RegExp(`${callStart}['"]wait['"]${separator}${positiveInteger}${callEnd}`),
]

export function isLegacyOperationCommand(value: string): boolean {
  return legacyOperationPatterns.some(pattern => pattern.test(value))
}

export const legacyOperationCommandSchema = z.string()
  .max(1000)
  .refine(isLegacyOperationCommand, 'Legacy operation command is not an approved Autorio call')

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
    case 'walk_to_player':
      return `remote.call('autorio_operations', 'walk_to_player', ${renderLuaString(operation.args.player_name)})`
    case 'follow_player':
      return `remote.call('autorio_operations', 'follow_player', ${renderLuaString(operation.args.player_name)}, ${operation.args.follow_distance})`
    case 'stop_follow_player':
      return `remote.call('autorio_operations', 'stop_follow_player')`
    case 'set_auto_defense':
      return `remote.call('autorio_operations', 'set_auto_defense', ${operation.args.enabled})`
    case 'equip_weapon':
      return `remote.call('autorio_operations', 'equip_weapon', ${renderLuaString(operation.args.item_name)}, ${operation.args.slot})`
    case 'equip_ammo':
      return `remote.call('autorio_operations', 'equip_ammo', ${renderLuaString(operation.args.item_name)}, ${operation.args.slot})`
    case 'equip_armor':
      return `remote.call('autorio_operations', 'equip_armor', ${renderLuaString(operation.args.item_name)})`
    case 'select_weapon_slot':
      return `remote.call('autorio_operations', 'select_weapon_slot', ${operation.args.slot})`
    case 'mine_entity':
      return `remote.call('autorio_operations', 'mine_entity', ${renderLuaString(operation.args.entity_name)}, ${operation.args.count})`
    case 'place_entity': {
      const name = renderLuaString(operation.args.entity_name)
      if (operation.args.x !== undefined && operation.args.y !== undefined) {
        const direction = operation.args.direction === undefined ? 'nil' : String(operation.args.direction)
        return `remote.call('autorio_operations', 'place_entity', ${name}, ${operation.args.x}, ${operation.args.y}, ${direction})`
      }
      if (operation.args.direction !== undefined) {
        return `remote.call('autorio_operations', 'place_entity', ${name}, nil, nil, ${operation.args.direction})`
      }
      return `remote.call('autorio_operations', 'place_entity', ${name})`
    }
    case 'move_items':
      return `remote.call('autorio_operations', 'move_items', ${renderLuaString(operation.args.item_name)}, ${renderLuaString(operation.args.entity_name)}, ${operation.args.max_count}, ${operation.args.to_entity})`
    case 'move_items_exact':
      return `remote.call('autorio_operations', 'move_items_exact', ${renderLuaString(operation.args.item_name)}, ${operation.args.unit_number}, ${operation.args.max_count}, ${operation.args.to_entity})`
    case 'move_items_with_player':
      return `remote.call('autorio_operations', 'move_items_with_player', ${renderLuaString(operation.args.item_name)}, ${renderLuaString(operation.args.player_name)}, ${operation.args.max_count}, ${operation.args.to_player})`
    case 'craft_item':
      return `remote.call('autorio_operations', 'craft_item', ${renderLuaString(operation.args.item_name)}, ${operation.args.count})`
    case 'attack_nearest_enemy':
      return `remote.call('autorio_operations', 'attack_nearest_enemy', ${operation.args.search_radius})`
    case 'clear_enemy_area':
      return `remote.call('autorio_operations', 'clear_enemy_area', ${operation.args.search_radius})`
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
