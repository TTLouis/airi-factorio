import type { LuaEntity } from 'factorio:runtime'

const MAX_FLUID_STORAGES = 8
const MAX_PIPE_CONNECTIONS_PER_STORAGE = 8

function entity_identity(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid) return undefined
  return {
    name: entity.name,
    type: entity.type,
    unit_number: entity.unit_number,
    position: entity.position,
  }
}

function compact_fluidbox_prototype(value: any) {
  if (!value) return []
  const values: any[] = value.production_type ? [value] : value
  const result: Array<Record<string, unknown>> = []
  for (const prototype of values) {
    const summary: Record<string, unknown> = {
      index: prototype.index,
      production_type: prototype.production_type,
    }
    if (prototype.filter?.name !== undefined) summary.filter = prototype.filter.name
    if (prototype.minimum_temperature !== undefined) summary.minimum_temperature = prototype.minimum_temperature
    if (prototype.maximum_temperature !== undefined) summary.maximum_temperature = prototype.maximum_temperature
    result.push(summary)
  }
  return result
}

function compact_fluid_ports(entity: LuaEntity) {
  const fluidbox = entity.fluidbox
  const count = math.min(fluidbox.length, MAX_FLUID_STORAGES)
  if (count <= 0) return undefined

  const storages: Array<Record<string, unknown>> = []
  for (let index = 1; index <= count; index++) {
    const raw_connections = fluidbox.get_pipe_connections(index) ?? []
    const connection_count = math.min(raw_connections.length, MAX_PIPE_CONNECTIONS_PER_STORAGE)
    const connections: Array<Record<string, unknown>> = []

    for (let connection_index = 0; connection_index < connection_count; connection_index++) {
      const connection = raw_connections[connection_index]
      const summary: Record<string, unknown> = {
        position: connection.position,
      }
      if (connection.flow_direction !== undefined) summary.flow_direction = connection.flow_direction
      if (connection.connection_type !== undefined) summary.connection_type = connection.connection_type
      if (connection.target_position !== undefined) summary.target_position = connection.target_position
      const target = entity_identity(connection.target?.owner)
      if (target !== undefined) summary.target = target
      if (connection.target_fluidbox_index !== undefined) summary.target_fluidbox_index = connection.target_fluidbox_index
      connections.push(summary)
    }

    storages.push({
      index,
      prototypes: compact_fluidbox_prototype(fluidbox.get_prototype(index)),
      connections,
      connections_truncated: raw_connections.length > connection_count,
    })
  }

  return {
    storage_count: entity.fluids_count,
    fluidbox_count: fluidbox.length,
    storages_truncated: fluidbox.length > count,
    storages,
  }
}

function compact_item_io(entity: LuaEntity) {
  if (entity.type === 'inserter') {
    return {
      pickup_position: entity.pickup_position,
      drop_position: entity.drop_position,
      pickup_target: entity_identity(entity.pickup_target),
      drop_target: entity_identity(entity.drop_target),
    }
  }

  if (entity.type === 'mining-drill') {
    return {
      drop_position: entity.drop_position,
      drop_target: entity_identity(entity.drop_target),
    }
  }

  return undefined
}

/**
 * Return only spatial semantics that the running Factorio instance actually
 * exposes for this placed entity. Keep the result compact so nearby scans can
 * include useful geometry without forcing a second LLM observation round.
 *
 * This intentionally does not encode vanilla prototype names or remembered
 * orientation rules. Geometry is read from the current LuaEntity/LuaFluidBox.
 */
export function compact_spatial_summary(entity: LuaEntity) {
  const item_io = compact_item_io(entity)
  const fluid = compact_fluid_ports(entity)
  if (item_io === undefined && fluid === undefined) return undefined

  const result: Record<string, unknown> = {}
  if (item_io !== undefined) result.item_io = item_io
  if (fluid !== undefined) result.fluid = fluid
  return result
}
